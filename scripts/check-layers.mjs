#!/usr/bin/env node
/**
 * @fileoverview L0-L6 分层边界检查（SGX 3.0 架构规范，docs/architecture.md）。
 *
 * 每个相对 import 都解析成真实文件，再按目标文件所在目录判层（不再按文件名猜）。
 * 解析不到文件的相对 import 直接报错：以前这种情况记成 'unknown' 并且放行，
 * api → api（'./lock-reauth.js'）、api → middleware（'../_middleware.js'）都因此漏检。
 *
 * 前端（web/assets/js/）：
 *  1. lib/ 只能 import lib/（不得 import auth/、shell/、apps/、entries/）
 *  2. auth/ 只能 import lib/、auth/（鉴权与凭证流程；不得 import shell/、apps/、entries/）
 *  3. shell/ 不得 import apps/、entries/
 *  4. apps/ 不得 import entries/
 *  5. 前端不得 import web/assets/js/ 以外的文件（前后端隔离，含 functions/、workers/）
 *  6. lib/ 不得包含鉴权逻辑：不得出现鉴权接口地址（/api/lock-*、/api/root-*、/api/account）
 *     和 navigator.credentials（这些放 auth/）
 *  7. 前端代码禁止出现 cookie 名 `sgx-lock-session`（HttpOnly，前端读不到；`data-sgx-lock-session` 属性名不算）
 *  8. 前端代码禁止出现 `sgx-lock-shown` 字符串
 *  9. 前端代码不得用 sessionStorage/localStorage 保存解锁状态
 *     （key 匹配：unlock、sgx-lock、session；storage.js 本身除外）
 *
 * 网关（workers/auth-gateway/）：
 * 10. functions/_kernel/ 只能 import _kernel/
 * 11. functions/api/ 只能 import _kernel/（api 之间不互相 import，也不 import _middleware）
 * 12. functions/_middleware.js 只能 import _kernel/
 * 13. src/ 只能 import src/ 和 functions/_kernel/；例外：src/routes.js 可以 import functions/api/（路由表），
 *     src/index.js 可以 import functions/_middleware.js（入口）
 * 14. 网关不得 import 网关目录以外的文件；非相对 import 只认 cloudflare:workers
 *
 * 用法：node scripts/check-layers.mjs [--root <仓库根>]
 * 规则函数导出给 tests/web/ui/check-layers.test.mjs 用。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} dir @param {string[]} [out] */
export function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (['node_modules', 'public', '.git', '.hugo_build.lock'].includes(e)) continue;
      walk(p, out);
    } else if (p.endsWith('.js') || p.endsWith('.mjs') || p.endsWith('.cjs')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * import 路径（静态 import / export … from / 动态 import()）。
 * @param {string} src
 * @returns {string[]}
 */
export function importsOf(src) {
  const out = [];
  const re = /(?:\bimport\s+(?:[^'"()]*?\s+from\s+)?|\bexport\s+(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s+)?from\s+|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

/**
 * 去掉注释（规则 6-8 只查代码）。字符串里的 // 不当注释（URL 常见），模板字符串按普通字符串处理。
 * @param {string} src
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      out += ' ';
      continue;
    }
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 文件所在层。
 * @param {string} root 仓库根
 * @param {string} abs 绝对路径
 * @returns {{area:'frontend'|'gateway'|'other', layer:string, rel:string}}
 */
export function layerOf(root, abs) {
  const rel = relative(root, abs).split(sep).join('/');
  let m = rel.match(/^web\/assets\/js\/([^/]+)\//);
  if (m) return { area: 'frontend', layer: m[1], rel };
  if (rel.startsWith('web/assets/js/')) return { area: 'frontend', layer: '(root)', rel };
  if (rel.startsWith('workers/auth-gateway/functions/_kernel/')) return { area: 'gateway', layer: '_kernel', rel };
  if (rel.startsWith('workers/auth-gateway/functions/api/')) return { area: 'gateway', layer: 'api', rel };
  if (rel === 'workers/auth-gateway/functions/_middleware.js') return { area: 'gateway', layer: '_middleware', rel };
  if (rel.startsWith('workers/auth-gateway/functions/')) return { area: 'gateway', layer: 'functions-other', rel };
  if (rel.startsWith('workers/auth-gateway/src/')) return { area: 'gateway', layer: 'src', rel };
  return { area: 'other', layer: 'other', rel };
}

/** 前端各层可 import 的层 */
const FRONTEND_ALLOWED = {
  lib: new Set(['lib']),
  auth: new Set(['lib', 'auth']),
  shell: new Set(['lib', 'auth', 'shell']),
  apps: new Set(['lib', 'auth', 'shell', 'apps']),
  entries: new Set(['lib', 'auth', 'shell', 'apps', 'entries']),
};

/* 规则 6：lib/ 里不许出现的鉴权痕迹 */
const LIB_AUTH_RE = /\/api\/(?:lock-|root-|account\b)|navigator\s*\.\s*credentials/;

const EXTERNAL_OK = new Set(['cloudflare:workers']);

/**
 * 查一个文件，返回违规列表。
 * @param {string} root
 * @param {string} abs
 * @param {string} [srcOverride] 测试用：不读盘，直接给源码
 * @returns {string[]}
 */
export function checkFile(root, abs, srcOverride) {
  const errors = [];
  const src = srcOverride === undefined ? readFileSync(abs, 'utf8') : srcOverride;
  const code = stripComments(src);
  const self = layerOf(root, abs);
  const r = self.rel;

  for (const spec of importsOf(code)) {
    if (!spec.startsWith('.')) {
      if (self.area === 'gateway' && !EXTERNAL_OK.has(spec)) {
        errors.push(`${r}: 网关只能 import 相对路径或 cloudflare:workers，发现 ${spec}`);
      }
      continue;
    }
    const target = resolve(dirname(abs), spec);
    if (!existsSync(target) || statSync(target).isDirectory()) {
      errors.push(`${r}: import 的文件不存在（${spec}）`);
      continue;
    }
    const t = layerOf(root, target);

    if (self.area === 'frontend') {
      if (t.area !== 'frontend') {
        errors.push(`${r}: 前端禁止 import web/assets/js/ 以外的文件 (${spec})`);
        continue;
      }
      const allowed = FRONTEND_ALLOWED[self.layer];
      if (allowed && !allowed.has(t.layer)) {
        errors.push(`${r}: ${self.layer}/ 禁止 import ${t.layer}/ (${spec})`);
      }
      continue;
    }

    if (self.area === 'gateway') {
      if (t.area !== 'gateway') {
        errors.push(`${r}: 网关禁止 import 网关目录以外的文件 (${spec})`);
        continue;
      }
      if (self.layer === '_kernel' && t.layer !== '_kernel') {
        errors.push(`${r}: functions/_kernel/ 只能 import _kernel/，发现 ${t.layer} (${spec})`);
      } else if (self.layer === 'api' && t.layer !== '_kernel') {
        errors.push(`${r}: functions/api/ 只能 import _kernel/，发现 ${t.layer} (${spec})`);
      } else if (self.layer === '_middleware' && t.layer !== '_kernel') {
        errors.push(`${r}: functions/_middleware.js 只能 import _kernel/，发现 ${t.layer} (${spec})`);
      } else if (self.layer === 'src') {
        const ok = t.layer === 'src' || t.layer === '_kernel' ||
          (r === 'workers/auth-gateway/src/routes.js' && t.layer === 'api') ||
          (r === 'workers/auth-gateway/src/index.js' && t.layer === '_middleware');
        if (!ok) errors.push(`${r}: src/ 只能 import src/ 和 functions/_kernel/（路由表、入口例外），发现 ${t.layer} (${spec})`);
      } else if (self.layer === 'functions-other') {
        errors.push(`${r}: functions/ 下只允许 _kernel/、api/、_middleware.js`);
      }
    }
  }

  if (self.area === 'frontend') {
    if (self.layer === 'lib' && LIB_AUTH_RE.test(code)) {
      errors.push(`${r}: lib/ 不得包含鉴权逻辑（鉴权接口 / navigator.credentials 放 auth/）`);
    }
    if (/(?<!data-)sgx-lock-session/.test(code)) {
      errors.push(`${r}: 前端禁止出现 sgx-lock-session 字符串`);
    }
    if (code.includes('sgx-lock-shown')) {
      errors.push(`${r}: 前端禁止出现 sgx-lock-shown 字符串`);
    }
    if (!r.endsWith('/storage.js')) {
      const unlockKeyRe = /(?:sessionStorage|localStorage)\s*\.\s*setItem\s*\(\s*['"]([^'"]*(?:unlock|sgx-lock|sgx-unlock|session)[^'"]*)['"]/gi;
      let m;
      while ((m = unlockKeyRe.exec(code))) {
        errors.push(`${r}: 前端禁止用 storage 保存解锁状态 (key: ${m[1]})`);
      }
      const setJsonRe = /\bsetJSON\s*\(\s*['"]([^'"]*(?:unlock|sgx-lock|sgx-unlock)[^'"]*)['"]/gi;
      while ((m = setJsonRe.exec(code))) {
        errors.push(`${r}: 前端禁止用 storage 保存解锁状态 (setJSON key: ${m[1]})`);
      }
    }
  }
  return errors;
}

/**
 * 查整个仓库。
 * @param {string} root
 * @returns {{files:number, errors:string[]}}
 */
export function checkRepo(root) {
  const files = walk(join(root, 'web/assets/js'))
    .concat(walk(join(root, 'workers/auth-gateway/functions')))
    .concat(walk(join(root, 'workers/auth-gateway/src')));
  const errors = [];
  for (const f of files) errors.push(...checkFile(root, f));
  return { files: files.length, errors };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const i = process.argv.indexOf('--root');
  const root = i > 0 ? resolve(process.argv[i + 1]) : DEFAULT_ROOT;
  const { files, errors } = checkRepo(root);
  if (errors.length) {
    console.error('check-layers.mjs: 发现分层违规：');
    for (const e of errors) console.error('  ✗ ' + e);
    process.exit(1);
  }
  console.log(`check-layers.mjs: 通过（检查了 ${files} 个文件）`);
}
