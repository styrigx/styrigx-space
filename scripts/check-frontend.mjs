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
 *     （2026-10-23 Turnstile 已删，原 TOKEN_ALLOWLIST 的三条例外随之清空。）
 *
 * 用法：node scripts/check-frontend.mjs
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
      if (['node_modules', 'public', '.git', '.hugo_build.lock'].includes(e)) continue;
      walk(p, out);
    } else if (p.endsWith('.js') || p.endsWith('.mjs') || p.endsWith('.cjs')) {
      out.push(p);
    }
  }
  return out;
}

/* 网站源码在 web/；路径规则仍按 assets/js/... 书写，rel() 去掉 web/ 前缀 */
function rel(p) { return relative(ROOT, p).replace(/^web\//, ''); }

function stripComments(src) {
  // 去掉块注释和行注释，但保留换行（行号与原文对齐，白名单按行放行才准）。
  // 注意：与 check-layers.mjs 的实现不同，那里不需要行号对齐。
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/* 例外白名单（contains 匹配原始行）。2026-10-23 Turnstile 删掉后为空。 */
const TOKEN_ALLOWLIST = [];

function isTokenAllowlisted(r, line) {
  return TOKEN_ALLOWLIST.some(function (e) {
    return r === e.file && line.includes(e.contains);
  });
}

/* 规则 2 的匹配模式（作用于去注释后的代码，逐行检查以便白名单按行放行） */
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

function checkFile(p) {
  const src = readFileSync(p, 'utf8');
  const code = stripComments(src);
  const r = rel(p);
  if (!r.startsWith('assets/js/')) return;

  // 规则 1：原生弹窗（prompt/confirm/alert，含 window. 前缀与裸调用）
  const dialogRe = /\b(window\.)?(alert|confirm|prompt)\s*\(/g;
  let m;
  while ((m = dialogRe.exec(code))) {
    const lineNo = code.slice(0, m.index).split('\n').length;
    errors.push(`${r}:${lineNo}: 禁止原生弹窗 ${m[0].trim()}（用站内弹层/两步确认替代）`);
  }

  // 规则 2：独立 token 变量（逐行，便于白名单）
  const lines = code.split('\n');
  const origLines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pat of TOKEN_PATTERNS) {
      if (pat.re.test(line)) {
        if (isTokenAllowlisted(r, origLines[i] || '')) continue;
        errors.push(`${r}:${i + 1}: ${pat.desc}（废弃的内存鉴权 token 机制已删除）: ${(origLines[i] || '').trim().slice(0, 100)}`);
        break;
      }
    }
  }
}

const files = walk(join(ROOT, 'web/assets/js'));
for (const f of files) checkFile(f);

if (errors.length) {
  console.error('check-frontend.mjs: 发现前端规范违规：');
  for (const e of errors) console.error('  ✗ ' + e);
  process.exit(1);
}
console.log(`check-frontend.mjs: 通过（检查了 ${files.length} 个文件）`);
