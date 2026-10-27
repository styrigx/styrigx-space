/**
 * 本地模拟 passkey-e2e 预览站，并给每一次 KV / D1 操作记账。
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
 * - KV：网关不再绑定 KV（2026-10-27 起认证状态全在 D1）。内存 KV 只留给 Cloudflare KV REST（scripts/migrate-kv-to-d1.mjs
 *   本地对着它跑），支持 expirationTtl / expiration，列表结果带 expiration（和 Cloudflare REST 一样）。
 * - 「读到旧值」（--stale-ms N [--stale-keys 前缀,前缀]）：以前用来复现 KV 写后读不到；网关已经不读 KV，这个选项只对
 *   appKV（现在没人用）生效，保留是为了和以前的运行方式一致（staleReads 应为 0）。D1 强一致，不模拟旧值。
 * - D1：node:sqlite 内存库（styrigx-auth-gateway-preview 的替身），实现网关用到的 prepare().bind().run() / first() / all()
 *   和 batch()（一个事务，任何一条失败整批回滚，同 D1）。D1_LOCK_AUTH、D1_ACCOUNT_AUTH、D1_ROOT_AUTH 绑同一个库（同预览 wrangler.toml）。
 *   启动时按文件名顺序跑 workers/auth-gateway/migrations/*.sql（同 CI 的「Apply D1 migrations to preview」）；
 *   --no-migrations 不跑，模拟正式网关（部署 job 不跑迁移，表由 d1-state.js 遇到 no such table 时自建）。
 *   /__kv/stats 的 d1 一栏按语句类型（select / insert / update / delete / other）记数。
 * - Cloudflare KV REST：/client/v4/accounts/<a>/storage/kv/namespaces/<id>/values/<key>（GET/PUT/DELETE）、/keys（列表，
 *   prefix / cursor / limit）、/bulk/delete（POST，按 Cloudflare 的计费口径每个键算一次删除）；D1 REST 只有
 *   /client/v4/accounts/<a>/d1/database/<id>/query（POST { sql, params }：scripts/kv-budget.mjs 清预览 D1、
 *   scripts/migrate-kv-to-d1.mjs 导入、e2e helper 打开重置开关 / 清根凭证限速用）。测试进程用
 *   SGX_TEST_CF_API=http://127.0.0.1:<port>/client/v4 指过来。
 * - /__kv/stats（GET）：当前计数；/__kv/stats/reset（POST）清零计数（不清数据）；/__kv/dump（GET）：全部键和过期时间。
 *
 * 运行：
 *   node tests/web/e2e/preview-emulator.cjs [--port 8788] [--state /tmp/pv-kv.json] [--root-key K] [--pepper P] [--stale-ms N [--stale-keys …]] [--no-migrations]
 *   --state：启动时从该文件恢复 KV 和 D1 全部表（模拟「上一次运行留下的预览 KV / D1」），退出（SIGINT/SIGTERM）时写回。
 *   然后：SGX_TEST_SUITE=passkey SGX_TEST_BASE=http://localhost:8788 SGX_TEST_ROOT_KEY=K \
 *         SGX_TEST_CF_API=http://127.0.0.1:8788/client/v4 SGX_TEST_CF_TOKEN=x SGX_TEST_CF_ACCOUNT=x SGX_TEST_PREVIEW_D1_ID=local CI=1 \
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
const STALE_KEYS = String(arg('stale-keys', 'lock-,account-,root-'))
  .split(',').map((x) => x.trim()).filter(Boolean);
const NO_MIGRATIONS = argv.includes('--no-migrations');
const dynImport = new Function('u', 'return ' + 'im' + 'port(u)');
const mod = (rel) => dynImport(pathToFileURL(path.join(REPO, rel)).href);

/* ---------- 记账 ---------- */
const stats = { app: {}, rest: {}, d1: {} };
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
const MIGRATIONS = path.join(REPO, 'workers/auth-gateway/migrations');
function applyMigrations() {
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
}
function countD1(sql) {
  const m = String(sql).trim().match(/^(select|insert|update|delete)\b/i);
  const k = m ? m[1].toLowerCase() : 'other';
  stats.d1[k] = (stats.d1[k] || 0) + 1;
}
const d1 = {
  prepare(sql) {
    let args = [];
    const stmt = {
      bind(...a) { args = a; return stmt; },
      /* 不计数的执行（batch 里逐条调） */
      _run() {
        const r = db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(r.changes || 0) } };
      },
      async run() { countD1(sql); return stmt._run(); },
      async first() {
        countD1(sql);
        const r = db.prepare(sql).get(...args);
        return r === undefined ? null : Object.assign({}, r);
      },
      async all() {
        countD1(sql);
        return { success: true, results: db.prepare(sql).all(...args).map((r) => Object.assign({}, r)) };
      },
      _sql: () => sql,
    };
    return stmt;
  },
  /* D1 batch：一个事务，任何一条失败整批回滚 */
  async batch(stmts) {
    db.exec('BEGIN');
    try {
      const out = stmts.map((st) => { countD1(st._sql()); return st._run(); });
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },
};

/* ---------- 状态持久化（模拟跨运行保留的预览 KV / D1） ---------- */
/** D1 里要持久化的表（迁移建的全部业务表，不含 sqlite 内部表） */
function d1Tables() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
}
function loadState() {
  if (!NO_MIGRATIONS) applyMigrations();
  if (!STATE || !fs.existsSync(STATE)) return;
  const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  for (const [k, e] of Object.entries(s.kv || {})) store.set(k, e);
  /* 旧格式（只有 recovery_switch）也认 */
  const tables = s.d1 || (s.recovery_switch ? { recovery_switch: s.recovery_switch } : {});
  if (tables.recovery_switch) db.exec('CREATE TABLE IF NOT EXISTS recovery_switch (hash TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)');
  const have = new Set(d1Tables());
  for (const [t, rows] of Object.entries(tables)) {
    if (!have.has(t) || !/^[a-z_]+$/.test(t)) continue; /* --no-migrations 时表还没建：交给网关自建，不恢复 */
    for (const r of rows) {
      const cols = Object.keys(r);
      db.prepare('INSERT OR REPLACE INTO ' + t + ' (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')').run(...cols.map((c) => r[c]));
    }
  }
}
function saveState() {
  if (!STATE) return;
  const kv = {};
  for (const k of store.keys()) if (live(k)) kv[k] = store.get(k);
  const tables = {};
  for (const t of d1Tables()) {
    if (!/^[a-z_]+$/.test(t)) continue;
    tables[t] = db.prepare('SELECT * FROM ' + t).all().map((r) => Object.assign({}, r));
  }
  fs.writeFileSync(STATE, JSON.stringify({ kv, d1: tables }));
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
  /* D1 REST（scripts/kv-budget.mjs reset-preview 清 passkey / password 表）：POST .../d1/database/<id>/query { sql, params? } */
  if (/^\/client\/v4\/accounts\/[^/]+\/d1\/database\/[^/]+\/query$/.test(u.pathname) && req.method === 'POST') {
    const q = await req.json();
    try {
      countD1(q.sql);
      const st = db.prepare(q.sql);
      const isRead = /^\s*select\b/i.test(q.sql);
      const out = isRead ? { results: st.all(...(q.params || [])).map((r) => Object.assign({}, r)), meta: { changes: 0 } }
        : (() => { const r = st.run(...(q.params || [])); return { results: [], meta: { changes: Number(r.changes || 0) } }; })();
      return cfJson([Object.assign({ success: true }, out)]);
    } catch (e) {
      return Response.json({ success: false, errors: [{ code: 7500, message: String(e && e.message) }], result: null }, { status: 400 });
    }
  }
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
    /* 网关 2026-10-27 起不绑 KV（同预览 wrangler.toml）；三个 D1 绑定接同一个库 */
    D1_LOCK_AUTH: d1, D1_ACCOUNT_AUTH: d1, D1_ROOT_AUTH: d1,
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
      if (req.url.startsWith('/__kv/stats/reset')) { stats.app = {}; stats.rest = {}; stats.d1 = {}; delete stats.staleReads; r = Response.json({ ok: true }); }
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
  server.listen(PORT, () => console.log('preview emulator on ' + origin + (STALE_MS ? ' (stale reads: ' + STALE_MS + ' ms on ' + STALE_KEYS.join(',') + ')' : '') + (NO_MIGRATIONS ? ' (D1 migrations not applied)' : '')));
  const stop = () => { saveState(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
