#!/usr/bin/env node
/**
 * 核对网关 Worker 路由登记（workers/auth-gateway/wrangler.toml 的 [[routes]]）、网关转发表（workers/auth-gateway/src/router.js），
 * 账号 Worker styrigx-account（workers/account/wrangler.toml：账号拆分 PR3 起一条路由都没有）、
 * 短链 Worker styrigx-share（workers/share/wrangler.toml，2026-10-24）的更具体路由。
 * 路由匹配按线上实测的规则（space/scripts/lib/cf-routes.mjs）：不带 * 的规则遇到查询串不命中。
 * 以前这里写的是「不看查询串」，于是 styrigx.com/ 这类精确规则看着覆盖了首页，
 * 实际 /?lock=1&return=…（锁屏入口）和子站首页 /?utm=… 都绕过了网关（2026-10-21）。
 * 1. 主站每个 HTML 页面都被路由覆盖，带查询串（?x=1）也覆盖
 * 2. 接口和头像（/api/、/avatar/）被路由覆盖
 * 2b. 账号路径（/api/account、/api/avatar、/api/prefs、/api/wellbeing、/avatar/*，带查询串也算）归网关（方案第 4 节）：
 *     都被网关路由覆盖，且都在网关转发表 src/router.js FORWARDING 里、转给 ACCOUNT；转发表的路径不在网关路由表 API_ROUTES 里（不两处处理）；
 *     账号 Worker 没有任何路由（wrangler.toml 无 [[routes]]）
 * 2c. 分享短链（/s/<码>、/api/share，带查询串也算）归短链 Worker styrigx-share（workers/share/wrangler.toml，2026-10-24）；
 *     网关的每个接口、每个页面、每条转发路径仍归网关
 * 3. 路由不重复，只登记 styrigx.com（旧图志域名的 301 和接口 Worker 的旧路由已于 P4-3 PR-1 删除，别的域名一律报错）
 * 4. 子站（合并 PR3：styrigx.com/blog/ /curio/ /daymark/）必须登记的路径（含各站首页 + 查询串、RSS、站点地图）和三站产物里的每个页面
 *    都归网关（子站关口按路径前缀验会话）
 * 5. 两个子站接口 Worker（workers/curio-core、workers/daymark-core 的 wrangler.toml）：styrigx.com/<站>/api/* 必须登记、归它们，
 *    只许登记这一条；网关不得有更具体的规则抢走，它们也不得抢走网关的接口、主站页面和子站页面
 * 6. 没有公开地址的 Worker（NO_ROUTE_WORKERS：P4-1 起 styrigx-ai）：wrangler.toml 一条路由都没有，workers_dev / preview_urls 关，
 *    只经网关的服务绑定进来
 * 静态资源现在也进网关（整站通配），由 src/app.js 原样回源（主站静态目录、子站静态后缀）；单测 auth-flow-2026-10-21 覆盖。
 *
 * 需要先构建网站（hugo --minify -s space/web）和三站（npm run build:sites），读 space/web/public/、atlas/web/<站>/public/ 下的 .html
 * （子站页面按 /<站>/ 前缀登记；没构建就报错）。
 * 用法：node space/scripts/check-worker-routes.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRoutes, routeMatches, pickRoute } from './lib/cf-routes.mjs';
import { FORWARDING, matchForwarding } from '../../workers/auth-gateway/src/router.js';

export { readRoutes, routeMatches };

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOST = 'styrigx.com';
const PUBLIC_DIR = path.join(REPO, 'space/web/public');
/* 不需要过网关的 HTML：Pages 对不存在的路径直接回 404.html，本来就没人拦 */
const EXEMPT = new Set(['/404.html']);
/* 必须过网关的非页面路径（含锁屏入口本身，带查询串） */
const MUST_ROUTE = ['/api/geo', '/api/lock-session-check',
  '/?lock=1', '/?lock=1&why=no-cookie&return=https%3A%2F%2Fstyrigx.com%2Fblog%2F', '/?return=%2Fsettings%2Fsecurity%2Flock%2F',
  '/zh/?lock=1', '/files-index.json'];
/* 账号路径：必须归网关、在转发表里转给 ACCOUNT（账号 Worker styrigx-account 没有路由） */
const ACCOUNT_MUST = ['/api/account', '/api/account?x=1', '/api/avatar', '/api/prefs', '/api/prefs/', '/api/wellbeing', '/api/wellbeing?d=2026-10-24', '/api/profile', '/api/profile/',
  '/avatar/32.webp', '/avatar/96.webp', '/avatar/192.webp?v=abc', '/avatar/512.webp'];
/* 转发表允许的绑定、门 */
const FORWARD_BINDINGS = new Set(['ACCOUNT']);
const FORWARD_GATES = new Set(['session', 'public']);
/* 必须归短链 Worker（styrigx-share）的路径 */
const SHARE_MUST = ['/s/AAAAAAAAAAAAAAAAAAAAAA', '/s/AAAAAAAAAAAAAAAAAAAAAA/', '/s/AAAAAAAAAAAAAAAAAAAAAA?x=1', '/s/', '/api/share', '/api/share/', '/api/share?x=1'];
/* 子站（合并 PR3）：主域名下的前缀，三站产物都按 /<站>/ 登记 */
export const SUBSITES = ['blog', 'curio', 'daymark'];
/* 子站在主域名上必须归网关的路径（页面、RSS、站点地图都要会话，网关子站关口验） */
const SUBSITE_MUST = ['/blog/', '/blog/?utm=1', '/blog/post/x/', '/blog/post/x/?a', '/blog/tags/x/', '/blog/zh/', '/blog/zh/?a', '/blog/zh/post/x/', '/blog/rss.xml', '/blog/rss.xml?a',
  '/curio/', '/curio/?x=1', '/curio/zh/', '/curio/sitemap.xml', '/curio/sitemap.xml?a',
  '/curio/finds/', '/curio/zh/devices/', '/curio/games/', '/curio/movies/', '/curio/zh/music/',
  '/daymark/', '/daymark/?x=1', '/daymark/zh/', '/daymark/sitemap.xml', '/daymark/sitemap.xml?a'];
/* 两个子站接口 Worker：必须登记的路由和归它们的样例路径（主域名） */
export const CORE_WORKERS = [
  { name: 'curio-core', label: '奇趣接口 Worker（styrigx-curio-core）', dir: 'workers/curio-core', site: 'curio',
    samples: ['/curio/api/links', '/curio/api/icon?id=1', '/curio/api/import', '/curio/api/export', '/curio/api/preview?url=x', '/curio/api/photo?kind=device&id=1',
      '/curio/api/access', '/curio/api/movies', '/curio/api/music', '/curio/api/music-upload?album=1&kind=track', '/curio/api/music-play', '/curio/api/music-stream?t=x&id=1', '/curio/api/music-cover?album=1'] },
  { name: 'daymark-core', label: '日刻接口 Worker（styrigx-daymark-core）', dir: 'workers/daymark-core', site: 'daymark',
    samples: ['/daymark/api/quotes', '/daymark/api/today', '/daymark/api/today?x=1'] },
];

/** space/web/public 里的 a/b/index.html → /a/b/；其他 .html 原样 */
export function htmlToPath(rel) {
  const p = '/' + rel.split(path.sep).join('/');
  return p.endsWith('/index.html') ? p.slice(0, -'index.html'.length) : p;
}

function walk(dir, out = [], root = dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out, root);
    else if (name.endsWith('.html')) out.push(path.relative(root, full));
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
    if (host !== HOST) errors.push('路由不在登记过的域名下：' + r);
  }
  for (const p of SUBSITE_MUST) {
    if (!pickRoute(routes, HOST, p)) errors.push('子站路径没有路由（不过网关）：' + p);
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

/** 网关路由表里的接口路径（workers/auth-gateway/src/router.js 的 ['/api/x', mod]） @param {string} js */
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
 * 两个子站接口 Worker（合并 PR3）：styrigx.com/<站>/api/* 必须登记且归它；
 * 只许登记本站接口前缀（不许写宽）；网关、短链、另一个接口 Worker 都不得抢它的路径；它也不得抢网关的接口、主站页面、子站页面、
 * 子站必须过网关的路径。
 * @param {string[]} gateway 网关的路由
 * @param {string[]} share 短链 Worker 的路由
 * @param {{name:string, label:string, site:string, routes:string[], samples:string[]}[]} cores
 * @param {string[]} gatewayApis 网关路由表里的接口（含转发路径）
 * @param {string[]} pagePaths 主站页面 + 子站页面（/<站>/…）
 */
export function checkCores(gateway, share, cores, gatewayApis, pagePaths) {
  const errors = [];
  const all = gateway.concat(share, ...cores.map((c) => c.routes));
  const owner = (host, p) => {
    const r = pickRoute(all, host, p);
    if (r === null) return null;
    const c = cores.find((x) => x.routes.includes(r));
    if (c) return c.name;
    return share.includes(r) ? 'share' : 'gateway';
  };
  for (const c of cores) {
    const allowed = new Set([HOST + '/' + c.site + '/api/*']);
    if (new Set(c.routes).size !== c.routes.length) errors.push(c.label + '有重复路由');
    if (!c.routes.includes(HOST + '/' + c.site + '/api/*')) errors.push(c.label + '没有登记主域名路由 ' + HOST + '/' + c.site + '/api/*');
    for (const r of c.routes) {
      if (!allowed.has(r)) errors.push(c.label + '只许登记本站接口前缀（' + [...allowed].join('、') + '）：' + r);
      if (gateway.includes(r) || share.includes(r)) errors.push('两个 Worker 登记了同一条路由：' + r);
    }
    for (const p of c.samples) {
      if (owner(HOST, p) !== c.name) errors.push('应归' + c.label + '却没有：' + HOST + p + '（现在 → ' + owner(HOST, p) + '）');
    }
  }
  const notCore = (host, p, what) => {
    const o = owner(host, p);
    if (cores.some((c) => c.name === o)) errors.push(what + '被子站接口 Worker 抢走了：' + host + p + '（现在 → ' + o + '）');
  };
  for (const a of gatewayApis) for (const p of [a, a + '?x=1', a + '/']) notCore(HOST, p, '网关的接口');
  for (const p of pagePaths) if (!EXEMPT.has(p)) notCore(HOST, p, '页面');
  for (const p of SUBSITE_MUST) notCore(HOST, p, '子站路径');
  for (const p of MUST_ROUTE) notCore(HOST, p, '网关路径');
  return errors;
}

/**
 * 账号路径归网关、走转发表；账号 Worker 一条路由都没有（方案第 4 节）。
 * @param {string[]} gateway 网关的路由
 * @param {string[]} account 账号 Worker 的路由（必须为空）
 * @param {string[]} gatewayApis 网关路由表里的接口
 * @param {string[]} pagePaths 主站页面
 * @param {ReadonlyArray<{path:string, binding:string, gate:string}>} [forwarding] 转发表，默认 src/router.js 的 FORWARDING
 */
export function checkAccount(gateway, account, gatewayApis, pagePaths, forwarding = FORWARDING) {
  const errors = [];
  for (const r of account) errors.push('账号 Worker 不许有路由（账号路径归网关、经转发表转发）：' + r);
  if (!forwarding || !forwarding.length) return errors.concat('转发表是空的（workers/auth-gateway/src/router.js）');
  const ruleFor = (p) => forwarding.find((r) => (r.path.endsWith('/') ? p.startsWith(r.path) : (p === r.path || p.startsWith(r.path + '/')))) || null;
  const seen = new Set();
  for (const r of forwarding) {
    if (seen.has(r.path)) errors.push('转发表重复：' + r.path);
    seen.add(r.path);
    if (!FORWARD_BINDINGS.has(r.binding)) errors.push('转发表绑定不认识：' + r.path + ' → ' + r.binding);
    if (!FORWARD_GATES.has(r.gate)) errors.push('转发表门不认识：' + r.path + ' → ' + r.gate);
    if (!r.path.startsWith('/')) errors.push('转发表路径要以 / 开头：' + r.path);
    for (const a of gatewayApis) if (ruleFor(a) === r) errors.push('转发表路径同时在网关路由表 src/router.js API_ROUTES 里：' + a);
  }
  const all = gateway.concat(account);
  for (const p of ACCOUNT_MUST) {
    const r = pickRoute(all, HOST, p);
    if (!r || account.includes(r)) errors.push('账号路径应归网关却不是：' + p + '（现在 → ' + (r ? 'account' : '没有路由') + '）');
    const rule = ruleFor(p.split('?')[0]);
    if (!rule || rule.binding !== 'ACCOUNT') errors.push('账号路径不在转发表里（或没转给 ACCOUNT）：' + p);
  }
  for (const p of pagePaths) {
    if (!EXEMPT.has(p) && ruleFor(p)) errors.push('页面被转发表抢走了：' + p);
  }
  return errors;
}

/**
 * 网关 + 转发表 + 账号 Worker + 短链 Worker（+ 子站接口 Worker，合并 PR3）一起核对。
 * @param {string[]} gateway @param {string[]} account @param {string[]} share @param {string[]} gatewayApis @param {string[]} pagePaths
 * @param {{name:string, label:string, site:string, routes:string[], samples:string[]}[]} [cores] 不给就不核对子站接口 Worker
 */
export function checkWorkers(gateway, account, share, gatewayApis, pagePaths, cores) {
  const fwdPaths = ACCOUNT_MUST.filter((p) => !p.includes('?'));
  const errors = checkAccount(gateway, account, gatewayApis, pagePaths).concat(
    checkSplit(gateway, [{ name: 'share', label: '短链 Worker', routes: share, must: SHARE_MUST }], gatewayApis.concat(fwdPaths), pagePaths),
  );
  return cores ? errors.concat(checkCores(gateway, share, cores, gatewayApis.concat(fwdPaths, SHARE_MUST), pagePaths)) : errors;
}

export { matchForwarding };

/** 没有公开地址的 Worker：只经网关服务绑定进来（P4-1 起登记 styrigx-ai） */
export const NO_ROUTE_WORKERS = Object.freeze([
  Object.freeze({ name: 'styrigx-ai', dir: 'workers/ai', binding: 'AI_SERVICE' }),
]);

/**
 * 核对没有公开地址的 Worker：0 条路由、workers_dev = false、preview_urls = false。
 * @param {{name:string, toml:string}[]} list
 */
export function checkNoRoutes(list) {
  const errors = [];
  for (const w of list) {
    const routes = readRoutes(w.toml);
    for (const r of routes) errors.push(w.name + ' 不许有路由（只经网关服务绑定进来）：' + r);
    const body = w.toml.replace(/^\s*#.*$/gm, '');
    if (!/^workers_dev\s*=\s*false\s*$/m.test(body)) errors.push(w.name + ' 要 workers_dev = false');
    if (!/^preview_urls\s*=\s*false\s*$/m.test(body)) errors.push(w.name + ' 要 preview_urls = false');
    if (/^route\s*=/m.test(body)) errors.push(w.name + ' 不许有 route = ');
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const routes = readRoutes(readFileSync(path.join(REPO, 'workers/auth-gateway/wrangler.toml'), 'utf8'));
  const accountRoutes = readRoutes(readFileSync(path.join(REPO, 'workers/account/wrangler.toml'), 'utf8'));
  const shareRoutes = readRoutes(readFileSync(path.join(REPO, 'workers/share/wrangler.toml'), 'utf8'));
  const gatewayApis = readApiRoutes(readFileSync(path.join(REPO, 'workers/auth-gateway/src/router.js'), 'utf8'));
  const cores = CORE_WORKERS.map((c) => ({ ...c, routes: readRoutes(readFileSync(path.join(REPO, c.dir, 'wrangler.toml'), 'utf8')) }));
  let pages;
  try {
    pages = walk(PUBLIC_DIR).map(htmlToPath);
  } catch (e) {
    console.error('check-worker-routes.mjs: 读不到 space/web/public，先运行 hugo --minify -s space/web');
    process.exit(1);
  }
  /* 子站页面（合并 PR3）：atlas/web/<站>/public 下的 .html → /<站>/… */
  let subPages = [];
  for (const site of SUBSITES) {
    const dir = path.join(REPO, 'atlas', 'web', site, 'public');
    let list;
    try { list = walk(dir); } catch (e) { list = []; }
    if (!list.length) {
      console.error(`check-worker-routes.mjs: atlas/web/${site}/public 里没有 HTML，先运行 npm run build:sites`);
      process.exit(1);
    }
    subPages = subPages.concat(list.map((rel) => '/' + site + htmlToPath(rel)));
  }
  if (!pages.length) {
    console.error('check-worker-routes.mjs: space/web/public 里没有 HTML，先构建网站');
    process.exit(1);
  }
  if (gatewayApis.length < 10) {
    console.error('check-worker-routes.mjs: 没读到网关路由表（workers/auth-gateway/src/router.js）');
    process.exit(1);
  }
  const allPages = pages.concat(subPages);
  const noRoute = NO_ROUTE_WORKERS.map((w) => ({ name: w.name, toml: readFileSync(path.join(REPO, w.dir, 'wrangler.toml'), 'utf8') }));
  const errors = check(routes, allPages).concat(checkWorkers(routes, accountRoutes, shareRoutes, gatewayApis, allPages, cores), checkNoRoutes(noRoute));
  if (errors.length) {
    for (const e of errors) console.error('✗ ' + e);
    process.exit(1);
  }
  const coreCount = cores.map((c) => c.name + ' ' + c.routes.length + ' 条').join(' + ');
  console.log(`check-worker-routes.mjs: 通过（网关 ${routes.length} 条 + 账号 ${accountRoutes.length} 条 + 短链 ${shareRoutes.length} 条 + ${coreCount}路由，${NO_ROUTE_WORKERS.map((w) => w.name).join('、')} 0 条，${gatewayApis.length} 个网关接口，转发表 ${FORWARDING.length} 条，主站 ${pages.length} 个页面 + 子站 ${subPages.length} 个页面）`);
}
