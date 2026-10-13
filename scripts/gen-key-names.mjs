#!/usr/bin/env node
/**
 * 从后端唯一来源 functions/_kernel/key-names.js 生成前端镜像
 * assets/js/lib/key-names.js（单一来源，禁止前端手抄）。
 *
 * 用法：node scripts/gen-key-names.mjs
 * CI 漂移检查：生成后 git diff --exit-code 不为空即失败（见 deploy.yml）。
 * 生成文件带 GENERATED 头，check-frontend.mjs 对裸类别字面量的规则豁免该文件。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcPath = join(root, 'functions', '_kernel', 'key-names.js');
const outPath = join(root, 'assets', 'js', 'lib', 'key-names.js');

const src = readFileSync(srcPath, 'utf8');
/* 取导出声明：export const NAME = <表达式>;（含跨行对象字面量，行尾可带 // 注释），
   去掉 export 前缀，原样输出到前端文件。 */
const re = /^export const ([A-Za-z0-9_]+) = (.*?);(?:[ \t]*\/\/[^\n]*)?$/gms;
const decls = [];
let m;
while ((m = re.exec(src)) !== null) {
  const name = m[1];
  const expr = m[2].trim();
  /* 只复制纯常量/纯对象字面量：不含箭头函数、不以 ( 开头（函数参数）、
     不含 import 引用。含函数（appKeyName、classToKeyName、ownerPasskeyKey）
     时跳过——它们在前端文件里手写与后端同表达式（见下）。 */
  if (/=>/.test(expr) || /^\s*\(/.test(expr) || /\bimport\b/.test(expr)) continue;
  decls.push({ name, expr });
}

const needed = [
  'KEY_ROOT',
  'KEY_OWNER',
  'KEY_LOCK',
  'STORE_CLASS_OWNERKEY',
  'STORE_CLASS_LOCKKEY',
  'STORE_CLASS_APPKEY',
  'CLASS_TO_KEY',
  'KEY_NAME_MAPPING',
  'OWNER_PASSKEY_PREFIX',
];
const missing = needed.filter((n) => !decls.some((d) => d.name === n));
if (missing.length) {
  console.error('gen-key-names: 后端 key-names.js 缺少常量：' + missing.join(', '));
  process.exit(1);
}

const lines = [];
lines.push('/**');
lines.push(' * GENERATED FILE — DO NOT EDIT MANUALLY.');
lines.push(' * 由 scripts/gen-key-names.mjs 从 functions/_kernel/key-names.js 生成');
lines.push(' * （后端是唯一来源；前端禁止手抄类别字面量，统一 import 本文件）。');
lines.push(' */');
for (const d of decls) {
  lines.push('export const ' + d.name + ' = ' + d.expr + ';');
}
lines.push('');
lines.push('/* 以下函数与后端同表达式手写（生成器不复制函数体，见脚本注释） */');
lines.push('export function appKeyName(aud) {');
lines.push('  return String(aud || \'\').toLowerCase() + \'key\';');
lines.push('}');
lines.push('');
lines.push('export function classToKeyName(pkClass, aud) {');
lines.push('  if (pkClass === \'app\' && aud) return appKeyName(aud);');
lines.push('  return CLASS_TO_KEY[pkClass] || pkClass;');
lines.push('}');
lines.push('');
lines.push('export function ownerPasskeyKey(credId) {');
lines.push('  return OWNER_PASSKEY_PREFIX + String(credId).slice(0, 12);');
lines.push('}');
lines.push('');

writeFileSync(outPath, lines.join('\n'));
console.log('gen-key-names: wrote ' + outPath);
