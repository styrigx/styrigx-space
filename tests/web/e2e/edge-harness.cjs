/**
 * 本地「边缘」测试台（edge-flow.spec.js 用）：把线上三站的请求链原样搭在本机。
 *
 * - 浏览器经本地 HTTP 代理（CONNECT）访问真实域名 https://styrigx.com、https://blog.styrigx.com、
 *   https://daymark.styrigx.com；代理把 TLS 接到本机 HTTPS 服务（临时自签证书，
 *   Chromium 用 --ignore-certificate-errors-spki-list 信任它，页面是正常安全上下文，WebAuthn 可用）。
 * - 路由按 workers/auth-gateway/wrangler.toml 和 workers/account/wrangler.toml 的 [[routes]]，用 scripts/lib/cf-routes.mjs
 *   （线上实测的匹配规则：不带 * 的规则遇到查询串不命中；多条命中取最具体的）决定这次请求走网关、账号 Worker 还是直达 Pages。
 *   这样「路由表漏了某种 URL」在本地也能复现，不再被 http-server + page.route 的 mock 掩盖。
 * - 网关 = 仓库里真实的 workers/auth-gateway/src/index.js（真实验签、epoch、Set-Cookie 属性），
 *   env 用临时 Ed25519 钥匙 + 内存 KV；账号 Worker = workers/account/src/index.js（头像 / 云同步 / 数字健康），
 *   服务绑定 AUTH 接到网关真实的 verifier.js（AuthVerifier RPC 里跑的同一份代码）；Pages = web/public（主站，Cache-Control 照 _headers 的 /*）
 *   和两个子站的固定页面。
 * - 访客进入用临时 LockKey：seedTempkey() 在 KV 里签发一把，返回临时码（2026-10-23 取代 Turnstile）。
 * - seedPasskey()：在 KV 里登记一把锁屏通行密钥，返回 CDP WebAuthn.addCredential 用的参数。
 * - 分享短链 Worker = workers/share/src/index.js（路由 workers/share/wrangler.toml：/s/*、/api/share*），D1 用 tests/fixtures/share-d1.mjs，
 *   服务绑定 AUTH 接网关 verifier.js、ISSUER 接网关 src/share-issuer.js（ShareIssuer RPC 里跑的同一份代码）。
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

const REPO = process.env.SGX_EDGE_REPO || path.join(__dirname, '..', '..', '..');
const PROXY_PORT = Number(process.env.SGX_EDGE_PROXY_PORT || 8941);
const HOSTS = ['styrigx.com', 'blog.styrigx.com', 'daymark.styrigx.com'];
/* 别的 Worker 的路由（不在本仓库）：daymark 的句子接口 Worker */
const OTHER_WORKER_ROUTES = ['daymark.styrigx.com/api/*'];

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

function makeKV() {
  const m = new Map();
  return {
    get: async (k, type) => {
      const v = m.get(k);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { m.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    delete: async (k) => { m.delete(k); },
    list: async (opts) => {
      const prefix = (opts && opts.prefix) || '';
      return { keys: [...m.keys()].filter((n) => n.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
    _map: m,
  };
}

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}

const MIME = {
  html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', json: 'application/json',
  xml: 'application/xml', webp: 'image/webp', png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon',
  woff2: 'font/woff2', woff: 'font/woff', txt: 'text/plain',
};

/** 主站 Pages：web/public 静态文件（目录补尾斜杠 308、找不到 404.html），HTML 带 _headers 的 public, max-age=300 */
function mainPages(req) {
  const u = new URL(req.url);
  const pub = path.join(REPO, 'web/public');
  let p = decodeURIComponent(u.pathname);
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

/** 子站 Pages：固定页面（正文带 SUBSITE-CONTENT 标记，测试据此判断「真的进了子站」） */
function subPages(req) {
  const u = new URL(req.url);
  const site = u.hostname.split('.')[0];
  if (u.pathname === '/' || u.pathname.startsWith('/post/') || u.pathname === '/en/' || u.pathname === '/zh/') {
    const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>' + site + '</title></head>' +
      '<body><main id="sub-content">SUBSITE-CONTENT ' + site + ' ' + u.pathname + '</main></body></html>';
    return new Response(html, { status: 200, headers: { 'Content-Type': MIME.html, 'Cache-Control': 'public, max-age=0, must-revalidate' } });
  }
  if (u.pathname === '/manifest.json') return Response.json({ name: site });
  return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
}

function pagesFor(req) {
  return new URL(req.url).hostname === 'styrigx.com' ? mainPages(req) : subPages(req);
}

/**
 * 启动测试台。
 * @returns {Promise<{kv:any, env:any, log:string[], close:()=>Promise<void>, seedPasskey:()=>Promise<any>, seedTempkey:()=>Promise<string>, mintCookie:(role:string)=>Promise<string>, mintTk:()=>Promise<string>}>}
 */
async function startEdge() {
  const { readRoutes, pickRoute } = await dynImport(pathToFileURL(path.join(__dirname, '..', '..', '..', 'scripts/lib/cf-routes.mjs')).href);
  const routes = readRoutes(fs.readFileSync(path.join(REPO, 'workers/auth-gateway/wrangler.toml'), 'utf8'));
  const accountRoutes = readRoutes(fs.readFileSync(path.join(REPO, 'workers/account/wrangler.toml'), 'utf8'));
  const shareRoutes = readRoutes(fs.readFileSync(path.join(REPO, 'workers/share/wrangler.toml'), 'utf8'));
  const allRoutes = routes.concat(accountRoutes, shareRoutes);
  const gateway = (await mod('workers/auth-gateway/src/index.js')).default;
  const account = (await mod('workers/account/src/index.js')).default;
  const verifier = await mod('workers/auth-gateway/src/verifier.js');
  const share = (await mod('workers/share/src/index.js')).default;
  const issuer = await mod('workers/auth-gateway/src/share-issuer.js');
  const { shareD1 } = await mod('tests/fixtures/share-d1.mjs');
  const sessMod = await mod('workers/auth-gateway/functions/_kernel/lock-session.js');
  const tempMod = await mod('workers/auth-gateway/functions/_kernel/lock-tempkey.js');

  const kv = makeKV();
  const lkp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const privPem = derToPem(await crypto.subtle.exportKey('pkcs8', lkp.privateKey), 'PRIVATE KEY');
  const pubPem = derToPem(await crypto.subtle.exportKey('spki', lkp.publicKey), 'PUBLIC KEY');
  const env = {
    SGX_ENV: 'production', SGX_SITE: 'space', SGX_ORIGIN: 'https://styrigx.com', SGX_RP_ID: 'styrigx.com',
    KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv,
    SGX_LOCK_PRIVATE: privPem, SGX_LOCK_PUBLIC: pubPem,
    SGX_ACCOUNT_PRIVATE: privPem, SGX_ACCOUNT_PUBLIC: pubPem,
    SGX_ROOT_KEY: 'edge-test-root-key-not-a-secret', SGX_PW_PEPPER: 'edge-test-pepper',
    ASSETS: { fetch: (input, init) => pagesFor(input instanceof Request ? input : new Request(input, init)) },
  };

  /* 账号 Worker：自己的库（styrigx-account），会话问网关（同 AuthVerifier） */
  const accountKv = makeKV();
  const accountEnv = {
    SGX_ENV: 'production',
    KV_PROFILE: accountKv, KV_SETTINGS_SYNC: accountKv,
    AUTH: {
      lockSession: (c) => verifier.checkLockSession(c, env),
      accountSession: (c, m) => verifier.checkAccountSession(c, env, m),
    },
    ASSETS: env.ASSETS,
  };

  /* 分享短链 Worker：自己的 D1，会话和钥匙都问网关 */
  const shareDb = shareD1();
  const shareEnv = {
    SGX_ENV: 'production',
    D1_SHARE_LINK: shareDb,
    AUTH: {
      lockSession: (c) => verifier.checkLockSession(c, env),
      accountSession: (c, m) => verifier.checkAccountSession(c, env, m),
    },
    ISSUER: {
      createLinkKey: (c, p) => issuer.createLinkKey(c, p, env),
      revokeLinkKey: (c, id, m) => issuer.revokeLinkKey(c, id, env, m),
      openLinkSession: (id, s) => issuer.openLinkSession(id, s, env),
    },
    ASSETS: env.ASSETS,
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
    if (mine && shareRoutes.includes(mine)) {
      const res = await share.fetch(request, shareEnv, { waitUntil() {} });
      log.push(['share', request.method, request.url, res.status]);
      return res;
    }
    if (mine && accountRoutes.includes(mine)) {
      const res = await account.fetch(request, accountEnv, { waitUntil() {} });
      log.push(['account', request.method, request.url, res.status]);
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

  async function seedPasskey() {
    const pk = await mod('workers/auth-gateway/functions/api/lock-passkey.js');
    const layers = await mod('workers/auth-gateway/functions/_kernel/layers.js');
    const kp = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = kp.publicKey.export({ format: 'jwk' });
    const credId = nodeCrypto.randomBytes(32);
    const credIdB64url = credId.toString('base64url');
    await pk.savePasskey(kv, {
      name: 'edge-test', credId: credIdB64url, publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, alg: 'ES256', ext: true },
      signCount: 0, uv: 1, class: 'lock',
    });
    await layers.setLayerConfigured(kv, 'lock');
    const uh = await pk.getUserHandle(kv, 'lock');
    return {
      credentialId: credId.toString('base64'),
      isResidentCredential: true,
      rpId: 'styrigx.com',
      privateKey: kp.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      userHandle: Buffer.from(uh, 'base64url').toString('base64'),
      signCount: 0,
    };
  }

  /** 按当前 epoch 签一个会话 cookie 值（owner / visitor；visitor 还要配 mintTk() 的钥匙票） */
  async function mintCookie(role) {
    const ep = await sessMod.getSessionEpoch(kv);
    return sessMod.signSessionCookie(privPem, ep, role, 'owner');
  }

  /** 签发一把 1 小时的临时 LockKey，返回临时码（XXXX-XXXX-XXXX） */
  async function seedTempkey() {
    const r = await tempMod.createTempkey(kv, env.SGX_PW_PEPPER, { name: 'edge', ms: 3600 * 1000 });
    return r.code;
  }

  /** 钥匙票 sgx-tk 的值（配 mintCookie('visitor') 用；钥匙本身登记在 KV） */
  async function mintTk() {
    const r = await tempMod.createTempkey(kv, env.SGX_PW_PEPPER, { name: 'edge', ms: 3600 * 1000 });
    return tempMod.signTk(env, r.key.id, Date.now() + 3600 * 1000);
  }

  /** 账号会话 cookie 值（sgx-account，by=passkey，当前 account-epoch） */
  async function mintAccount() {
    const acc = await mod('workers/auth-gateway/functions/_kernel/account-session.js');
    const ep = await acc.getAccountEpoch(kv);
    return acc.signAccountTicket(privPem, 'passkey', ep, Date.now());
  }

  /** 清掉 /s/* 的失败计数（D1 share_fail + isolate 内存），限速测试之间不互相影响 */
  async function resetShareLimit() {
    const open = await mod('workers/share/src/open.js');
    open._resetMem();
    if (shareDb.raw) shareDb.raw.exec('DELETE FROM share_fail');
    else await shareDb.prepare('DELETE FROM share_fail WHERE window_start < ?1 AND locked_until < ?1').bind(Number.MAX_SAFE_INTEGER).run();
  }

  async function close() {
    globalThis.fetch = realFetch;
    for (const s of socks) s.destroy();
    await new Promise((r) => tls.close(() => r()));
    await new Promise((r) => proxy.close(() => r()));
  }

  return { kv, env, accountKv, accountEnv, shareDb, shareEnv, log, close, resetShareLimit, seedPasskey, seedTempkey, mintCookie, mintTk, mintAccount };
}

module.exports = { startEdge, LAUNCH, PROXY_PORT, REPO };
