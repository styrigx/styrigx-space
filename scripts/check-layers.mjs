#!/usr/bin/env node
/**
 * @fileoverview L0-L6 分层边界检查（SGX 3.0 架构规范）。
 *
 * 规则（违反任一条则 exit 1，CI 失败）：
 *  1. assets/js/lib/ 不得 import shell/ 或 apps/ 的模块（上层依赖）
 *  2. assets/js/shell/ 不得 import apps/ 的模块
 *  3. assets/js/ 下不得 import functions/ 的模块（前后端隔离）
 *  4. functions/api/ 只能 import functions/_kernel/ 的模块
 *  5. 前端代码（assets/）禁止出现 `sgx-verified` 字符串
 *  6. 前端代码（assets/）禁止出现 `sgx-lock-shown` 字符串
 *  7. 前端代码不得用 sessionStorage/localStorage 保存解锁状态
 *     （key 匹配：unlock、sgx-lock、session；storage.js 的偏好设置除外——
 *      白名单：theme、weather 等已知偏好 key）
 *
 * 用法：node scripts/check-layers.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      // 跳过 node_modules、public（构建产物）、.git
      if (['node_modules', 'public', '.git', '.hugo_build.lock'].includes(e)) continue;
      walk(p, out);
    } else if (p.endsWith('.js') || p.endsWith('.mjs') || p.endsWith('.cjs')) {
      out.push(p);
    }
  }
  return out;
}

function rel(p) { return relative(ROOT, p); }

// 解析 import/from 路径（静态 import + 动态 import()）
function importsOf(src) {
  const out = [];
  const re = /(?:import\s+(?:[^'"]*?\s+from\s+)?|import\()\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

// 把相对 import 解析为目标文件的层目录名（lib/shell/apps/_kernel/api/unknown）
function resolveLayer(fromFile, spec) {
  if (!spec.startsWith('.')) return 'external';
  const fromDir = dirname(fromFile);
  // 简化：只处理 ./x.js 和 ../dir/x.js 形式
  const parts = spec.split('/');
  const base = parts[parts.length - 1].replace(/\.js$/, '');
  if (parts[1] === 'lib' || (parts.length === 2 && fromFile.includes('/assets/js/lib/'))) {
    // ./x.js：看 fromFile 所在目录
    if (fromFile.includes('/assets/js/lib/')) return 'lib';
    if (fromFile.includes('/assets/js/shell/')) {
      return ['events','features','i18n','scheduler','sgx','storage','theme','toast','util','vt'].includes(base) ? 'lib' : 'shell';
    }
    if (fromFile.includes('/assets/js/apps/')) {
      if (['events','features','i18n','scheduler','sgx','storage','theme','toast','util','vt'].includes(base)) return 'lib';
      if (['appvis','capsule','core','engines','fav','goodlock','layout','lock','nav','navhistory','scrollfx','sheet','subhead','vk','voice-sheet','voice'].includes(base)) return 'shell';
      return 'apps';
    }
    return 'unknown';
  }
  if (spec.includes('/lib/')) return 'lib';
  if (spec.includes('/shell/')) return 'shell';
  if (spec.includes('/apps/')) return 'apps';
  if (spec.includes('/_kernel/')) return '_kernel';
  if (spec.includes('/_lib/')) return '_lib-legacy';
  if (spec.includes('/api/')) return 'api';
  if (spec.includes('/functions/')) return 'functions';
  return 'unknown';
}

const LIB_FILES = new Set(['events','features','i18n','scheduler','sgx','storage','theme','toast','util','vt']);

function stripComments(src) {
  // 去掉块注释和行注释（简化版，够用）
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function checkFile(p) {
  const src = readFileSync(p, 'utf8');
  const code = stripComments(src); // 规则 5/6 只查代码，不查注释
  const r = rel(p);
  const isFrontend = r.startsWith('assets/js/');
  const inLib = r.startsWith('assets/js/lib/');
  const inShell = r.startsWith('assets/js/shell/');
  const inApi = r.startsWith('functions/api/');

  for (const spec of importsOf(src)) {
    const target = resolveLayer(p, spec);
    // 规则 1：lib 不得 import shell/apps
    if (inLib && (target === 'shell' || target === 'apps')) {
      errors.push(`${r}: lib/ 禁止 import ${target}/ (${spec})`);
    }
    // 规则 2：shell 不得 import apps
    if (inShell && target === 'apps') {
      errors.push(`${r}: shell/ 禁止 import apps/ (${spec})`);
    }
    // 规则 3：assets/ 不得 import functions/
    if (isFrontend && (target === 'functions' || target === '_kernel' || target === 'api' || target === '_lib-legacy')) {
      errors.push(`${r}: 前端禁止 import functions/ (${spec})`);
    }
    // 规则 4：api/ 只能 import _kernel/
    if (inApi && target !== '_kernel' && target !== 'external' && target !== 'unknown') {
      // 允许 import 同目录 api/ 内部？规范说"只能引用 _kernel/"，严格执行
      if (target !== 'api') {
        errors.push(`${r}: functions/api/ 只能 import _kernel/，发现 ${target}/ (${spec})`);
      }
    }
    // functions/_lib 已改名，不应再出现
    if (target === '_lib-legacy') {
      errors.push(`${r}: 引用了已改名的 _lib/，应为 _kernel/ (${spec})`);
    }
  }

  if (isFrontend) {
    // 规则 5：前端禁止 sgx-verified（只查代码，注释除外）
    if (code.includes('sgx-verified')) {
      errors.push(`${r}: 前端禁止出现 sgx-verified 字符串`);
    }
    // 规则 6：前端禁止 sgx-lock-shown（只查代码，注释除外）
    if (code.includes('sgx-lock-shown')) {
      errors.push(`${r}: 前端禁止出现 sgx-lock-shown 字符串`);
    }
    // 规则 7：前端不得用 storage 存解锁状态
    // storage.js 本身是偏好存储实现，跳过；检查其他文件的 setItem/setJSON 调用
    if (!r.endsWith('/storage.js')) {
      const unlockKeyRe = /(?:sessionStorage|localStorage)\s*\.\s*setItem\s*\(\s*['"]([^'"]*(?:unlock|sgx-lock|sgx-unlock|session)[^'"]*)['"]/gi;
      let m;
      while ((m = unlockKeyRe.exec(src))) {
        errors.push(`${r}: 前端禁止用 storage 保存解锁状态 (key: ${m[1]})`);
      }
      // setJSON 是 storage.js 的封装，同样检查
      const setJsonRe = /\bsetJSON\s*\(\s*['"]([^'"]*(?:unlock|sgx-lock|sgx-unlock)[^'"]*)['"]/gi;
      while ((m = setJsonRe.exec(src))) {
        errors.push(`${r}: 前端禁止用 storage 保存解锁状态 (setJSON key: ${m[1]})`);
      }
    }
  }
}

const files = walk(join(ROOT, 'assets/js')).concat(walk(join(ROOT, 'functions')));
for (const f of files) checkFile(f);

if (errors.length) {
  console.error('check-layers.mjs: 发现分层违规：');
  for (const e of errors) console.error('  ✗ ' + e);
  process.exit(1);
}
console.log(`check-layers.mjs: 通过（检查了 ${files.length} 个文件）`);
