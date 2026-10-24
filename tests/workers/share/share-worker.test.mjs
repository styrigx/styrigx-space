/**
 * 分享短链 Worker styrigx-share（workers/share，2026-10-24）+ 网关 ShareIssuer（workers/auth-gateway/src/share-issuer.js）。
 * 运行：node --test tests/workers/share/*.test.mjs
 *
 * 两边都跑真代码：短链 Worker 的 default.fetch；服务绑定 AUTH / ISSUER 接到网关真实的 verifier.js / share-issuer.js
 * （SessionVerifier / ShareIssuer RPC 里跑的同一份），网关 env 用临时 Ed25519 钥匙 + 内存 KV。
 * D1：有 node:sqlite 时真 SQL（migrations + lib/links.js 的语句）和内存替身各跑一遍；Node 20 只跑内存替身。
 *
 * - 规则：码 128 位、目标只收站内相对路径（防开放重定向）、有效期 / 会话档位和网关一致、会话不超过有效期
 * - 生成：带会话 → 网关签一把 link 钥匙（不在临时钥匙列表、不占 20 把）；普通 → 不签；网关再验一次站长 + 账号会话
 * - 点开：带会话 → visitor 会话 + 钥匙票（Max-Age = min(会话, 剩余)），302 到干净目标；普通 → 只 302；站长不降级；
 *   预取 / HEAD 不发会话；不存在 / 过期 / 作废 / 格式不对 → 同一个响应；限速
 * - 作废：带会话的连钥匙一起作废，已发出的访客会话下一个请求就进不来
 * - 权限：只有站长 + 账号会话能管；访客 403、没会话 401、跨源 403
 * - 路由：/s/*、/api/share* 归短链 Worker，网关的接口和页面一条没被抢
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shareD1, HAS_SQLITE } from '../../fixtures/share-d1.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const worker = (await import(REPO + 'workers/share/src/index.js')).default;
const links = await import(REPO + 'workers/share/src/lib/links.js');
const { _resetMem } = await import(REPO + 'workers/share/src/open.js');
const issuerMod = await import(REPO + 'workers/auth-gateway/src/share-issuer.js');
const { checkSession, checkAccount } = await import(REPO + 'workers/auth-gateway/src/verifier.js');
const { signSessionCookie } = await import(REPO + 'workers/auth-gateway/functions/_kernel/session.js');
const { signAccountTicket } = await import(REPO + 'workers/auth-gateway/functions/_kernel/account-session.js');
const TL = await import(REPO + 'workers/auth-gateway/functions/_kernel/temp-lock.js');
const { onRequestPost: tempPost } = await import(REPO + 'workers/auth-gateway/functions/api/lock-temp.js');
const { verifySessionDetailed } = await import(REPO + 'workers/auth-gateway/functions/_middleware.js');

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}
async function pair() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    priv: derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY'),
    pub: derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY'),
  };
}
const LOCK = await pair();
const ACCT = await pair();
const H = 3600e3;

function makeKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); if (v === undefined) return null; return type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
}

/** 网关 env 和短链 Worker env 分开，和线上一样；绑定接到网关真代码 */
function setup(d1opts) {
  const kv = makeKV();
  const gwEnv = {
    KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv,
    SGX_LOCK_PRIVATE: LOCK.priv, SGX_LOCK_PUBLIC: LOCK.pub,
    SGX_ACCOUNT_PRIVATE: ACCT.priv, SGX_ACCOUNT_PUBLIC: ACCT.pub,
    SGX_PW_PEPPER: 'share-test-pepper', SGX_ENV: 'production', SGX_SITE: 'space',
  };
  const db = shareD1(d1opts);
  const calls = [];
  const env = {
    SGX_ENV: 'production',
    D1_SHARE_LINK: db,
    AUTH: {
      session: (c) => checkSession(c, gwEnv),
      account: (c, m) => checkAccount(c, gwEnv, m),
    },
    ISSUER: {
      createLinkKey: (c, p) => { calls.push('create'); return issuerMod.createLinkKey(c, p, gwEnv); },
      revokeLinkKey: (c, id, m) => { calls.push('revoke'); return issuerMod.revokeLinkKey(c, id, gwEnv, m); },
      openLinkSession: (id, s) => { calls.push('open'); return issuerMod.openLinkSession(id, s, gwEnv); },
    },
  };
  _resetMem();
  return { kv, gwEnv, db, env, calls };
}

async function ownerCookie() {
  const lock = await signSessionCookie(LOCK.priv, 0, 'owner', 'owner');
  const acct = await signAccountTicket(ACCT.priv, 'password', 0, Date.now(), Date.now());
  return 'sgx-verified=' + lock + '; sgx-account=' + acct;
}

const ctx = { waitUntil() {} };
async function api(env, body, cookie, origin) {
  const res = await worker.fetch(new Request('https://styrigx.com/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin || 'https://styrigx.com', Cookie: cookie === undefined ? await ownerCookie() : cookie },
    body: JSON.stringify(body),
  }), env, ctx);
  return { s: res.status, j: await res.json(), res };
}
function open(env, path, opts = {}) {
  const headers = Object.assign({ 'CF-Connecting-IP': opts.ip || '7.7.7.7' }, opts.cookie ? { Cookie: opts.cookie } : {}, opts.headers || {});
  return worker.fetch(new Request('https://styrigx.com' + path, { method: opts.method || 'GET', headers }), env, ctx);
}
/** Set-Cookie → Cookie 头（sgx-verified 带 Domain 的那条 + sgx-tk） */
function cookiesFrom(res) {
  return res.headers.getSetCookie()
    .filter((c) => (c.startsWith('sgx-verified=') && !c.startsWith('sgx-verified=;')) || c.startsWith('sgx-tk='))
    .map((c) => c.split(';')[0])
    .join('; ');
}
const age = (res, name) => parseInt(/Max-Age=(\d+)/.exec(res.headers.getSetCookie().find((c) => c.startsWith(name + '=')))[1], 10);

/** 统一失败响应：每一项都一样，也不发 cookie */
async function failShape(res) {
  return {
    status: res.status, loc: res.headers.get('Location'), cc: res.headers.get('Cache-Control'),
    ref: res.headers.get('Referrer-Policy'), robots: res.headers.get('X-Robots-Tag'), cookies: res.headers.getSetCookie().length,
    body: await res.text(),
  };
}
const FAIL = { status: 302, loc: 'https://styrigx.com/?lock=1', cc: 'private, no-store', ref: 'no-referrer', robots: 'noindex', cookies: 0, body: '' };

/* ---------------- 规则 ---------------- */

test('码：16 字节随机 → 22 位 base64url；50 个各不相同；id 16 位', () => {
  const s = new Set();
  for (let i = 0; i < 50; i++) {
    const c = links.newCode();
    assert.match(c, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(Buffer.from(c, 'base64url').length, 16);
    s.add(c);
  }
  assert.equal(s.size, 50);
  assert.ok(links.isId(links.newId()));
});

test('目标：只收同源相对路径，拒绝开放重定向', () => {
  assert.equal(links.cleanTarget(undefined), '/');
  assert.equal(links.cleanTarget(''), '/');
  assert.equal(links.cleanTarget(' /blog/x/?a=1#b '), '/blog/x/?a=1#b');
  assert.equal(links.cleanTarget('/a/../b/'), '/b/');
  assert.equal(links.cleanTarget('/%2F%2Fevil.com'), '/%2F%2Fevil.com', '编码的斜杠留在路径里，仍是同源');
  for (const bad of ['//evil.com', '/\\evil.com', '\\\\evil.com', 'https://evil.com/', 'http://styrigx.com/', 'evil.com', 'javascript:alert(1)',
    '/\t/evil.com', '/\n/evil.com', '/ /x', '/a\\b', '/s/abc', '/s', '/api/lock', '/api/share', '/' + 'a'.repeat(links.TARGET_MAX), 5, {}, ['/']]) {
    assert.equal(links.cleanTarget(bad), null, JSON.stringify(bad));
  }
});

test('有效期、会话档位和网关一致；会话不超过有效期；名字最多 24 字', () => {
  for (const p of [{ hours: 1 }, { hours: 24 }, { hours: 25 }, { hours: 0 }, { days: 3 }, { days: 30 }, { days: 2 }, { hours: 1, days: 3 }, { hours: '1' }, {}]) {
    assert.equal(links.durationMs(p), TL.durationMs(p), JSON.stringify(p));
  }
  assert.deepEqual([...links.SESSION_OPTS], [...issuerMod.LINK_SESSION_OPTS]);
  assert.equal(links.sessionSeconds(undefined, H), 0);
  assert.equal(links.sessionSeconds(3600, H), 3600);
  assert.equal(links.sessionSeconds(3 * 3600, H), -1);
  for (const bad of [60, 1801, '1800', 1.5, -1, 30 * 86400]) assert.equal(links.sessionSeconds(bad, 30 * 24 * H), -1, String(bad));
  assert.equal(links.cleanName('a'.repeat(24)), 'a'.repeat(24));
  assert.equal(links.cleanName('a'.repeat(25)), null);
});

test('wrangler.toml：名字、不开 workers.dev / 预览地址、两条路由、AUTH / ISSUER 绑定、D1_SHARE_LINK；预览 routes = []；不绑钥匙和认证库', () => {
  const t = readFileSync(REPO + 'workers/share/wrangler.toml', 'utf8');
  assert.match(t, /^name = "styrigx-share"$/m);
  assert.match(t, /^workers_dev = false$/m);
  assert.match(t, /^preview_urls = false$/m);
  assert.deepEqual([...t.matchAll(/^pattern = "([^"]+)"$/gm)].map((m) => m[1]), ['styrigx.com/s/*', 'styrigx.com/api/share*']);
  assert.match(t, /binding = "AUTH"\nservice = "styrigx-auth-gateway"\nentrypoint = "SessionVerifier"/);
  assert.match(t, /binding = "ISSUER"\nservice = "styrigx-auth-gateway"\nentrypoint = "ShareIssuer"/);
  assert.match(t, /binding = "D1_SHARE_LINK"\ndatabase_name = "styrigx-share"\n/);
  assert.match(t, /\[env\.preview\]\nname = "styrigx-share-preview"\nworkers_dev = false\npreview_urls = false\nroutes = \[\]/);
  assert.match(t, /binding = "D1_SHARE_LINK"\ndatabase_name = "styrigx-share-preview"\n/);
  assert.doesNotMatch(t, /secrets_store|kv_namespaces|SGX_LOCK|SGX_ACCOUNT|PEPPER|styrigx-auth-gateway"\n(?!entrypoint)/);
});

test('短链 Worker 不带签名逻辑：src 里不出现私钥 / pepper / 签名函数，也不 import 网关的 temp-lock / session', () => {
  for (const f of ['index.js', 'gate.js', 'auth.js', 'open.js', 'api/share.js', 'lib/links.js', 'lib/http.js']) {
    const src = readFileSync(REPO + 'workers/share/src/' + f, 'utf8');
    assert.doesNotMatch(src, /_PRIVATE|PEPPER|ed25519|signTk|issueSessionCookie|temp-lock|_kernel\/session|crypto\.subtle/i, f);
  }
});

test('check-worker-routes：/s/*、/api/share* 归短链 Worker；网关接口和页面、账号 Worker 的路径一条没被抢；写宽了就报错', async () => {
  const { readRoutes, readApiRoutes, checkWorkers } = await import(REPO + 'scripts/check-worker-routes.mjs');
  const gw = readRoutes(readFileSync(REPO + 'workers/auth-gateway/wrangler.toml', 'utf8'));
  const acct = readRoutes(readFileSync(REPO + 'workers/account/wrangler.toml', 'utf8'));
  const share = readRoutes(readFileSync(REPO + 'workers/share/wrangler.toml', 'utf8'));
  const apis = readApiRoutes(readFileSync(REPO + 'workers/auth-gateway/src/routes.js', 'utf8'));
  const pages = ['/', '/account/', '/account/temp-keys/', '/settings/', '/search/', '/en/settings/'];
  assert.deepEqual(checkWorkers(gw, acct, share, apis, pages), []);
  assert.ok(checkWorkers(gw, acct, share.concat('styrigx.com/s*'), apis, pages).some((e) => e.includes('/settings/') || e.includes('/search/')));
  assert.ok(checkWorkers(gw, acct, share.concat('styrigx.com/api/s*'), apis, pages).some((e) => e.includes('/api/session-check')));
  assert.ok(checkWorkers(gw, acct, share.concat('styrigx.com/api/avatar*'), apis, pages).some((e) => e.includes('两个 Worker')));
  assert.ok(checkWorkers(gw, acct, share.filter((r) => !r.includes('/s/')), apis, pages).some((e) => e.includes('/s/')));
});

/* ---------------- 端到端（两种 D1 各跑一遍） ---------------- */

const KINDS = HAS_SQLITE ? [{ name: 'sqlite' }, { name: 'memory', memory: true }] : [{ name: 'memory', memory: true }];

for (const K of KINDS) {
  const T = (title, fn) => test('[' + K.name + '] ' + title, fn);
  const mk = () => setup({ memory: !!K.memory });

  T('带会话：生成 → 网关签 link 钥匙（不在临时钥匙列表）→ 访客点开拿到会话、302 到干净目标（不带码）', async () => {
    const { env, db, kv, gwEnv, calls } = mk();
    const r = await api(env, { action: 'create', name: '小明', hours: 24, to: '/blog/?a=1#x', session: 3 * 3600 });
    assert.equal(r.s, 200, JSON.stringify(r.j));
    const link = r.j.link;
    assert.equal(link.status, 'active');
    assert.equal(link.session, 3 * 3600);
    assert.equal(link.to, '/blog/?a=1#x');
    assert.match(link.path, /^\/s\/[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(calls, ['create']);
    const row = db.rows()[0];
    assert.ok(TL.isTempId(row.key_id));
    const key = JSON.parse(kv.m.get(TL.TEMP_PREFIX + row.key_id));
    assert.equal(key.link, true);
    assert.equal(key.h, undefined, 'link 钥匙没有临时码');
    assert.equal(row.expires_at, key.expiresAt, '短链到期 = 钥匙到期');
    /* 临时钥匙页看不到这把钥匙 */
    const lt = await tempPost({ request: new Request('https://styrigx.com/api/lock-temp', { method: 'POST', headers: { Origin: 'https://styrigx.com', Cookie: await ownerCookie() }, body: JSON.stringify({ action: 'list' }) }), env: gwEnv });
    assert.deepEqual((await lt.json()).keys, []);

    const res = await open(env, link.path);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), 'https://styrigx.com/blog/?a=1#x');
    assert.ok(!res.headers.get('Location').includes(link.path.slice(3)), 'Location 里没有码');
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal(res.headers.get('X-SGX-Runtime'), 'share');
    const ck = cookiesFrom(res);
    assert.match(ck, /sgx-verified=owner\.visitor\./);
    assert.match(ck, /sgx-tk=/);
    const ma = age(res, 'sgx-verified');
    assert.ok(ma <= 3 * 3600 && ma > 3 * 3600 - 5, 'Max-Age = 会话时长');
    assert.equal(age(res, 'sgx-tk'), ma);
    const v = await verifySessionDetailed(new Request('https://styrigx.com/', { headers: { Cookie: ck } }), gwEnv);
    assert.equal(v.ok, true);
    assert.equal(v.role, 'visitor', '和临时钥匙访客完全一样');
    /* 被打开的记录 */
    const l2 = await api(env, { action: 'list' });
    assert.equal(l2.j.links[0].opens, 1);
    assert.ok(l2.j.links[0].sessionLeft > 3 * 3600 - 5 && l2.j.links[0].sessionLeft <= 3 * 3600);
  });

  T('会话时长不超过钥匙剩余时间；网关只认 link 钥匙、只认档位', async () => {
    const { env, db, kv, gwEnv } = mk();
    const r = await api(env, { action: 'create', hours: 1, session: 3600 });
    const row = db.rows()[0];
    const k = JSON.parse(kv.m.get(TL.TEMP_PREFIX + row.key_id));
    k.expiresAt = Date.now() + 600e3;
    kv.m.set(TL.TEMP_PREFIX + row.key_id, JSON.stringify(k));
    const res = await open(env, r.j.link.path);
    const ma = age(res, 'sgx-verified');
    assert.ok(ma <= 600 && ma > 590, 'min(会话, 钥匙剩余) = ' + ma);
    /* 普通临时钥匙（有临时码）不能经短链换会话 */
    const plainKey = await TL.createTemp(kv, 'share-test-pepper', { name: '', ms: H });
    assert.deepEqual(await issuerMod.openLinkSession(plainKey.key.id, 3600, gwEnv), { ok: false });
    assert.deepEqual(await issuerMod.openLinkSession(row.key_id, 60, gwEnv), { ok: false }, '不在档位');
    assert.deepEqual(await issuerMod.openLinkSession('x', 3600, gwEnv), { ok: false });
  });

  T('普通短链：不签钥匙、不发会话，302 到目标（没解锁的人由网关照常送去锁屏）', async () => {
    const { env, calls, kv } = mk();
    const r = await api(env, { action: 'create', days: 3, to: '/settings/' });
    assert.equal(r.s, 200);
    assert.equal(r.j.link.session, 0);
    assert.deepEqual(calls, []);
    assert.equal([...kv.m.keys()].filter((k) => k.startsWith(TL.TEMP_PREFIX)).length, 0);
    const res = await open(env, r.j.link.path + '/');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), 'https://styrigx.com/settings/');
    assert.equal(res.headers.getSetCookie().length, 0);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  });

  T('站长自己点开带会话的短链：只 302，不降级成访客', async () => {
    const { env, calls } = mk();
    const r = await api(env, { action: 'create', hours: 2, session: 1800 });
    const res = await open(env, r.j.link.path, { cookie: await ownerCookie() });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), 'https://styrigx.com/');
    assert.equal(res.headers.getSetCookie().length, 0);
    assert.deepEqual(calls, ['create']);
  });

  T('预取不发会话（503，不缓存）；HEAD 只 302 不发会话', async () => {
    const { env, calls } = mk();
    const r = await api(env, { action: 'create', hours: 2, session: 1800 });
    for (const h of [{ 'Sec-Purpose': 'prefetch' }, { 'Sec-Purpose': 'prefetch;prerender' }, { Purpose: 'prefetch' }, { 'X-Moz': 'prefetch' }]) {
      const res = await open(env, r.j.link.path, { headers: h });
      assert.equal(res.status, 503, JSON.stringify(h));
      assert.equal(res.headers.getSetCookie().length, 0);
      assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    }
    const hd = await open(env, r.j.link.path, { method: 'HEAD' });
    assert.equal(hd.status, 302);
    assert.equal(hd.headers.getSetCookie().length, 0);
    assert.equal((await open(env, r.j.link.path, { method: 'POST' })).status, 405);
    assert.deepEqual(calls, ['create'], '没有一次换会话');
  });

  T('不存在 / 格式不对 / 过期 / 作废（两种）/ 目标被改坏：同一个响应', async () => {
    const { env, db } = mk();
    const a = (await api(env, { action: 'create', hours: 1, session: 1800 })).j.link;
    const b = (await api(env, { action: 'create', hours: 1 })).j.link;
    const c = (await api(env, { action: 'create', hours: 1 })).j.link;
    const d = (await api(env, { action: 'create', hours: 1 })).j.link;
    assert.equal((await api(env, { action: 'revoke', id: a.id })).s, 200);
    assert.equal((await api(env, { action: 'revoke', id: b.id })).s, 200);
    if (db.raw) {
      db.raw.prepare('UPDATE share_link SET expires_at = ? WHERE id = ?').run(Date.now() - 1, c.id);
      db.raw.prepare("UPDATE share_link SET target = '//evil.com' WHERE id = ?").run(d.id);
    } else {
      db._links.get(c.id).expires_at = Date.now() - 1;
      db._links.get(d.id).target = '//evil.com';
    }
    const paths = ['/s/' + links.newCode(), '/s/short', '/s/', '/s/' + 'A'.repeat(23), a.path, b.path, c.path, d.path];
    let ip = 0;
    for (const p of paths) assert.deepEqual(await failShape(await open(env, p, { ip: '10.0.0.' + (ip++) })), FAIL, p);
  });

  T('作废带会话的短链：钥匙一起作废，已发出去的访客会话下一个请求就进不来；再点开也是失败响应', async () => {
    const { env, gwEnv, calls, db, kv } = mk();
    const l = (await api(env, { action: 'create', days: 7, session: 86400 })).j.link;
    const ck = cookiesFrom(await open(env, l.path));
    const req = () => new Request('https://styrigx.com/blog/', { headers: { Cookie: ck } });
    assert.equal((await verifySessionDetailed(req(), gwEnv)).ok, true);
    const rv = await api(env, { action: 'revoke', id: l.id });
    assert.equal(rv.s, 200);
    assert.deepEqual(calls, ['create', 'open', 'revoke']);
    const v = await verifySessionDetailed(req(), gwEnv);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'tk-revoked');
    assert.ok(kv.m.has('lock-temp-revoked:' + db.rows()[0].key_id));
    assert.deepEqual(await failShape(await open(env, l.path, { ip: '9.9.9.9' })), FAIL);
    const list = (await api(env, { action: 'list' })).j.links;
    assert.equal(list[0].status, 'revoked');
    assert.equal(list[0].path, undefined, '作废的不再给码');
    assert.equal(list[0].sessionLeft, 0);
    assert.equal((await api(env, { action: 'revoke', id: l.id })).s, 200, '再作废一次也 ok');
    assert.equal((await api(env, { action: 'revoke', id: links.newId() })).s, 404);
  });

  T('网关作废钥匙失败 → 503，D1 不改（可重试，不会显示成已作废而钥匙还在）', async () => {
    const { env, db } = mk();
    const l = (await api(env, { action: 'create', hours: 3, session: 3600 })).j.link;
    env.ISSUER.revokeLinkKey = async () => ({ ok: false, error: 'server' });
    assert.equal((await api(env, { action: 'revoke', id: l.id })).s, 503);
    assert.equal(db.rows()[0].revoked_at, null);
  });

  T('生成的校验：目标 / 有效期 / 会话 / 名字；最多同时 20 条（作废的不算）', async () => {
    const { env } = mk();
    for (const to of ['//evil.com', 'https://evil.com', '/\\evil.com', 'evil.com', '/s/x', '/api/lock']) {
      assert.deepEqual((await api(env, { action: 'create', hours: 1, to })).j, { ok: false, error: 'target' }, to);
    }
    assert.equal((await api(env, { action: 'create', hours: 25 })).j.error, 'duration');
    assert.equal((await api(env, { action: 'create', hours: 1, session: 3 * 3600 })).j.error, 'session');
    assert.equal((await api(env, { action: 'create', hours: 1, session: 999 })).j.error, 'session');
    assert.equal((await api(env, { action: 'create', hours: 1, name: 'x'.repeat(25) })).j.error, 'name');
    let first;
    for (let i = 0; i < 20; i++) {
      const r = await api(env, { action: 'create', hours: 1, session: i % 2 ? 1800 : 0 });
      assert.equal(r.s, 200, String(i));
      if (!first) first = r.j.link;
    }
    const full = await api(env, { action: 'create', hours: 1 });
    assert.equal(full.s, 409);
    assert.equal(full.j.error, 'full');
    await api(env, { action: 'revoke', id: first.id });
    assert.equal((await api(env, { action: 'create', hours: 1 })).s, 200);
  });

  T('link 钥匙不占临时钥匙的 20 把上限', async () => {
    const { env, kv } = mk();
    for (let i = 0; i < 20; i++) await TL.createTemp(kv, 'share-test-pepper', { name: '', ms: H });
    const r = await api(env, { action: 'create', hours: 1, session: 1800 });
    assert.equal(r.s, 200, JSON.stringify(r.j));
  });

  T('权限：访客 403、没会话 401、跨源 403、站长缺账号会话 401；网关 ShareIssuer 自己也要站长 + 账号会话', async () => {
    const { env, gwEnv } = mk();
    const l = (await api(env, { action: 'create', hours: 2, session: 1800 })).j.link;
    const visitor = cookiesFrom(await open(env, l.path));
    let r = await api(env, { action: 'list' }, visitor);
    assert.equal(r.s, 403);
    assert.equal(r.j.error, 'role');
    r = await api(env, { action: 'create', hours: 1, session: 1800 }, visitor);
    assert.equal(r.s, 403);
    assert.equal((await api(env, { action: 'list' }, '')).s, 401);
    assert.equal((await api(env, { action: 'list' }, undefined, 'https://evil.com')).s, 403);
    const lockOnly = 'sgx-verified=' + (await signSessionCookie(LOCK.priv, 0, 'owner', 'owner'));
    r = await api(env, { action: 'list' }, lockOnly);
    assert.equal(r.s, 401);
    assert.equal(r.j.error, 'account');
    /* 直接调网关内部接口：没有站长 + 账号会话就不签、不作废 */
    assert.deepEqual(await issuerMod.createLinkKey(visitor, { hours: 1 }, gwEnv), { ok: false, error: 'session' });
    assert.deepEqual(await issuerMod.createLinkKey(lockOnly, { hours: 1 }, gwEnv), { ok: false, error: 'account' });
    assert.deepEqual(await issuerMod.createLinkKey('', { hours: 1 }, gwEnv), { ok: false, error: 'session' });
    assert.deepEqual(await issuerMod.revokeLinkKey(visitor, 'A'.repeat(16), gwEnv), { ok: false, error: 'session' });
    const owner = await ownerCookie();
    assert.deepEqual(await issuerMod.createLinkKey(owner, { hours: 25 }, gwEnv), { ok: false, error: 'duration' });
    /* 普通临时钥匙不能经短链接口作废 */
    const plain = await TL.createTemp(gwEnv.KV_LOCK_DOOR, 'share-test-pepper', { name: '', ms: H });
    assert.deepEqual(await issuerMod.revokeLinkKey(owner, plain.key.id, gwEnv), { ok: false, error: 'params' });
    /* GET / 别的接口路径 */
    const g = await worker.fetch(new Request('https://styrigx.com/api/share', { headers: { Cookie: owner } }), env, ctx);
    assert.equal(g.status, 405);
    const other = await worker.fetch(new Request('https://styrigx.com/api/shared', { method: 'POST', headers: { Cookie: owner, Origin: 'https://styrigx.com' } }), env, ctx);
    assert.equal(other.status, 404);
  });

  T('限速：同一 IP 10 次打不开 → 15 分钟内真码也走失败响应；换 IP 不受影响；锁住后不再写 D1', async () => {
    const { env, db } = mk();
    const l = (await api(env, { action: 'create', hours: 2 })).j.link;
    for (let i = 0; i < 10; i++) assert.deepEqual(await failShape(await open(env, '/s/' + links.newCode(), { ip: '6.6.6.6' })), FAIL);
    assert.deepEqual(await failShape(await open(env, l.path, { ip: '6.6.6.6' })), FAIL, '真码也被拦');
    assert.ok(db.fails().find((f) => f.ip === '6.6.6.6').locked_until > Date.now());
    _resetMem();
    assert.deepEqual(await failShape(await open(env, l.path, { ip: '6.6.6.6' })), FAIL, '换了 isolate 也认 D1 里的锁');
    const before = JSON.stringify(db.fails());
    for (let i = 0; i < 5; i++) await open(env, '/s/' + links.newCode(), { ip: '6.6.6.6' });
    assert.equal(JSON.stringify(db.fails()), before, '锁住期间不写');
    const ok = await open(env, l.path, { ip: '5.5.5.5' });
    assert.equal(ok.headers.get('Location'), 'https://styrigx.com/');
    /* 格式不对的码不写 D1 */
    const n = db.fails().length;
    await open(env, '/s/bad', { ip: '4.4.4.4' });
    assert.equal(db.fails().length, n);
  });

  T('门：别的域名 /api/* 403、页面 301；/s/* 谁都能开；X-SGX-Runtime: share；/api/* no-store', async () => {
    const { env } = mk();
    const r1 = await worker.fetch(new Request('https://blog.styrigx.com/api/share', { method: 'POST' }), env, ctx);
    assert.equal(r1.status, 403);
    const r2 = await worker.fetch(new Request('https://www.styrigx.com/s/abc'), env, ctx);
    assert.equal(r2.status, 301);
    const r3 = await open(env, '/s/' + links.newCode());
    assert.equal(r3.headers.get('X-SGX-Runtime'), 'share');
    const r4 = await api(env, { action: 'nope' });
    assert.equal(r4.s, 400);
    assert.equal(r4.res.headers.get('Cache-Control'), 'private, no-store');
  });

  T('网关不可达 / ISSUER 没绑：带会话的点开走失败响应，生成 503；D1 没绑：点开失败响应', async () => {
    const { env } = mk();
    const l = (await api(env, { action: 'create', hours: 2, session: 1800 })).j.link;
    const e2 = Object.assign({}, env, { ISSUER: { openLinkSession: async () => { throw new Error('down'); } } });
    assert.deepEqual(await failShape(await open(e2, l.path)), FAIL);
    const e3 = Object.assign({}, env, { ISSUER: undefined });
    assert.equal((await api(e3, { action: 'create', hours: 1, session: 1800 })).s, 503);
    const e4 = Object.assign({}, env, { D1_SHARE_LINK: undefined });
    assert.deepEqual(await failShape(await open(e4, l.path)), FAIL);
  });

  T('列表：新到旧；过期 / 作废的标状态、不给码；超过 7 天的删掉', async () => {
    const { env, db } = mk();
    const a = (await api(env, { action: 'create', hours: 1, name: 'A', to: '/x/' })).j.link;
    const b = (await api(env, { action: 'create', hours: 1, name: 'B', session: 1800 })).j.link;
    const old = Date.now() - 8 * 86400e3;
    if (db.raw) db.raw.prepare('UPDATE share_link SET expires_at = ?, created_at = ? WHERE id = ?').run(old, old - 1, a.id);
    else Object.assign(db._links.get(a.id), { expires_at: old, created_at: old - 1 });
    let list = (await api(env, { action: 'list' })).j.links;
    assert.deepEqual(list.map((x) => x.name), ['B']);
    assert.equal(list[0].openFor, 1800);
    assert.equal(list[0].sessionLeft, 0, '没人点开过');
    const c = (await api(env, { action: 'create', hours: 1, name: 'C' })).j.link;
    if (db.raw) db.raw.prepare('UPDATE share_link SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, c.id);
    else db._links.get(c.id).expires_at = Date.now() - 1000;
    list = (await api(env, { action: 'list' })).j.links;
    assert.deepEqual(list.map((x) => [x.name, x.status, !!x.path]), [['C', 'expired', false], ['B', 'active', true]]);
    assert.ok(!JSON.stringify(list).includes('key_id') && !JSON.stringify(list).includes('"code"'));
  });
}
