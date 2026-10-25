#!/usr/bin/env node
/**
 * 核对网关 Worker 路由登记（workers/auth-gateway/wrangler.toml 的 [[routes]]），
 * 以及账号 Worker styrigx-account（workers/account/wrangler.toml，2026-10-24 拆出来）、
 * 短链 Worker styrigx-share（workers/share/wrangler.toml，2026-10-24）的更具体路由。
 * 路由匹配按线上实测的规则（scripts/lib/cf-routes.mjs）：不带 * 的规则遇到查询串不命中。
 * 以前这里写的是「不看查询串」，于是 styrigx.com/ 这类精确规则看着覆盖了首页，
 * 实际 /?lock=1&return=…（锁屏入口）和子站首页 /?utm=… 都绕过了网关（2026-10-21）。
 * 1. 主站每个 HTML 页面都被路由覆盖，带查询串（?x=1）也覆盖
 * 2. 接口和头像（/api/、/avatar/）被路由覆盖
 * 2b. 头像 / 云同步 / 数字健康（/api/avatar、/api/prefs、/api/wellbeing、/avatar/*，带查询串也算）归账号 Worker；
 *     网关路由表（src/routes.js）里的每个接口、每个页面仍归网关（账号 Worker 的前缀规则不能抢走别的路径）；
 *     账号 Worker 只登记 styrigx.com，两边规则不重复
 * 2c. 分享短链（/s/<码>、/api/share，带查询串也算）归短链 Worker styrigx-share（workers/share/wrangler.toml，2026-10-24）；
 *     规则同 2b：网关的每个接口、每个页面仍归网关，账号 Worker 的路径仍归账号 Worker，两个 Worker 互不抢
 * 3. 路由不重复，只登记 styrigx.com 和 SUBSITE_HOSTS 里的域名
 * 4. 子站必须登记的路径（含首页 + 查询串）都覆盖
 * 5. daymark 的句子接口（daymark.styrigx.com/api/*，styrigx-daymark-core）、curio 的收藏接口（curio.styrigx.com/api/*，styrigx-curio-core）
 *    不能被网关更具体的规则抢走（session-check 除外）
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
const MUST_ROUTE = ['/api/geo', '/api/lock-session-check',
  '/?lock=1', '/?lock=1&why=no-cookie&return=https%3A%2F%2Fblog.styrigx.com%2F', '/?return=%2Fsettings%2Fsecurity%2Flock%2F',
  '/en/?lock=1', '/files-index.json'];
/* 必须归账号 Worker（styrigx-account）的路径 */
const ACCOUNT_MUST = ['/api/avatar', '/api/prefs', '/api/prefs/', '/api/wellbeing', '/api/wellbeing?d=2026-10-24',
  '/avatar/32.webp', '/avatar/96.webp', '/avatar/192.webp?v=abc', '/avatar/512.webp'];
/* 必须归短链 Worker（styrigx-share）的路径 */
const SHARE_MUST = ['/s/AAAAAAAAAAAAAAAAAAAAAA', '/s/AAAAAAAAAAAAAAAAAAAAAA/', '/s/AAAAAAAAAAAAAAAAAAAAAA?x=1', '/s/', '/api/share', '/api/share/', '/api/share?x=1'];
/* 子站：域名 → 必须登记的路径 */
const SUBSITE_HOSTS = {
  'blog.styrigx.com': {
    mustRoute: ['/', '/?utm=1', '/about/', '/archives/', '/post/x/', '/post/x/?a', '/tags/x/', '/en/', '/en/?a', '/rss.xml', '/rss.xml?a', '/api/lock-session-check'],
  },
  'daymark.styrigx.com': {
    mustRoute: ['/', '/?x=1', '/en/', '/zh/', '/sitemap.xml', '/sitemap.xml?a', '/api/lock-session-check'],
    /* 归 styrigx-daymark-core 的接口：网关不得有比 daymark.styrigx.com/api/* 更具体的规则 */
    otherWorker: { pattern: 'daymark.styrigx.com/api/*', samples: ['/api/quotes', '/api/today'] },
  },
  'curio.styrigx.com': {
    mustRoute: ['/', '/?x=1', '/en/', '/zh/', '/sitemap.xml', '/sitemap.xml?a', '/#c/1', '/api/lock-session-check'],
    /* 归 styrigx-curio-core 的接口：网关不得有比 curio.styrigx.com/api/* 更具体的规则 */
    otherWorker: { pattern: 'curio.styrigx.com/api/*', samples: ['/api/links', '/api/icon?id=1', '/api/import', '/api/export', '/api/preview?url=x'] },
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

/** 网关路由表里的接口路径（workers/auth-gateway/src/routes.js 的 ['/api/x', mod]） @param {string} js */
export function readApiRoutes(js) {
  return [...js.matchAll(/\[\s*'(\/api\/[a-z0-9-]+)'\s*,/g)].map((m) => m[1]);
}

/**
 * 拆出去的 Worker（账号 styrigx-account、短链 styrigx-share）的路由：归它的路径都归它，网关的接口和页面一条都不抢，
 * 彼此也不抢。
 * @param {string[]} gateway 网关的路由
 * @param {{name:string, label:string, routes:string[], must:string[]}[]} workers
 * @param {string[]} gatewayApis 网关路由表里的接口
 * @param {string[]} pagePaths 主站页面
 */
export function checkSplit(gateway, workers, gatewayApis, pagePaths) {
  const errors = [];
  const all = gateway.concat(...workers.map((w) => w.routes));
  const owner = (p) => {
    const r = pickRoute(all, HOST, p);
    if (r === null) return null;
    const w = workers.find((x) => x.routes.includes(r));
    return w ? w.name : 'gateway';
  };
  for (const w of workers) {
    for (const r of w.routes) {
      if (!r.startsWith(HOST + '/')) errors.push(w.label + '的路由不在 styrigx.com 下：' + r);
      if (gateway.includes(r)) errors.push('两个 Worker 登记了同一条路由：' + r);
      for (const o of workers) if (o !== w && o.routes.includes(r)) errors.push('两个 Worker 登记了同一条路由：' + r);
    }
    if (new Set(w.routes).size !== w.routes.length) errors.push(w.label + '有重复路由');
    for (const p of w.must) {
      if (owner(p) !== w.name) errors.push('应归' + w.label + '却没有：' + p + '（现在 → ' + owner(p) + '）');
    }
  }
  for (const a of gatewayApis) {
    for (const p of [a, a + '?x=1', a + '/']) {
      if (owner(p) !== 'gateway') errors.push('网关的接口被抢走了：' + p + '（现在 → ' + owner(p) + '）');
    }
  }
  for (const p of pagePaths) {
    if (EXEMPT.has(p)) continue;
    if (owner(p) !== 'gateway') errors.push('页面不归网关：' + p + '（现在 → ' + owner(p) + '）');
  }
  for (const p of MUST_ROUTE) {
    if (owner(p) !== 'gateway') errors.push('应归网关却不是：' + p + '（现在 → ' + owner(p) + '）');
  }
  return errors;
}

/**
 * 账号 Worker 的路由（只看账号 Worker；保留给已有单测）。
 * @param {string[]} gateway @param {string[]} account @param {string[]} gatewayApis @param {string[]} pagePaths
 */
export function checkAccount(gateway, account, gatewayApis, pagePaths) {
  return checkSplit(gateway, [{ name: 'account', label: '账号 Worker', routes: account, must: ACCOUNT_MUST }], gatewayApis, pagePaths);
}

/**
 * 网关 + 账号 Worker + 短链 Worker 一起核对。
 * @param {string[]} gateway @param {string[]} account @param {string[]} share @param {string[]} gatewayApis @param {string[]} pagePaths
 */
export function checkWorkers(gateway, account, share, gatewayApis, pagePaths) {
  return checkSplit(gateway, [
    { name: 'account', label: '账号 Worker', routes: account, must: ACCOUNT_MUST },
    { name: 'share', label: '短链 Worker', routes: share, must: SHARE_MUST },
  ], gatewayApis, pagePaths);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const routes = readRoutes(readFileSync(path.join(REPO, 'workers/auth-gateway/wrangler.toml'), 'utf8'));
  const accountRoutes = readRoutes(readFileSync(path.join(REPO, 'workers/account/wrangler.toml'), 'utf8'));
  const shareRoutes = readRoutes(readFileSync(path.join(REPO, 'workers/share/wrangler.toml'), 'utf8'));
  const gatewayApis = readApiRoutes(readFileSync(path.join(REPO, 'workers/auth-gateway/src/routes.js'), 'utf8'));
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
  if (gatewayApis.length < 10) {
    console.error('check-worker-routes.mjs: 没读到网关路由表（workers/auth-gateway/src/routes.js）');
    process.exit(1);
  }
  const errors = check(routes, pages).concat(checkWorkers(routes, accountRoutes, shareRoutes, gatewayApis, pages));
  if (errors.length) {
    for (const e of errors) console.error('✗ ' + e);
    process.exit(1);
  }
  console.log(`check-worker-routes.mjs: 通过（网关 ${routes.length} 条 + 账号 ${accountRoutes.length} 条 + 短链 ${shareRoutes.length} 条路由，${gatewayApis.length} 个网关接口，${pages.length} 个页面）`);
}
