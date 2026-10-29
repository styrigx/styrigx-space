#!/usr/bin/env node
/**
 * CSP 内联脚本哈希 + Pages 安全头（2026-10-25，PR D）。
 *
 * 从生产构建（hugo --minify -s web，产物在 web/public/）里找出所有会执行的内联 <script>
 * （没有 src，type 为空 / text/javascript / module；application/json 等数据块不算），算 sha256，写两处：
 *   1. workers/shared/csp-hashes.js —— 网关 / 账号 / 分享 Worker 的 Report-Only CSP 用
 *   2. web/static/_headers 里 @gen-security-headers 那一段 —— Pages 静态响应的同一套安全头
 *      （值取自 workers/shared/security-headers.js 的 mainSiteHeaderList()，两边不会不一致）
 * 同时检查：HTML 里不许有 on*="…" 事件属性和 javascript: 链接（CSP 没法用哈希放行它们）。
 *
 * 哈希依赖 Hugo 版本和 --minify（压缩会改内联脚本的空白），CI 和部署都是同一条构建命令、同一个 HUGO_VERSION。
 * 改了 baseof.html 等模板里的内联脚本，就要重新生成：
 *   hugo --minify -s web && node scripts/gen-csp.mjs
 * 用法：node scripts/gen-csp.mjs            重新生成（先构建）
 *       node scripts/gen-csp.mjs --check    只核对（CI quality，在「Build site」之后跑；不一致 exit 1）
 *       --public <目录>                      构建产物目录（默认 web/public）
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseHeaders } from './lib/pages-headers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HASHES_FILE = path.join(REPO, 'workers/shared/csp-hashes.js');
export const HEADERS_FILE = path.join(REPO, 'web/static/_headers');
const SECURITY = path.join(REPO, 'workers/shared/security-headers.js');
export const GEN_START = '# @gen-security-headers start';
export const GEN_END = '# @gen-security-headers end';
/* CF 文档：_headers 每行最多 2000 字符 */
const MAX_LINE = 2000;

const EXEC_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module']);

/** @param {string} dir @param {string[]} [out] */
function htmlFiles(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) htmlFiles(p, out);
    else if (p.endsWith('.html')) out.push(p);
  }
  return out;
}

/**
 * 一份 HTML 里会执行的内联脚本正文（原样，不 trim：CSP 哈希按字节算）。
 * @param {string} html
 * @returns {string[]}
 */
export function inlineScripts(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1];
    if (/(^|\s)src\s*=/i.test(attrs)) continue;
    const tm = attrs.match(/(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const type = tm ? (tm[1] ?? tm[2] ?? tm[3] ?? '').trim().toLowerCase() : '';
    if (!EXEC_TYPES.has(type)) continue;
    out.push(m[2]);
  }
  return out;
}

/** @param {string} body */
export function sha256(body) {
  return 'sha256-' + createHash('sha256').update(body, 'utf8').digest('base64');
}

/**
 * CSP 放行不了的写法：on*="…" 事件属性、href/src="javascript:…"。
 * @param {string} html
 * @returns {string[]}
 */
export function unhashable(html) {
  const bad = [];
  const noScripts = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  for (const m of noScripts.matchAll(/<[a-z][^>]*\s(on[a-z]+)\s*=/gi)) bad.push(m[1] + '=');
  for (const m of noScripts.matchAll(/\s(?:href|src|action|formaction)\s*=\s*["']?\s*javascript:/gi)) bad.push(m[0].trim());
  return bad;
}

/**
 * 扫一遍构建产物。
 * @param {string} publicDir
 */
export function scan(publicDir) {
  if (!existsSync(path.join(publicDir, 'index.html'))) {
    throw new Error(publicDir + ' 里没有 index.html：先跑 hugo --minify -s web');
  }
  /** @type {Map<string, {count: number, sample: string, file: string}>} */
  const hashes = new Map();
  const problems = [];
  for (const f of htmlFiles(publicDir)) {
    const html = readFileSync(f, 'utf8');
    for (const s of inlineScripts(html)) {
      const h = sha256(s);
      const e = hashes.get(h);
      if (e) e.count++;
      else hashes.set(h, { count: 1, sample: s.trim().slice(0, 60).replace(/\s+/g, ' '), file: path.relative(publicDir, f) });
    }
    for (const b of unhashable(html)) problems.push(path.relative(publicDir, f) + ': ' + b);
  }
  return { hashes, problems };
}

/** @param {ReturnType<typeof scan>['hashes']} hashes */
export function renderHashesFile(hashes) {
  const rows = [...hashes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const lines = rows.map(([h, e]) => `  '${h}', // ${e.file}（${e.count} 页）: ${e.sample.replace(/\*\//g, '* /')}`);
  return [
    '/**',
    ' * @fileoverview 生成文件，别手改：node scripts/gen-csp.mjs（先 hugo --minify -s web）。CI 用 --check 核对。',
    ' * 生产构建里每段会执行的内联 <script> 的 sha256，给 security-headers.js 的 Content-Security-Policy-Report-Only 用。',
    ' */',
    'export const INLINE_SCRIPT_HASHES = Object.freeze([',
    ...lines,
    ']);',
    '',
  ].join('\n');
}

/**
 * _headers 里生成的那一段（/* 的安全头）。
 * @param {Array<[string, string]>} list mainSiteHeaderList()
 */
export function renderHeadersBlock(list) {
  return [
    GEN_START + '（scripts/gen-csp.mjs 按 workers/shared/security-headers.js 生成，别手改）',
    '/*',
    ...list.map(([k, v]) => '  ' + k + ': ' + v),
    GEN_END,
  ].join('\n');
}

/** @param {string} text @param {string} block */
export function spliceBlock(text, block) {
  const a = text.indexOf(GEN_START);
  const b = text.indexOf(GEN_END);
  if (a < 0 || b < a) throw new Error('_headers 里找不到 ' + GEN_START + ' / ' + GEN_END);
  const lineEnd = text.indexOf('\n', b);
  return text.slice(0, a) + block + (lineEnd < 0 ? '' : text.slice(lineEnd));
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const pi = args.indexOf('--public');
  const publicDir = pi >= 0 ? path.resolve(args[pi + 1]) : path.join(REPO, 'web/public');

  const { hashes, problems } = scan(publicDir);
  if (problems.length) {
    console.error('gen-csp: 有 CSP 没法用哈希放行的写法（改成模块里 addEventListener）：\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  if (!hashes.size) {
    console.error('gen-csp: 构建产物里一段内联脚本都没找到，不对劲（baseof 的首屏脚本应该在）');
    process.exit(1);
  }
  const hashesText = renderHashesFile(hashes);

  if (check) {
    const cur = existsSync(HASHES_FILE) ? readFileSync(HASHES_FILE, 'utf8') : '';
    let ok = true;
    if (cur !== hashesText) {
      ok = false;
      console.error('gen-csp --check: ' + path.relative(REPO, HASHES_FILE) + ' 和构建产物对不上（内联脚本改过？）。重新生成：hugo --minify -s web && node scripts/gen-csp.mjs');
    }
    const { mainSiteHeaderList } = await import(pathToFileURL(SECURITY).href);
    const headersText = readFileSync(HEADERS_FILE, 'utf8');
    const want = spliceBlock(headersText, renderHeadersBlock(mainSiteHeaderList()));
    if (want !== headersText) {
      ok = false;
      console.error('gen-csp --check: web/static/_headers 的安全头和 security-headers.js 对不上。重新生成：node scripts/gen-csp.mjs');
    }
    for (const [i, l] of headersText.split('\n').entries()) {
      if (l.length > MAX_LINE) {
        ok = false;
        console.error('gen-csp --check: _headers:' + (i + 1) + ' 超过 ' + MAX_LINE + ' 字符（CF 上限）');
      }
    }
    parseHeaders(headersText);
    if (!ok) process.exit(1);
    console.log('gen-csp: in sync（' + hashes.size + ' 段内联脚本）');
    return;
  }

  writeFileSync(HASHES_FILE, hashesText);
  /* 先写哈希再 import：security-headers.js 读的是刚写好的 csp-hashes.js */
  const { mainSiteHeaderList } = await import(pathToFileURL(SECURITY).href);
  const headersText = readFileSync(HEADERS_FILE, 'utf8');
  const next = spliceBlock(headersText, renderHeadersBlock(mainSiteHeaderList()));
  writeFileSync(HEADERS_FILE, next);
  for (const [i, l] of next.split('\n').entries()) {
    if (l.length > MAX_LINE) throw new Error('_headers:' + (i + 1) + ' 超过 ' + MAX_LINE + ' 字符（CF 上限）');
  }
  console.log('gen-csp: 写好 ' + path.relative(REPO, HASHES_FILE) + '（' + hashes.size + ' 段内联脚本）和 web/static/_headers');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('gen-csp: ' + (e && e.message ? e.message : e));
    process.exit(1);
  });
}
