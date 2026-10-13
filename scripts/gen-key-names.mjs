#!/usr/bin/env node
/**
 * @fileoverview 生成前端钥匙命名常量（定稿 #3）。
 *
 * 唯一来源：functions/_kernel/key-names.js。
 * 生成：assets/js/lib/key-names.js（前端 import 用）。
 *
 * 用法：
 *   node scripts/gen-key-names.mjs          # 生成（构建时调用）
 *   node scripts/gen-key-names.mjs --check   # 校验同步（CI 调用，不一致则 exit 1）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'functions/_kernel/key-names.js');
const DST = join(ROOT, 'assets/js/lib/key-names.js');

/* 从 kernel 文件提取 export 的常量/函数（只取前端需要的子集，语义与 kernel 一致） */
const NAMES = [
  'KEY_ROOT',
  'KEY_OWNER',
  'KEY_LOCK',
  'appKeyName',
  'STORE_CLASS_OWNERKEY',
  'STORE_CLASS_LOCKKEY',
  'STORE_CLASS_APPKEY',
];

function extract(src, name) {
  /* 匹配 export const NAME = ...; 或 export function NAME(...) {...} */
  const constRe = new RegExp('export const ' + name + '\\s*=\\s*([^;]+);');
  const m = src.match(constRe);
  if (m) return { kind: 'const', body: m[1].trim() };
  const fnRe = new RegExp('export function ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const fm = src.match(fnRe);
  if (fm) {
    /* 提取完整函数体（花括号配对） */
    let depth = 0;
    let start = fm.index + fm[0].length - 1;
    let i = start;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const sig = fm[0].slice('export function '.length).replace(/\s*\{$/, '');
    const body = src.slice(start, i + 1);
    return { kind: 'function', sig: sig, body: body };
  }
  throw new Error('not found in kernel: ' + name);
}

function generate() {
  const src = readFileSync(SRC, 'utf8');
  const parts = [];
  for (const name of NAMES) {
    const e = extract(src, name);
    if (e.kind === 'const') {
      parts.push('export const ' + name + ' = ' + e.body + ';');
    } else {
      parts.push('export function ' + e.sig + ' ' + e.body);
    }
  }
  return (
    '/**\n' +
    ' * @fileoverview 钥匙命名规范（站长定，全仓统一）——前端镜像。\n' +
    ' * 由 scripts/gen-key-names.mjs 从 functions/_kernel/key-names.js 生成，请勿手改。\n' +
    ' * 概念名：rootkey / ownerkey / lockkey / <aud>key（如 bookkey）。\n' +
    ' * Cookie 名、环境变量名、Cloudflare 绑定不改。\n' +
    ' */\n' +
    parts.join('\n\n') +
    '\n'
  );
}

const out = generate();
if (process.argv.includes('--check')) {
  let cur = '';
  try {
    cur = readFileSync(DST, 'utf8');
  } catch (e) {}
  if (cur !== out) {
    console.error('key-names.js 与 functions/_kernel/key-names.js 不同步，请运行 node scripts/gen-key-names.mjs');
    process.exit(1);
  }
  console.log('key-names.js 同步 OK');
} else {
  writeFileSync(DST, out);
  console.log('已生成 ' + DST);
}
