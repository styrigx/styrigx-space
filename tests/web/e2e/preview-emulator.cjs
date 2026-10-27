/**
 * 本地模拟 passkey-e2e 预览站，并给每一次 KV 操作记账。
 *
 * 用途：
 * 1. 不碰 Cloudflare 就能跑 SGX_TEST_SUITE=passkey 的 17 条用例：本地，以及 CI 里 pull_request 的 passkey-e2e
 *    （.github/workflows/deploy.yml「Start local preview emulator」，固定 --port 8788、--root-key / --pepper 每次现生成；
 *    main 的 push / 手动运行仍打真实预览站）；
 * 2. 统计一次运行到底花了多少 KV 操作（读 / 写 / 删 / 列），按「谁发的」（网关 = 预览站上的应用代码；
 *    rest = 测试进程和 CI 步骤经 Cloudflare REST 发的）和键前缀分开。scripts/kv-budget.mjs 里的
 *    每次运行估算就按这里量出来的数定。
 *
 * 模拟的东西：
 * - 网关：仓库里真实的 workers/auth-gateway/src/index.js（和 CI 打成 _worker.js 的是同一份代码），SGX_ENV=preview，
 *   env.ASSETS 读 web/public（先 hugo 构建生产版）。
 * - KV：一个内存 KV（KV_LOCK_DOOR 与 KV_ACCOUNT_LOGIN 绑同一个，和预览 wrangler.toml 一样），支持 expirationTtl / expiration，
 *   列表结果带 expiration（和 Cloudflare REST 一样）。默认不模拟边缘最终一致：读写立刻可见，所以重置开关的轮询只要一次，
 *   真实 CI 里会多几次（README 里的估算按上限算）。
 * - 可选的「读到旧值」（--stale-ms N [--stale-keys 前缀,前缀]）：网关对匹配前缀的键 get 时，在该键被写 / 删后的 N 毫秒内
 *   仍返回写之前的值（窗口内再写不延长窗口、不换旧值，像边缘缓存到期前一直拿着旧值）。用来在本地复现真实 KV
 *   写后读不到（边缘缓存最长约 60 秒）的用例；只影响网关读，REST 读和 list 不受影响。默认前缀 lock-epoch,lock-passkey-index。
 * - D1：node:sqlite 内存库，实现 prepare().bind().run() / first() / all() 这几个网关用到的方法。
 * - Cloudflare KV REST：/client/v4/accounts/<a>/storage/kv/namespaces/<id>/values/<key>（GET/PUT/DELETE）、/keys（列表，
 *   prefix / cursor / limit）、/bulk/delete（POST，按 Cloudflare 的计费口径每个键算一次删除）。测试进程用
 *   SGX_TEST_CF_API=http://127.0.0.1:<port>/client/v4 指过来。
 * - /__kv/stats（GET）：当前计数；/__kv/stats/reset（POST）清零计数（不清数据）；/__kv/dump（GET）：全部键和过期时间。
 *
 * 运行：
 *   node tests/web/e2e/preview-emulator.cjs [--port 8788] [--state /tmp/pv-kv.json] [--root-key K] [--pepper P] [--stale-ms N [--stale-keys …]]
 *   --state：启动时从该文件恢复 KV 和 D1（模拟「上一次运行留下的预览 KV」），退出（SIGINT/SIGTERM）时写回。
 *   然后：SGX_TEST_SUITE=passkey SGX_TEST_BASE=http://localhost:8788 SGX_TEST_ROOT_KEY=K \
 *         SGX_TEST_CF_API=http://127.0.0.1:8788/client/v4 SGX_TEST_CF_TOKEN=x SGX_TEST_CF_ACCOUNT=x SGX_TEST_PREVIEW_KV_ID=local CI=1 \
 *         npx playwright test --config=tests/config/playwright.config.js
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.join(__dirname, '..', '..', '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const PORT = Number(arg('port', 8788));
const STATE = arg('state', '');
const ROOT_KEY = arg('root-key', 'local-preview-root-key');
const PEPPER = arg('pepper', 'local-preview-pepper');
const STALE_MS = Number(arg('stale-ms', 0)) || 0;
const STALE_KEYS = String(arg('stale-keys', 'lock-epoch,lock-passkey-index')).split(',').map((x) => x.trim()).filter(Boolean);
const dynImport = new Function('u', 'return ' + 'im' + 'port(u)');
const mod = (rel) => dynImport(pathToFileURL(path.join(REPO, rel)).href);

/* ---------- 记账 ---------- */
const stats = { app: {}, rest: {} };
function prefixOf(key) {
  const m = String(key).match(/^[a-z-]+(:|$)/);
  return m ? m[0] : String(key);
}
function count(src, op, key, n) {
  const s = stats[src];
  const p = op === 'list' ? 'list:' + (key || '') : prefixOf(key);
  s[op] = (s[op] || 0) + (n || 1);
  const byKey = (s.byPrefix = s.byPrefix || {});
  byKey[op + ' ' + p] = (byKey[op + ' ' + p] || 0) + (n || 1);
}

/* ---------- KV ---------- */
/** @type {Map<string, {v: string, exp: number|null}>} 过期时间单位：秒（与 Cloudflare 一致） */
const store = new Map();
const nowSec = () => Math.floor(Date.now() / 1000);
function live(k) {
  const e = store.get(k);
  if (!e) return null;
  if (e.exp && e.exp <= nowSec()) { store.delete(k); return null; }
  return e;
}
function expOf(opts) {
  if (!opts) return null;
  if (opts.expiration) return Number(opts.expiration);
  if (opts.expirationTtl) return nowSec() + Number(opts.expirationTtl);
  return null;
}
function listKeys(prefix, cursor, limit) {
  const names = [...store.keys()].filter((n) => live(n) && n.startsWith(prefix || '')).sort();
  const start = cursor ? Number(cursor) : 0;
  const page = names.slice(start, start + limit);
  const next = start + limit < names.length ? String(start + limit) : '';
  return {
    keys: page.map((name) => {
      const e = store.get(name);
      return e.exp ? { name, expiration: e.exp } : { name };
    }),
    cursor: next,
    list_complete: !next,
  };
}
/* ---------- 可选：写后一段时间内网关读到旧值（--stale-ms） ---------- */
/** @type {Map<string, {prev: {v: string, exp: number|null}|null, until: number}>} */
const staleWin = new Map();
const staleMatch = (k) => STALE_MS > 0 && STALE_KEYS.some((p) => String(k).startsWith(p));
/** 写 / 删之前调用：窗口外记下当前值作为「边缘缓存里的旧值」；窗口内不动 */
function noteWrite(k) {
  if (!staleMatch(k)) return;
  const w = staleWin.get(k);
  if (w && w.until > Date.now()) return;
  staleWin.set(k, { prev: live(k), until: Date.now() + STALE_MS });
}
function staleRead(k) {
  const w = staleMatch(k) ? staleWin.get(k) : null;
  if (!w || w.until <= Date.now()) return undefined;
  stats.staleReads = (stats.staleReads || 0) + 1;
  return w.prev;
}
const appKV = {
  get: async (k, type) => {
    count('app', 'read', k);
    const old = staleRead(k);
    const e = old === undefined ? live(k) : old;
    if (!e) return null;
    const t = typeof type === 'object' && type ? type.type : type;
    return t === 'json' ? JSON.parse(e.v) : e.v;
  },
  put: async (k, v, opts) => {
    count('app', 'write', k);
    noteWrite(k);
    store.set(k, { v: typeof v === 'string' ? v : JSON.stringify(v), exp: expOf(opts) });
  },
  delete: async (k) => {
    count('app', 'delete', k);
    noteWrite(k);
    store.delete(k);
  },
  list: async (opts) => {
    const prefix = (opts && opts.prefix) || '';
    count('app', 'list', prefix);
    return listKeys(prefix, opts && opts.cursor, Math.min(1000, (opts && opts.limit) || 1000));
  },
};

/* ---------- D1（node:sqlite） ---------- */
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
const d1 = {
  prepare(sql) {
    let args = [];
    const stmt = {
      bind(...a) { args = a; return stmt; },
      async run() {
        const r = db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(r.changes || 0) } };
      },
      async first() {
        const r = db.prepare(sql).get(...args);
        return r === undefined ? null : Object.assign({}, r);
      },
      async all() {
        return { success: true, results: db.prepare(sql).all(...args).map((r) => Object.assign({}, r)) };
      },
    };
    return stmt;
  },
};

/* ---------- 状态持久化（模拟跨运行保留的预览 KV / D1） ---------- */
function loadState() {
  if (!STATE || !fs.existsSync(STATE)) return;
  const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  for (const [k, e] of Object.entries(s.kv || {})) store.set(k, e);
  db.exec('CREATE TABLE IF NOT EXISTS recovery_switch (hash TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)');
  for (const r of s.recovery_switch || []) {
    db.prepare('INSERT OR REPLACE INTO recovery_switch (hash, first_seen, used) VALUES (?, ?, ?)').run(r.hash, r.first_seen, r.used);
  }
}
function saveState() {
  if (!STATE) return;
  const kv = {};
  for (const k of store.keys()) if (live(k)) kv[k] = store.get(k);
  let rows = [];
  try { rows = db.prepare('SELECT hash, first_seen, used FROM recovery_switch').all().map((r) => Object.assign({}, r)); } catch (e) {}
  fs.writeFileSync(STATE, JSON.stringify({ kv, recovery_switch: rows }));
}

/* ---------- 静态文件（env.ASSETS） ---------- */
const MIME = {
  html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', json: 'application/json', xml: 'application/xml',
  webp: 'image/webp', png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon', woff2: 'font/woff2', txt: 'text/plain',
};
const PUB = path.join(REPO, 'web/public');
function assets(req) {
  const u = new URL(req.url);
  const p = decodeURIComponent(u.pathname);
  let file = path.join(PUB, p);
  if (!file.startsWith(PUB)) return new Response('bad', { status: 400 });
  try {
    if (fs.statSync(file).isDirectory()) {
      if (!p.endsWith('/')) return new Response(null, { status: 308, headers: { Location: p + '/' + u.search } });
      file = path.join(file, 'index.html');
    }
  } catch (e) {}
  if (!fs.existsSync(file)) {
    return new Response(fs.readFileSync(path.join(PUB, '404.html')), { status: 404, headers: { 'Content-Type': MIME.html } });
  }
  const ext = path.extname(file).slice(1).toLowerCase();
  return new Response(fs.readFileSync(file), { status: 200, headers: { 'Content-Type': MIME[ext] || 'application/octet-stream' } });
}

/* ---------- Cloudflare KV REST ---------- */
function cfJson(result, extra) {
  return Response.json(Object.assign({ success: true, errors: [], messages: [], result }, extra || {}));
}
async function cfRest(req) {
  const u = new URL(req.url);
  const m = u.pathname.match(/^\/client\/v4\/accounts\/[^/]+\/storage\/kv\/namespaces\/[^/]+(\/.*)$/);
  if (!m) return new Response('not found', { status: 404 });
  const rest = m[1];
  const vm = rest.match(/^\/values\/(.+)$/);
  if (vm) {
    const key = decodeURIComponent(vm[1]);
    if (req.method === 'PUT') {
      count('rest', 'write', key);
      noteWrite(key);
      const exp = u.searchParams.get('expiration_ttl') ? nowSec() + Number(u.searchParams.get('expiration_ttl')) : null;
      store.set(key, { v: await req.text(), exp });
      return cfJson(null);
    }
    if (req.method === 'DELETE') {
      count('rest', 'delete', key);
      noteWrite(key);
      store.delete(key);
      return cfJson(null);
    }
    count('rest', 'read', key);
    const e = live(key);
    return e ? new Response(e.v) : Response.json({ success: false, errors: [{ code: 10009, message: 'key not found' }] }, { status: 404 });
  }
  if (rest === '/keys' && req.method === 'GET') {
    const prefix = u.searchParams.get('prefix') || '';
    count('rest', 'list', prefix);
    const r = listKeys(prefix, u.searchParams.get('cursor'), Math.min(1000, Number(u.searchParams.get('limit') || 1000)));
    return cfJson(r.keys, { result_info: { count: r.keys.length, cursor: r.cursor } });
  }
  if (rest === '/bulk/delete' && req.method === 'POST') {
    const names = await req.json();
    for (const n of names) { count('rest', 'delete', n); noteWrite(n); store.delete(n); }
    return cfJson({ successful_key_count: names.length, unsuccessful_keys: [] });
  }
  return new Response('not found', { status: 404 });
}

async function main() {
  loadState();
  const gateway = (await mod('workers/auth-gateway/src/index.js')).default;
  const lkp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const akp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pem = async (k, kind, label) => {
    const b64 = Buffer.from(await crypto.subtle.exportKey(kind, k)).toString('base64');
    return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
  };
  const origin = 'http://localhost:' + PORT;
  const env = {
    SGX_ENV: 'preview', SGX_SITE: 'space', SGX_ORIGIN: origin, SGX_RP_ID: 'localhost',
    KV_LOCK_DOOR: appKV, KV_ACCOUNT_LOGIN: appKV, D1_LOCK_RESET: d1,
    SGX_LOCK_PRIVATE: await pem(lkp.privateKey, 'pkcs8', 'PRIVATE KEY'), SGX_LOCK_PUBLIC: await pem(lkp.publicKey, 'spki', 'PUBLIC KEY'),
    SGX_ACCOUNT_PRIVATE: await pem(akp.privateKey, 'pkcs8', 'PRIVATE KEY'), SGX_ACCOUNT_PUBLIC: await pem(akp.publicKey, 'spki', 'PUBLIC KEY'),
    SGX_ROOT_KEY: ROOT_KEY, SGX_PW_PEPPER: PEPPER,
    ASSETS: { fetch: (input, init) => assets(input instanceof Request ? input : new Request(input, init)) },
  };

  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      headers.set('CF-Connecting-IP', '203.0.113.7');
      const request = new Request(origin + req.url, {
        method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, redirect: 'manual',
      });
      let r;
      if (req.url.startsWith('/__kv/stats/reset')) { stats.app = {}; stats.rest = {}; delete stats.staleReads; r = Response.json({ ok: true }); }
      else if (req.url.startsWith('/__kv/stats')) r = Response.json(stats);
      else if (req.url.startsWith('/__kv/dump')) {
        const out = {};
        for (const k of [...store.keys()].sort()) if (live(k)) out[k] = store.get(k).exp;
        r = Response.json(out);
      } else if (req.url.startsWith('/client/v4/')) r = await cfRest(request);
      else r = await gateway.fetch(request, env, { waitUntil() {} });
      const out = {};
      r.headers.forEach((v, k) => { if (k !== 'set-cookie' && k !== 'content-encoding' && k !== 'content-length') out[k] = v; });
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      if (sc.length) out['set-cookie'] = sc;
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, out);
      res.end(req.method === 'HEAD' ? undefined : buf);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(e && e.stack || e));
    }
  });
  server.listen(PORT, () => console.log('preview emulator on ' + origin + (STALE_MS ? ' (stale reads: ' + STALE_MS + ' ms on ' + STALE_KEYS.join(',') + ')' : '')));
  const stop = () => { saveState(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
