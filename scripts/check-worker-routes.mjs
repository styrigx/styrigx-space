#!/usr/bin/env node
/**
 * 核对主站 Worker 路由登记（workers/auth-gateway/wrangler.toml 的 [[routes]]）：
 * 1. 主站每个 HTML 页面都被某条路由覆盖（页面必须先过网关验会话；新增页面目录忘了登记 → 失败）
 * 2. 接口和头像（/api/、/avatar/）被路由覆盖（Pages 上没有后端代码，漏了就是 404 或默认头像）
 * 3. 静态资源目录不被任何路由覆盖（静态资源不过 Worker）
 * 4. 路由不重复
 * 5. 子站（blog/daymark）：只能登记 SUBSITE_HOSTS 里的域名；session-check 有路由；静态资源目录不被覆盖
 *    （子站页面是否全覆盖，由各子站 CI 部署后逐个目录冒烟检查）
 *
 * 需要先构建网站（hugo --minify -s web），读 web/public/ 下的 .html。
 * 用法：node scripts/check-worker-routes.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'styrigx.com';
const PUBLIC_DIR = path.join(REPO, 'web/public');
/* 不需要过网关的 HTML：Pages 对不存在的路径直接回 404.html，本来就没人拦 */
const EXEMPT = new Set(['/404.html']);
/* 静态资源样例：都不能落进路由 */
const STATIC_SAMPLES = ['/css/main.css', '/js/entries/entry-core.js', '/fonts/inter-latin.woff2', '/fav/x.webp', '/robots.txt', '/sitemap.xml', '/favicon.ico'];
/* 必须过网关的非页面路径 */
const MUST_ROUTE = ['/api/geo', '/api/session-check', '/avatar/32.webp', '/avatar/512.webp'];
/* 子站：域名 → { 必须登记的路径, 不许登记的静态资源样例 } */
const SUBSITE_HOSTS = {
  'blog.styrigx.com': {
    mustRoute: ['/', '/about/', '/archives/', '/post/x/', '/tags/x/', '/en/', '/rss.xml', '/api/session-check'],
    statics: ['/_astro/x.js', '/fonts/x.woff2', '/favicon.ico', '/robots.txt', '/manifest.json', '/og.png'],
  },
  'daymark.styrigx.com': {
    mustRoute: ['/', '/en/', '/zh/', '/sitemap.xml', '/api/session-check'],
    statics: ['/js/x.js', '/css/x.css', '/fonts/x.woff2', '/favicon.ico', '/robots.txt', '/api/quotes', '/api/today'],
  },
};

export function readRoutes(toml) {
  return [...toml.matchAll(/^pattern = "([^"]+)"$/gm)].map(m => m[1]);
}

/** Cloudflare 路由规则（只用到的部分）：结尾 * 是前缀匹配，否则精确匹配；不看查询串 */
export function routeMatches(pattern, host, pathname) {
  const target = host + pathname;
  if (pattern.endsWith('*')) return target.startsWith(pattern.slice(0, -1));
  return target === pattern;
}

/** web/public 里的 a/b/index.html → /a/b/；其他 .html 原样 */
export function htmlToPath(rel) {
  const p = '/' + rel.split(path.sep).join('/');
  return p.endsWith('/index.html') ? p.slice(0, -'index.html'.length) : p;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.html')) out.push(path.relative(PUBLIC_DIR, full));
  }
  return out;
}

export function check(routes, pagePaths) {
  const errors = [];
  const seen = new Set();
  for (const r of routes) {
    if (seen.has(r)) errors.push('重复路由：' + r);
    seen.add(r);
    const host = r.slice(0, r.indexOf('/'));
    if (host !== HOST && !SUBSITE_HOSTS[host]) errors.push('路由不在登记过的域名下：' + r);
  }
  for (const [host, conf] of Object.entries(SUBSITE_HOSTS)) {
    for (const p of conf.mustRoute) {
      if (!routes.some(r => routeMatches(r, host, p))) errors.push('子站路径没有路由：' + host + p);
    }
    for (const p of conf.statics) {
      const hit = routes.find(r => routeMatches(r, host, p));
      if (hit) errors.push('子站静态资源被路由覆盖：' + host + p + ' ← ' + hit);
    }
  }
  for (const p of pagePaths) {
    if (EXEMPT.has(p)) continue;
    if (!routes.some(r => routeMatches(r, HOST, p))) errors.push('页面没有路由（不过网关）：' + p);
  }
  for (const p of MUST_ROUTE) {
    if (!routes.some(r => routeMatches(r, HOST, p))) errors.push('没有路由（Pages 上没有后端代码）：' + p);
  }
  for (const p of STATIC_SAMPLES) {
    const hit = routes.find(r => routeMatches(r, HOST, p));
    if (hit) errors.push('静态资源被路由覆盖：' + p + ' ← ' + hit);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const routes = readRoutes(readFileSync(path.join(REPO, 'workers/auth-gateway/wrangler.toml'), 'utf8'));
  let pages;
  try {
    pages = walk(PUBLIC_DIR).map(htmlToPath);
  } catch (e) {
    console.error('check-worker-routes.mjs: 读不到 web/public，先运行 hugo --minify -s web');
    process.exit(1);
  }
  if (!pages.length) {
    console.error('check-worker-routes.mjs: web/public 里没有 HTML，先构建网站');
    process.exit(1);
  }
  const errors = check(routes, pages);
  if (errors.length) {
    for (const e of errors) console.error('✗ ' + e);
    process.exit(1);
  }
  console.log(`check-worker-routes.mjs: 通过（${routes.length} 条路由，${pages.length} 个页面）`);
}
