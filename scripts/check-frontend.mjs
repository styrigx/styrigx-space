#!/usr/bin/env node
/**
 * @fileoverview 前端代码规范检查（Item 25）。
 *
 * 规则（违反任一条则 exit 1，CI 失败）：
 *  1. assets/js/ 下禁止原生弹窗：window.prompt / window.confirm / window.alert
 *    （含不带 window. 前缀的裸 prompt()/confirm()/alert() 调用）。
 *     理由：原生弹窗不可定制样式、阻塞主线程、移动端体验差；
 *     确认类用站内两步确认（armConfirm / 两步改文案）或站内弹层替代。
 *  2. assets/js/ 下禁止独立的 `token` 变量（已废弃的内存鉴权 token 机制：
 *     如 `let token`、`token = null`、`token:` 传参等；后端改用 cookie 鉴权后
 *     该机制已删除，残留即 bug）。只匹配独立的 token 标识符，不误伤
 *     csrfToken、__token 等合法命名（词边界匹配）。
 *
 * 扫描范围：web/assets/js/ 和 web/shared/shell/（同步给子站的外壳脚本）。
 * 去注释按词法走（字符串里的 // 不当注释），以前用正则去注释，'https://…' 之后同一行的代码会被当注释吞掉，
 * 那一行的 alert( 就查不到。
 * 原生弹窗除了裸调用和 window.，也查 globalThis. / self. / top. 和 window['alert'] 这种写法。
 *
 * 用法：node scripts/check-frontend.mjs [--root <仓库根>]
 * 规则函数导出给 tests/web/ui/check-layers.test.mjs 用。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
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
 * 去掉块注释和行注释，保留换行（行号与原文对齐，白名单按行放行才准）。
 * 按词法走：引号 / 模板字符串里的 // 和 /* 不算注释。
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
      const stop = end < 0 ? n : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      out += ' '.repeat(stop - i);
      i = stop;
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

/* 规则 2 的匹配模式（作用于去注释后的代码，逐行检查，报错带行号） */
const TOKEN_PATTERNS = [
  { re: /\b(?:let|var|const)\s+token\b/, desc: '声明了独立的 token 变量' },
  { re: /(?<![\w$.])token\s*=(?![=>])/, desc: '对 token 变量赋值' },
  /* 入参：只认 function 声明/表达式与箭头函数的形参位置，
     不把 submitToken(token) 这类调用实参误判为形参 */
  { re: /\bfunction\s*\w*\s*\([^()]*\btoken\b/, desc: '函数入参名为 token' },
  { re: /\([^()]*\btoken\b[^()]*\)\s*=>/, desc: '箭头函数入参名为 token' },
  { re: /[{,]\s*token\s*:/, desc: '对象属性名为 token' },
  { re: /[{,]\s*token\s*[,}]/, desc: '对象简写属性 token' },
];

/**
 * 查一个文件，返回违规列表。
 * @param {string} r 显示用的相对路径
 * @param {string} src 源码
 * @returns {string[]}
 */
export function checkSource(r, src) {
  const errors = [];
  const code = stripComments(src);

  // 规则 1：原生弹窗（prompt/confirm/alert：裸调用、window./globalThis./self./top. 前缀、window['alert'] 写法）
  const dialogRe = /(?:\b(?:window|globalThis|self|top)\s*\[\s*['"](?:alert|confirm|prompt)['"]\s*\]|\b(?:(?:window|globalThis|self|top)\.)?(?:alert|confirm|prompt))\s*\(/g;
  let m;
  while ((m = dialogRe.exec(code))) {
    const lineNo = code.slice(0, m.index).split('\n').length;
    errors.push(`${r}:${lineNo}: 禁止原生弹窗 ${m[0].trim()}（用站内弹层/两步确认替代）`);
  }

  // 规则 2：独立 token 变量（逐行）
  const lines = code.split('\n');
  const origLines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pat of TOKEN_PATTERNS) {
      if (pat.re.test(line)) {
        errors.push(`${r}:${i + 1}: ${pat.desc}（废弃的内存鉴权 token 机制已删除）: ${(origLines[i] || '').trim().slice(0, 100)}`);
        break;
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
  const files = walk(join(root, 'web/assets/js')).concat(walk(join(root, 'web/shared/shell')));
  const errors = [];
  for (const f of files) {
    const r = relative(root, f).split(sep).join('/');
    errors.push(...checkSource(r, readFileSync(f, 'utf8')));
  }
  return { files: files.length, errors };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const i = process.argv.indexOf('--root');
  const root = i > 0 ? resolve(process.argv[i + 1]) : DEFAULT_ROOT;
  const { files, errors } = checkRepo(root);
  if (errors.length) {
    console.error('check-frontend.mjs: 发现前端规范违规：');
    for (const e of errors) console.error('  ✗ ' + e);
    process.exit(1);
  }
  console.log(`check-frontend.mjs: 通过（检查了 ${files} 个文件）`);
}
