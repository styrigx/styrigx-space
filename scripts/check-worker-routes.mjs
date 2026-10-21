#!/usr/bin/env node
/**
 * 核对网关 Worker 路由登记（workers/auth-gateway/wrangler.toml 的 [[routes]]）。
 * 路由匹配按线上实测的规则（scripts/lib/cf-routes.mjs）：不带 * 的规则遇到查询串不命中。
 * 以前这里写的是「不看查询串」，于是 styrigx.com/ 这类精确规则看着覆盖了首页，
 * 实际 /?lock=1&return=…（锁屏入口）和子站首页 /?utm=… 都绕过了网关（2026-10-21）。
 * 1. 主站每个 HTML 页面都被路由覆盖，带查询串（?x=1）也覆盖
 * 2. 接口和头像（/api/、/avatar/）被路由覆盖
 * 3. 路由不重复，只登记 styrigx.com 和 SUBSITE_HOSTS 里的域名
 * 4. 子站必须登记的路径（含首页 + 查询串）都覆盖
 * 5. daymark 的句子接口（daymark.styrigx.com/api/*，styrigx-daymark-core）不能被网关更具体的规则抢走（session-check 除外）
 * 静态资源现在也进网关（整站通配），由 src/index.js / subsites.js 原样回源；单测 auth-flow-2026-10-21 覆盖。
 *
 * 需要先构建网站（hugo --minify -s web），读 web/public/ 下的 .html。
 * 用法：node scripts/check-worker-routes.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRoutes, routeMatches, pickRoute } from './lib/cf-routes.mjs';

export { readRoutes, routeMatches };

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'styrigx.com';
const PUBLIC_DIR = path.join(REPO, 'web/public');
/* 不需要过网关的 HTML：Pages 对不存在的路径直接回 404.html，本来就没人拦 */
const EXEMPT = new Set(['/404.html']);
/* 必须过网关的非页面路径（含锁屏入口本身，带查询串） */
const MUST_ROUTE = ['/api/geo', '/api/session-check', '/avatar/32.webp', '/avatar/512.webp',
  '/?lock=1', '/?lock=1&why=no-cookie&return=https%3A%2F%2Fblog.styrigx.com%2F', '/?return=%2Fsettings%2Fsecurity%2Flock%2F',
  '/en/?lock=1', '/files-index.json'];
/* 子站：域名 → 必须登记的路径 */
const SUBSITE_HOSTS = {
  'blog.styrigx.com': {
    mustRoute: ['/', '/?utm=1', '/about/', '/archives/', '/post/x/', '/post/x/?a', '/tags/x/', '/en/', '/en/?a', '/rss.xml', '/rss.xml?a', '/api/session-check'],
  },
  'daymark.styrigx.com': {
    mustRoute: ['/', '/?x=1', '/en/', '/zh/', '/sitemap.xml', '/sitemap.xml?a', '/api/session-check'],
    /* 归 styrigx-daymark-core 的接口：网关不得有比 daymark.styrigx.com/api/* 更具体的规则 */
    otherWorker: { pattern: 'daymark.styrigx.com/api/*', samples: ['/api/quotes', '/api/today'] },
  },
};

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
      if (!pickRoute(routes, host, p)) errors.push('子站路径没有路由（不过网关）：' + host + p);
    }
    if (conf.otherWorker) {
      for (const p of conf.otherWorker.samples) {
        const mine = pickRoute(routes, host, p);
        if (mine && mine.length >= conf.otherWorker.pattern.length) errors.push('网关抢了别的 Worker 的路径：' + host + p + ' ← ' + mine);
      }
    }
  }
  for (const p of pagePaths) {
    if (EXEMPT.has(p)) continue;
    if (!pickRoute(routes, HOST, p)) errors.push('页面没有路由（不过网关）：' + p);
    if (!pickRoute(routes, HOST, p + '?x=1')) errors.push('页面带查询串时没有路由（不过网关）：' + p + '?x=1');
  }
  for (const p of MUST_ROUTE) {
    if (!pickRoute(routes, HOST, p)) errors.push('没有路由（不过网关）：' + p);
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
