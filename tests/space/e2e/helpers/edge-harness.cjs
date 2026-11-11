/**
 * 本地「边缘」测试台（edge-flow.spec.js 用）：把线上三站的请求链原样搭在本机。
 *
 * - 浏览器经本地 HTTP 代理（CONNECT）访问真实域名 https://styrigx.com（含子站 /blog/ /curio/ /daymark/，合并 PR3；旧图志域名的 301 已于 P4-3 PR-1 删除，不再接）；
 *   代理把 TLS 接到本机 HTTPS 服务（临时自签证书，
 *   Chromium 用 --ignore-certificate-errors-spki-list 信任它，页面是正常安全上下文，WebAuthn 可用）。
 * - 路由按 workers/space-core/wrangler.toml、workers/account/wrangler.toml 的 [[routes]]，用 space/scripts/lib/cf-routes.mjs
 *   （线上实测的匹配规则：不带 * 的规则遇到查询串不命中；多条命中取最具体的）决定这次请求走站点核心 Worker 还是直达 Pages。
 *   账号 Worker 账号拆分 PR3 起没有路由（读到有就照样挂上，测试会因此红），只经网关的服务绑定 ACCOUNT / ACCOUNT_VERIFIER 进来。
 *   这样「路由表漏了某种 URL」在本地也能复现，不再被 http-server + page.route 的 mock 掩盖。
 * - 网关 = 仓库里真实的 workers/space-core/src/app.js，env 只给正式网关绑的东西（D1_SPACE、站点变量；v6 P4 起没有任何 SGX_SPACE_* 钥匙）；
 *   服务绑定 ACCOUNT / ACCOUNT_VERIFIER 接账号 Worker 命名入口的实现（workers/account/src/rpc/account-service.js serviceFetch /
 *   rpc/account-verifier.js checkAdmit / checkAuditRoot，AccountService / AccountVerifier 里跑的同一份代码）。
 *   账号 Worker 自己的账号密码 pepper 和库（tests/workers/account/_d1.mjs：account_* 表 + 云同步），
 *   头像 KV_PROFILE 用内存 KV。转发到账号的每一跳在 log 里另记一条 'account'。
 *   Pages = 单树：space/web/public（主站，Cache-Control 照 _headers 的 /*）+ /blog/ /curio/ /daymark/ 下子站的固定页面。
 *   cloudflare:workers（rpc/*.js 引入）用 tests/workers/account/_cf-workers.mjs 的替身。
 * - mintV6()：往账号库写 styrigx（uid 1000）和一行 v6 会话，返回 sgx-session 的值（测试里直接塞 cookie，省掉每次走一遍 su）。
 * v6 P4（定稿 v5.3 §十三）：进站会话 / 锁侧复验票 / 分享短链 / 旧账号会话随后端删除，mintCookie / mintReauth / seedShareLink /
 *   resetShareLimit / mintAccount / 进站通行密钥 seedPasskey 一并拿掉。
 */
const https = require('node:https');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
/* 内存 KV、DER→PEM：和 Worker 单测同一份（tests/workers/_harness.cjs） */
const { makeKV, makeAuthD1 } = require('../../../workers/_harness.cjs');

const REPO = process.env.SGX_EDGE_REPO || path.join(__dirname, '..', '..', '..', '..');
const PROXY_PORT = Number(process.env.SGX_EDGE_PROXY_PORT || 8941);
const HOSTS = ['styrigx.com'];
/* 别的 Worker 的路由：日刻、奇趣的接口 Worker（workers/daymark-core、workers/curio-core 的 wrangler.toml；测试台里一律 404，只为让路由按线上取最具体的） */
const OTHER_WORKER_TOMLS = ['workers/daymark-core/wrangler.toml', 'workers/curio-core/wrangler.toml'];

/* ---------- 证书（模块加载时同步生成，spec 的 test.use 要用 SPKI） ---------- */
const CERT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgx-edge-'));
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
  '-keyout', path.join(CERT_DIR, 'k.pem'), '-out', path.join(CERT_DIR, 'c.pem'), '-days', '2',
  '-subj', '/CN=styrigx.com', '-addext', 'subjectAltName=DNS:styrigx.com,DNS:*.styrigx.com',
], { stdio: 'ignore' });
const CERT = fs.readFileSync(path.join(CERT_DIR, 'c.pem'));
const KEY = fs.readFileSync(path.join(CERT_DIR, 'k.pem'));
const SPKI = nodeCrypto.createHash('sha256')
  .update(new nodeCrypto.X509Certificate(CERT).publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64');

/** Playwright 启动参数：走本地代理 + 信任临时证书 */
const LAUNCH = {
  proxy: { server: 'http://127.0.0.1:' + PROXY_PORT },
  args: ['--ignore-certificate-errors-spki-list=' + SPKI],
};

const dynImport = new Function('u', 'return ' + 'im' + 'port(u)');
const mod = (rel) => dynImport(pathToFileURL(path.join(REPO, rel)).href);

const MIME = {
  html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', json: 'application/json',
  xml: 'application/xml', webp: 'image/webp', png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon',
  woff2: 'font/woff2', woff: 'font/woff', txt: 'text/plain',
};

/** _redirects 里站内的整路径 301（没有 * / :splat 的行，去处以 / 开头；同 Cloudflare Pages：不带原查询串）。2026-11-08 旧账号页 /account/* → 首页 #acct=<层> 靠它 */
let redirects = null;
function pageRedirect(p) {
  if (!redirects) {
    redirects = new Map();
    try {
      for (const line of fs.readFileSync(path.join(REPO, 'space/web/static/_redirects'), 'utf8').split('\n')) {
        const m = /^(\/\S*)\s+(\/\S*)\s+(30[1278])\s*$/.exec(line.trim());
        if (m && !/[*:]/.test(m[1])) redirects.set(m[1], [m[2], Number(m[3])]);
      }
    } catch (e) {}
  }
  return redirects.get(p) || null;
}

/** 主站 Pages：space/web/public 静态文件（目录补尾斜杠 308、找不到 404.html），HTML 带 _headers 的 public, max-age=300；_redirects 的整路径 301 */
function mainPages(req) {
  const u = new URL(req.url);
  const pub = path.join(REPO, 'space/web/public');
  let p = decodeURIComponent(u.pathname);
  const rd = pageRedirect(p);
  if (rd) return new Response(null, { status: rd[1], headers: { Location: rd[0] } });
  let file = path.join(pub, p);
  if (!file.startsWith(pub)) return new Response('bad', { status: 400 });
  try {
    if (fs.statSync(file).isDirectory()) {
      if (!p.endsWith('/')) return new Response(null, { status: 308, headers: { Location: p + '/' + u.search } });
      file = path.join(file, 'index.html');
    }
  } catch (e) {}
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return new Response(fs.readFileSync(path.join(pub, '404.html')), {
      status: 404, headers: { 'Content-Type': MIME.html, 'Cache-Control': 'public, max-age=300' },
    });
  }
  const ext = path.extname(file).slice(1).toLowerCase();
  const cc = /^\/(css|js|fav)\//.test(p) ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
  return new Response(fs.readFileSync(file), { status: 200, headers: { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cc } });
}

/** 单树里的子站：各站固定页面（正文带 SUBSITE-CONTENT 标记，测试据此判断「真的进了子站」） */
function subPages(req) {
  const u = new URL(req.url);
  const m = /^\/(blog|curio|daymark)(\/.*)$/.exec(u.pathname);
  const site = m ? m[1] : 'atlas';
  const rest = m ? m[2] : u.pathname;
  if (m && (rest === '/' || rest.startsWith('/post/') || rest === '/en/' || rest === '/zh/')) {
    const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>' + site + '</title></head>' +
      '<body><main id="sub-content">SUBSITE-CONTENT ' + site + ' ' + u.pathname + '</main></body></html>';
    return new Response(html, { status: 200, headers: { 'Content-Type': MIME.html, 'Cache-Control': 'public, max-age=0, must-revalidate' } });
  }
  if (u.pathname === '/blog/manifest.json') return Response.json({ name: site });
  return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
}

/* 合并 PR3：一个 Pages（styrigx-space）一棵树，子站在 /blog/ /curio/ /daymark/ 下 */
function pagesFor(req) {
  const u = new URL(req.url);
  if (u.hostname !== 'styrigx.com') return new Response('no pages on ' + u.hostname, { status: 421, headers: { 'Content-Type': 'text/plain' } });
  return /^\/(blog|curio|daymark)(\/|$)/.test(u.pathname) ? subPages(req) : mainPages(req);
}

/**
 * 启动测试台。
 * @returns {Promise<{kv:any, env:any, accountKv:any, accountEnv:any, log:string[], close:()=>Promise<void>, mintV6:()=>Promise<string>}>}
 */
async function startEdge() {
  const { readRoutes, pickRoute } = await dynImport(pathToFileURL(path.join(__dirname, '..', '..', '..', '..', 'space/scripts/lib/cf-routes.mjs')).href);
  const routes = readRoutes(fs.readFileSync(path.join(REPO, 'workers/space-core/wrangler.toml'), 'utf8'));
  const accountRoutes = readRoutes(fs.readFileSync(path.join(REPO, 'workers/account/wrangler.toml'), 'utf8'));
  const allRoutes = routes.concat(accountRoutes);
  const OTHER_WORKER_ROUTES = OTHER_WORKER_TOMLS.flatMap((f) => readRoutes(fs.readFileSync(path.join(REPO, f), 'utf8')));
  const gateway = (await mod('workers/space-core/src/app.js')).default;
  await mod('tests/workers/account/_cf-workers.mjs'); /* cloudflare:workers 替身，要在 import rpc/*.js 之前 */
  const accountEntry = { ...(await mod('workers/account/src/rpc/account-service.js')), ...(await mod('workers/account/src/rpc/account-verifier.js')) };
  const account = (await mod('workers/account/src/app.js')).default; /* 默认 fetch：一律 404（只在 toml 里还有路由时用到） */
  const { sessionIdOf } = await mod('workers/account/src/core/identity-session.js');
  const { STYRIGX_DEFAULT_GROUPS } = await mod('workers/account/src/core/groups.js');

  const kv = makeKV();
  const d1 = makeAuthD1(); /* 网关 D1（D1_SPACE） */
  const assets = { fetch: (input, init) => pagesFor(input instanceof Request ? input : new Request(input, init)) };

  /* 账号 Worker：自己的密码 pepper 和库（styrigx-account：一个绑定 D1_ACCOUNT），不绑任何网关的东西 */
  const accountKv = makeKV();
  const { makeAccountD1 } = await mod('tests/workers/account/_d1.mjs');
  const accountD1 = makeAccountD1(); /* 跑 workers/account/migrations/*.sql：account_* 表 + 设置同步 settings_sync */
  const accountEnv = {
    SGX_ENV: 'production', SGX_ORIGIN: 'https://styrigx.com', SGX_RP_ID: 'styrigx.com',
    D1_ACCOUNT: accountD1, KV_PROFILE: accountKv,
    SGX_ACCOUNT_PASSWORD_PEPPER: 'edge-test-account-pepper',
    ASSETS: assets,
  };
  /* 账号 Worker 的两个命名入口，形状同服务绑定（只给网关；短链 Worker 不绑账号） */
  const ACCOUNT = {
    fetch: async (req) => {
      const res = await accountEntry.serviceFetch(req, accountEnv, { waitUntil() {} });
      log.push(['account', req.method, req.url, res.status]);
      return res;
    },
  };
  /* 同正式 AccountVerifier（v6 P4 起只有 admit / auditRoot） */
  const ACCOUNT_VERIFIER = {
    admit: (c, m, p, o) => accountEntry.checkAdmit(accountEnv, c, m, p, o),
    auditRoot: (c, cmd, a) => accountEntry.checkAuditRoot(accountEnv, c, cmd, a),
  };

  /* 站点核心 Worker：只绑正式 wrangler.toml 里有的（D1_SPACE、ACCOUNT / ACCOUNT_VERIFIER；v6 P4 起没有 SGX_SPACE_*） */
  const env = {
    SGX_ENV: 'production', SGX_SITE: 'space', SGX_ORIGIN: 'https://styrigx.com', SGX_RP_ID: 'styrigx.com',
    D1_SPACE: d1,
    ACCOUNT, ACCOUNT_VERIFIER,
    ASSETS: assets,
  };

  const realFetch = globalThis.fetch;

  /** 每个请求：[走哪条路, 方法, URL, 状态] */
  const log = [];
  async function edge(request) {
    const u = new URL(request.url);
    const pq = u.pathname + u.search;
    const other = pickRoute(OTHER_WORKER_ROUTES, u.hostname, pq);
    const mine = pickRoute(allRoutes, u.hostname, pq);
    if (other && (!mine || other.length > mine.length)) {
      log.push(['other', request.method, request.url, 404]);
      return Response.json({ ok: false, error: 'not-found' }, { status: 404 });
    }
    if (mine && accountRoutes.includes(mine)) {
      const res = await account.fetch(request, accountEnv, { waitUntil() {} });
      log.push(['account-route', request.method, request.url, res.status]);
      return res;
    }
    if (mine) {
      const res = await gateway.fetch(request, env, { waitUntil() {} });
      log.push(['worker', request.method, request.url, res.status]);
      return res;
    }
    const res = await pagesFor(request);
    log.push(['pages', request.method, request.url, res.status]);
    return res;
  }

  const tls = https.createServer({ cert: CERT, key: KEY }, async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.startsWith(':')) continue;
        headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
      const host = String(req.headers.host || '').split(':')[0];
      const request = new Request('https://' + host + req.url, {
        method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, redirect: 'manual',
      });
      const r = await edge(request);
      const out = {};
      r.headers.forEach((v, k) => { if (k !== 'set-cookie' && k !== 'content-encoding' && k !== 'content-length') out[k] = v; });
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      if (sc.length) out['set-cookie'] = sc;
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, out);
      res.end(req.method === 'HEAD' ? undefined : buf);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('edge harness error: ' + (e && e.stack));
    }
  });
  await new Promise((r) => tls.listen(0, '127.0.0.1', r));
  const tlsPort = tls.address().port;

  const proxy = http.createServer((req, res) => { res.writeHead(502); res.end(); });
  proxy.on('connect', (req, sock, head) => {
    const host = String(req.url || '').split(':')[0];
    if (!HOSTS.includes(host)) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const up = net.connect(tlsPort, '127.0.0.1', () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  const socks = new Set();
  proxy.on('connection', (s) => { socks.add(s); s.on('close', () => socks.delete(s)); });
  tls.on('connection', (s) => { socks.add(s); s.on('close', () => socks.delete(s)); });
  await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));

  /** v6 会话（sgx-session 的值）：库里写 styrigx（uid 1000，默认组）和一行 30 天的会话；每次一个新令牌 */
  async function mintV6() {
    const raw = accountD1.raw;
    raw.prepare("INSERT OR IGNORE INTO account_users (uid, name, avatar, expires_at, epoch, disabled, created_at) VALUES (1000, 'styrigx', '', 0, 0, 0, 1)").run();
    for (const g of STYRIGX_DEFAULT_GROUPS) raw.prepare('INSERT OR IGNORE INTO account_user_groups (uid, grp, added_at) VALUES (1000, ?, 1)').run(g);
    const token = nodeCrypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    raw.prepare('INSERT INTO account_sessions (id, uid, epoch, rescue, created_at, expires_at, renewed_at) VALUES (?, 1000, 0, 0, ?, ?, ?)').run(await sessionIdOf(token), now, now + 30 * 86400e3, now);
    return token;
  }

  async function close() {
    globalThis.fetch = realFetch;
    for (const s of socks) s.destroy();
    await new Promise((r) => tls.close(() => r()));
    await new Promise((r) => proxy.close(() => r()));
  }

  return { kv, env, accountKv, accountEnv, log, close, mintV6 };
}

module.exports = { startEdge, LAUNCH, PROXY_PORT, REPO };
