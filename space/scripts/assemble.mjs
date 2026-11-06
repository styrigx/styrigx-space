#!/usr/bin/env node
/**
 * 四包拼一棵树（合并 PR2）：主站和三个子站各自 Hugo 构建，拼成 styrigx.com 的单一 Pages 产物（默认 dist/site/）：
 *   space/web/public/*          → dist/site/          主站整份（含域名根上的 _worker.js、_headers、_redirects、robots.txt、404.html）
 *   atlas/web/<站>/public/*           → dist/site/<站>/     blog、curio、daymark（各站 baseURL 已是 https://styrigx.com/<站>/）
 *
 * 规则（任何一条不满足就失败，不出半棵树）：
 *   - 主站产物要先构建好（space/web/public/index.html 在）；主站产物里不许已有 blog/ curio/ daymark/（防撞名）。
 *   - 每站产物要先构建好（atlas/web/<站>/public/index.html 在）。
 *   - 子站产物里不许有 _worker.js / _headers / _redirects / robots.txt：Pages 只认域名根上的这几个文件，放在子目录里是死文件，
 *     而且子站版的 _worker.js 曾按旧图志域名判断 host（会把网关回源弹走）。根文件一律归主站（space/web/static/）。
 *   - 404.html 各站自带：Pages 按最近一级的 404.html 回答（/blog/xxx → /blog/404.html，站外 → 根上主站的 404.html）。
 *
 * 用法：node space/scripts/assemble.mjs [--out <目录>]（--out 按当前目录解析；默认仓库根的 dist/site/。先构建四个包：node space/scripts/build-sites.mjs 会顺带拼树）
 * 单测：tests/space/ui/build/assemble.test.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 子站包（目录名 = URL 第一段 = atlas/web/<站>/） */
export const SITES = Object.freeze(['blog', 'curio', 'daymark']);
/** 只在域名根上生效、只许主站提供的 Pages 文件 */
export const ROOT_ONLY = Object.freeze(['_worker.js', '_headers', '_redirects', 'robots.txt']);
export const DEFAULT_MAIN = 'space/web/public';
export const DEFAULT_OUT = 'dist/site';

/**
 * @param {{ main?: string, sites?: readonly string[], siteDir?: (site: string) => string, out?: string }} [opts]
 *   main / out / siteDir 的相对路径按仓库根解析；siteDir 默认 atlas/web/<站>/public（单测用它指到临时目录）
 * @returns {string} 输出目录的绝对路径
 */
export function assemble(opts = {}) {
  const abs = (p) => path.resolve(REPO, p);
  const main = abs(opts.main || DEFAULT_MAIN);
  const out = abs(opts.out || DEFAULT_OUT);
  const sites = opts.sites || SITES;
  const siteDir = opts.siteDir || ((s) => `atlas/web/${s}/public`);
  const rel = (p) => path.relative(REPO, p) || '.';

  /* 先把全部前提核对完再动输出目录：失败时不留半棵树 */
  if (!existsSync(path.join(main, 'index.html'))) throw new Error(`assemble：主站还没构建（缺 ${rel(main)}/index.html）`);
  const mainNames = new Set(readdirSync(main));
  const srcs = [];
  for (const site of sites) {
    if (mainNames.has(site)) throw new Error(`assemble：主站产物里已有 ${site}/，和子站 /${site}/ 撞名`);
    const src = abs(siteDir(site));
    if (!existsSync(path.join(src, 'index.html'))) throw new Error(`assemble：${site} 还没构建（缺 ${rel(src)}/index.html）`);
    const stray = readdirSync(src).filter((n) => ROOT_ONLY.includes(n));
    if (stray.length) throw new Error(`assemble：${site} 的产物里有只该在域名根上的文件：${stray.join('、')}`);
    srcs.push([site, src]);
  }
  if (out === main || main.startsWith(out + path.sep) || out.startsWith(main + path.sep)) {
    throw new Error('assemble：输出目录不能和主站产物目录重叠');
  }

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(main, out, { recursive: true });
  for (const [site, src] of srcs) cpSync(src, path.join(out, site), { recursive: true });
  return out;
}

function cli(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out') o.out = argv[++i] ? path.resolve(argv[i]) : '';
    else throw new Error('assemble：未知参数 ' + argv[i] + '（用法：node space/scripts/assemble.mjs [--out dist/site]）');
  }
  if (o.out === undefined) delete o.out;
  else if (!o.out) throw new Error('assemble：--out 后面要跟目录');
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const out = assemble(cli(process.argv));
    console.log(`assembled ${path.relative(REPO, out) || '.'}/ ← space/web/public/ + ` + SITES.map((s) => `atlas/web/${s}/public/ → ${s}/`).join('、'));
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}
