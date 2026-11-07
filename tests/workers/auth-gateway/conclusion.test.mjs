/**
 * 网关结论（workers/auth-gateway/src/core/conclusion.js、core/account-rpc.js askAuthorize；方案 2.3、4.3，P2-1）：
 * - conclusionFor：先验门；lock.ok=false 时不调账号（account.reason = no-lock）；进了门才问 ACCOUNT_VERIFIER.authorize()
 * - 账号绑定缺失 / 没有 authorize 方法 / RPC 抛错 / 回了垃圾 → account.ok=false（fail closed）
 * - 白名单：lock.by、tempkeyId（只给 tempkey）；deviceId 格式；作用域格式（不合格的丢掉，去重排序）；reauth 只认 true；原因代号
 * - 结论头：writeAccountConclusion 只写白名单值，没有就不写；先剥掉已有的 X-Styrigx-Account-*
 * - 浏览器带来的 X-Styrigx-Account-* 在网关第一步被剥掉，不会转到账号 Worker
 * - 规则 16：新代码里没有账号票名（只用 account.reauth 这类字段名）
 *
 * 运行：node --test tests/workers/auth-gateway/conclusion.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { testLockSession, TEST_TEMPKEY_ID } from './_tickets.mjs';
import { genKeyPair, makeAuthD1, authD1For, makeKV } from '../_harness.mjs';

const GW = '../../../workers/auth-gateway/src/';
const mod = await import(GW + 'core/conclusion.js');
const { askAuthorize } = await import(GW + 'core/account-rpc.js');
const {
  ACCOUNT_CONCLUSION_HEADERS, ACCOUNT_CONCLUSION_PREFIX, conclusionFor, writeAccountConclusion, stripAccountConclusion,
  normalizeAccountConclusion, normalizeLockConclusion, normalizeScopes,
} = mod;
const layers = await import('../../../space/scripts/check-layers.mjs');

const LOCK = await genKeyPair();
const OTHER = await genKeyPair();
const DEV = 'devtestdevtest01';
const ALL = ['avatar.write', 'curio.write', 'daymark.write', 'prefs.sync', 'profile.write', 'wellbeing.write'];
const ACC_COOKIE = 'sgx-account-session=whatever';

/** ACCOUNT_VERIFIER 替身：记下每次调用；reply 是函数（拿到参数后回什么）或固定值 */
function verifier(reply) {
  const calls = [];
  return {
    calls,
    async authorize(cookie, ctx, opts) {
      calls.push([cookie, ctx, opts]);
      return typeof reply === 'function' ? reply(cookie, ctx, opts) : reply;
    },
  };
}
const OK = (opts) => ({ ok: true, reason: 'ok', deviceId: DEV, scopes: ALL.slice().reverse(), reauth: !!(opts && opts.reauth) });

function env(extra) {
  return Object.assign({ SGX_LOCK_PUBLIC: LOCK.pub, D1_LOCK_AUTH: makeAuthD1({ epochs: { 'lock-epoch': 0 } }) }, extra || {});
}
const lockCookie = async (by = 'password', priv = LOCK.priv, epoch = 0) => 'sgx-lock-session=' + (await testLockSession(priv, epoch, by));

/* ---------------- 导出与头名 ---------------- */

test('导出：结论头常量、前缀、conclusionFor / writeAccountConclusion / stripAccountConclusion 和三个白名单函数', () => {
  assert.deepEqual(Object.keys(mod).sort(), [
    'ACCOUNT_CONCLUSION_HEADERS', 'ACCOUNT_CONCLUSION_PREFIX', 'DEVICE_ID_RE', 'SCOPE_FORMAT_RE',
    'conclusionFor', 'normalizeAccountConclusion', 'normalizeLockConclusion', 'normalizeScopes',
    'stripAccountConclusion', 'writeAccountConclusion',
  ]);
});

test('结论头名逐字固定（方案 2.3.1），冻结，都以 x-styrigx-account- 开头（app.js 第一步的剥头也覆盖它们）', () => {
  assert.deepEqual({ ...ACCOUNT_CONCLUSION_HEADERS }, {
    session: 'X-Styrigx-Account-Session',
    device: 'X-Styrigx-Account-Device',
    scopes: 'X-Styrigx-Account-Scopes',
    reauth: 'X-Styrigx-Account-Reauth',
  });
  assert.ok(Object.isFrozen(ACCOUNT_CONCLUSION_HEADERS));
  assert.equal(ACCOUNT_CONCLUSION_PREFIX, 'x-styrigx-account-');
  for (const h of Object.values(ACCOUNT_CONCLUSION_HEADERS)) {
    assert.ok(h.toLowerCase().startsWith(ACCOUNT_CONCLUSION_PREFIX), h);
    assert.ok(h.toLowerCase().startsWith('x-styrigx-'), h);
  }
});

/* ---------------- conclusionFor ---------------- */

test('conclusionFor：进门 + 账号会话有效 → lock / account 两段结论；作用域排序；Cookie 原样、clientContext 只留三项、没要复验 reauth:false', async () => {
  const v = verifier((c, x, o) => OK(o));
  const ck = (await lockCookie('passkey')) + '; ' + ACC_COOKIE;
  const r = await conclusionFor(env({ ACCOUNT_VERIFIER: v }), ck, { ua: 'UA', country: 'JP', city: 'Tokyo', role: 'password', ip: '1.2.3.4' });
  assert.deepEqual(r, {
    lock: { ok: true, by: 'passkey', tempkeyId: '', reason: 'ok' },
    account: { ok: true, deviceId: DEV, scopes: ALL, reauth: false, reason: 'ok' },
  });
  assert.equal(v.calls.length, 1);
  assert.deepEqual(v.calls[0], [ck, { ua: 'UA', country: 'JP', city: 'Tokyo' }, { reauth: false }]);
});

test('conclusionFor：opts.reauth === true 才向账号要复验结论；别的写法一律当没要', async () => {
  const v = verifier((c, x, o) => OK(o));
  const ck = (await lockCookie()) + '; ' + ACC_COOKIE;
  const r = await conclusionFor(env({ ACCOUNT_VERIFIER: v }), ck, {}, { reauth: true });
  assert.equal(r.account.reauth, true);
  for (const o of [undefined, null, {}, { reauth: 'true' }, { reauth: 1 }]) {
    const x = await conclusionFor(env({ ACCOUNT_VERIFIER: v }), ck, {}, /** @type {any} */ (o));
    assert.equal(x.account.reauth, false, JSON.stringify(o));
  }
  assert.deepEqual(v.calls.map((c) => c[2]), [{ reauth: true }, { reauth: false }, { reauth: false }, { reauth: false }, { reauth: false }, { reauth: false }]);
});

test('conclusionFor：临时钥匙进门 → lock.by=tempkey、带 tempkeyId', async () => {
  const v = verifier(OK());
  const r = await conclusionFor(env({ ACCOUNT_VERIFIER: v }), await lockCookie('tempkey'), {});
  assert.deepEqual(r.lock, { ok: true, by: 'tempkey', tempkeyId: TEST_TEMPKEY_ID, reason: 'ok' });
});

test('conclusionFor：lock.ok=false（没 cookie / 只有账号会话 / 别的钥匙签 / 纪元旧了）→ 不调账号，account.reason = no-lock', async () => {
  const v = verifier(OK());
  const e = env({ ACCOUNT_VERIFIER: v, D1_LOCK_AUTH: makeAuthD1({ epochs: { 'lock-epoch': 2 } }) });
  const cases = [
    ['', 'no-cookie'],
    [undefined, 'no-cookie'],
    [ACC_COOKIE, 'no-cookie'],
    [await lockCookie('password', OTHER.priv, 2), 'bad-sig'],
    [await lockCookie('password', LOCK.priv, 1), 'epoch-low'],
  ];
  for (const [ck, reason] of cases) {
    const r = await conclusionFor(e, /** @type {any} */ (ck), {}, { reauth: true });
    assert.deepEqual(r, {
      lock: { ok: false, by: '', tempkeyId: '', reason },
      account: { ok: false, deviceId: '', scopes: [], reauth: false, reason: 'no-lock' },
    }, String(ck));
  }
  assert.equal(v.calls.length, 0, '进门是前置：没进门不问账号');
});

test('conclusionFor：锁屏库出错 → lock.ok=false（d1-error），也不调账号', async () => {
  const v = verifier(OK());
  const d1 = makeAuthD1({ epochs: { 'lock-epoch': 0 } });
  d1.failOn = () => true;
  const r = await conclusionFor(env({ ACCOUNT_VERIFIER: v, D1_LOCK_AUTH: d1 }), await lockCookie(), {});
  assert.equal(r.lock.ok, false);
  assert.equal(r.lock.reason, 'd1-error');
  assert.equal(r.account.reason, 'no-lock');
  assert.equal(v.calls.length, 0);
});

test('conclusionFor：账号绑定缺失 / 没有 authorize 方法 → account.ok=false（no-verifier），lock 结论照旧', async () => {
  const ck = (await lockCookie()) + '; ' + ACC_COOKIE;
  for (const b of [undefined, null, {}, { accountSession: async () => ({ ok: true }) }, { authorize: 'x' }]) {
    const r = await conclusionFor(env({ ACCOUNT_VERIFIER: b }), ck, {});
    assert.equal(r.lock.ok, true);
    assert.deepEqual(r.account, { ok: false, deviceId: '', scopes: [], reauth: false, reason: 'no-verifier' }, JSON.stringify(b));
  }
});

test('conclusionFor：RPC 抛错 → account.ok=false（rpc-error），不往外抛', async () => {
  const v = { async authorize() { throw new Error('boom'); } };
  const r = await conclusionFor(env({ ACCOUNT_VERIFIER: v }), (await lockCookie()) + '; ' + ACC_COOKIE, {});
  assert.equal(r.lock.ok, true);
  assert.deepEqual(r.account, { ok: false, deviceId: '', scopes: [], reauth: false, reason: 'rpc-error' });
});

test('conclusionFor：账号回了垃圾 → account.ok=false', async () => {
  const ck = (await lockCookie()) + '; ' + ACC_COOKIE;
  const cases = [
    [null, 'bad-reply'],
    ['ok', 'bad-reply'],
    [42, 'bad-reply'],
    [{}, 'denied'],
    [{ ok: 'true', deviceId: DEV, scopes: ALL }, 'denied'],
    [{ ok: 1, deviceId: DEV, scopes: ALL }, 'denied'],
    [{ ok: true, deviceId: 'short', scopes: ALL }, 'bad-reply'],
    [{ ok: true, deviceId: 'dev id with spaces!', scopes: ALL }, 'bad-reply'],
    [{ ok: true, deviceId: 42, scopes: ALL }, 'bad-reply'],
    [{ ok: true, scopes: ALL }, 'bad-reply'],
    [{ ok: true, deviceId: DEV, scopes: 'curio.write' }, 'bad-reply'],
    [{ ok: true, deviceId: DEV }, 'bad-reply'],
    [{ ok: false, reason: 'revoked', deviceId: DEV, scopes: ALL, reauth: true }, 'revoked'],
    [{ ok: false, reason: 'Evil\nReason <x>' }, 'denied'],
  ];
  for (const [reply, reason] of cases) {
    const r = await conclusionFor(env({ ACCOUNT_VERIFIER: verifier(reply) }), ck, {});
    assert.equal(r.lock.ok, true);
    assert.deepEqual(r.account, { ok: false, deviceId: '', scopes: [], reauth: false, reason }, JSON.stringify(reply));
  }
});

test('conclusionFor：作用域白名单——不合格式的丢掉，去重、按字母排序；reauth 只认 true', async () => {
  const ck = (await lockCookie()) + '; ' + ACC_COOKIE;
  const reply = { ok: true, deviceId: DEV, scopes: ['prefs.sync', 'Curio.write', 'curio.write', 'curio.write', 'x', 'a.b.c', 'daymark.write ', 7, null, 'curio.write\r\nX-Evil: 1'], reauth: 'yes' };
  const r = await conclusionFor(env({ ACCOUNT_VERIFIER: verifier(reply) }), ck, {});
  assert.deepEqual(r.account, { ok: true, deviceId: DEV, scopes: ['curio.write', 'prefs.sync'], reauth: false, reason: 'ok' });
});

test('conclusionFor：账号会话无效（账号说 no-cookie / expired）→ account.ok=false、原因原样', async () => {
  const ck = await lockCookie();
  for (const reason of ['no-cookie', 'expired', 'epoch-changed', 'revoked']) {
    const r = await conclusionFor(env({ ACCOUNT_VERIFIER: verifier({ ok: false, reason, deviceId: '', scopes: [], reauth: false }) }), ck + '; ' + ACC_COOKIE, {});
    assert.equal(r.lock.ok, true);
    assert.deepEqual(r.account, { ok: false, deviceId: '', scopes: [], reauth: false, reason });
  }
});

/* ---------------- askAuthorize ---------------- */

test('askAuthorize：没 cookie 不问；超长 cookie 截到 8192；clientContext 只留 ua / country / city 并截长', async () => {
  const v = verifier(OK());
  assert.deepEqual(await askAuthorize({ ACCOUNT_VERIFIER: v }, '', {}), { ok: false, reason: 'no-cookie', deviceId: '', scopes: [], reauth: false });
  assert.deepEqual(await askAuthorize({ ACCOUNT_VERIFIER: v }, /** @type {any} */ ({ Cookie: 'x' }), {}), { ok: false, reason: 'no-cookie', deviceId: '', scopes: [], reauth: false });
  assert.equal(v.calls.length, 0);
  const r = await askAuthorize({ ACCOUNT_VERIFIER: v }, 'a=' + 'x'.repeat(10000), { ua: 'U'.repeat(600), country: 'JAPAN', city: 'C'.repeat(50), address: '1.2.3.4' }, { reauth: true });
  assert.equal(r.ok, true);
  const [cookie, ctx, opts] = v.calls[0];
  assert.equal(cookie.length, 8192);
  assert.deepEqual(Object.keys(ctx).sort(), ['city', 'country', 'ua']);
  assert.equal(ctx.ua.length, 512);
  assert.equal(ctx.country, 'JAPA');
  assert.equal(ctx.city.length, 40);
  assert.deepEqual(opts, { reauth: true });
  await askAuthorize({ ACCOUNT_VERIFIER: v }, 'a=1', 'not-an-object');
  assert.deepEqual(v.calls[1][1], {});
});

/* ---------------- 白名单函数 ---------------- */

test('normalizeLockConclusion：by 只认 password / passkey / tempkey；tempkeyId 只给 tempkey 且合格式', () => {
  assert.deepEqual(normalizeLockConclusion({ ok: true, role: 'password', by: 'password', tempkeyId: 'tk1' }), { ok: true, by: 'password', tempkeyId: '', reason: 'ok' });
  assert.deepEqual(normalizeLockConclusion({ ok: true, by: 'space' }), { ok: true, by: '', tempkeyId: '', reason: 'ok' });
  assert.deepEqual(normalizeLockConclusion({ ok: true, by: 'tempkey', tempkeyId: 'bad id!' }), { ok: true, by: 'tempkey', tempkeyId: '', reason: 'ok' });
  assert.deepEqual(normalizeLockConclusion({ ok: false, reason: 'expired' }), { ok: false, by: '', tempkeyId: '', reason: 'expired' });
  assert.deepEqual(normalizeLockConclusion(null), { ok: false, by: '', tempkeyId: '', reason: 'no-session' });
});

test('normalizeScopes / normalizeAccountConclusion：非数组 → null / bad-reply；最多 32 个', () => {
  assert.equal(normalizeScopes('curio.write'), null);
  assert.deepEqual(normalizeScopes([]), []);
  const many = Array.from({ length: 40 }, (_, i) => 'app.' + 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn'.slice(i, i + 1).repeat(2) + 'x'.repeat(i % 3));
  assert.equal(normalizeScopes(many).length, 32);
  assert.deepEqual(normalizeAccountConclusion({ ok: true, deviceId: DEV, scopes: [] }), { ok: true, deviceId: DEV, scopes: [], reauth: false, reason: 'ok' });
});

/* ---------------- 结论头 ---------------- */

const hdrs = (h) => Object.fromEntries([...h]);

test('writeAccountConclusion：只写白名单值——Session: 1、Device、Scopes（空格分隔、字母序）、Reauth: 1（只在 true 时）', () => {
  const h = writeAccountConclusion(new Headers({ Cookie: 'a=1' }), { ok: true, deviceId: DEV, scopes: ['prefs.sync', 'curio.write'], reauth: true, reason: 'ok' });
  assert.deepEqual(hdrs(h), {
    cookie: 'a=1',
    'x-styrigx-account-session': '1',
    'x-styrigx-account-device': DEV,
    'x-styrigx-account-scopes': 'curio.write prefs.sync',
    'x-styrigx-account-reauth': '1',
  });
  const noReauth = writeAccountConclusion(new Headers(), { ok: true, deviceId: DEV, scopes: ['daymark.write'], reauth: 'true' });
  assert.equal(noReauth.get('X-Styrigx-Account-Reauth'), null, '没有就不写，不写 0');
  const noScopes = writeAccountConclusion(new Headers(), { ok: true, deviceId: DEV, scopes: [], reauth: false });
  assert.deepEqual(hdrs(noScopes), { 'x-styrigx-account-session': '1', 'x-styrigx-account-device': DEV });
});

test('writeAccountConclusion：account.ok 不是 true / deviceId 不合格式 / scopes 不是数组 → 一个账号头都不写；先剥掉已有的（任意大小写）', () => {
  const forged = { 'X-STYRIGX-ACCOUNT-SESSION': '1', 'x-styrigx-account-scopes': 'curio.write', 'X-Styrigx-Account-Reauth': '1', 'X-Styrigx-Account-Whatever': 'x', 'X-Styrigx-Lock-By': 'password' };
  for (const a of [
    { ok: false, deviceId: DEV, scopes: ALL, reauth: true },
    { ok: 'true', deviceId: DEV, scopes: ALL },
    { ok: true, deviceId: 'x', scopes: ALL },
    { ok: true, deviceId: DEV, scopes: 'curio.write' },
    null,
  ]) {
    const h = writeAccountConclusion(new Headers(forged), a);
    assert.deepEqual(hdrs(h), { 'x-styrigx-lock-by': 'password' }, JSON.stringify(a));
  }
});

test('writeAccountConclusion：作用域里夹带换行 / 非法字符的项丢掉，不会拼出新头', () => {
  const h = writeAccountConclusion(new Headers(), { ok: true, deviceId: DEV, scopes: ['curio.write\r\nX-Evil: 1', 'daymark.write'] });
  assert.equal(h.get('X-Styrigx-Account-Scopes'), 'daymark.write');
  assert.equal(h.get('X-Evil'), null);
});

test('stripAccountConclusion：只剥 x-styrigx-account-*，别的 x-styrigx-* 和普通头不动；null 原样', () => {
  const h = stripAccountConclusion(new Headers({ 'X-Styrigx-Account-Session': '1', 'x-styrigx-account-device': 'd', 'X-Styrigx-Lock-Level': 'password', Cookie: 'a=1' }));
  assert.deepEqual([...h.keys()].sort(), ['cookie', 'x-styrigx-lock-level']);
  assert.equal(stripAccountConclusion(null), null);
});

test('浏览器带来的 X-Styrigx-Account-*：网关第一步就剥掉，转到账号 Worker 的请求里一个都没有', async () => {
  const worker = (await import(GW + 'app.js')).default;
  const { _resetSecretCache } = await import(GW + 'secrets.js');
  _resetSecretCache();
  const seen = [];
  const ACCOUNT = { async fetch(req) { seen.push(Object.fromEntries([...req.headers])); return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }); } };
  const ck = await lockCookie('password');
  const e = { SGX_ENV: 'production', SGX_SITE: 'space', SGX_LOCK_PUBLIC: LOCK.pub, D1_LOCK_AUTH: authD1For(makeKV()), ACCOUNT };
  const forged = {
    Cookie: ck,
    'X-Styrigx-Account-Session': '1',
    'X-Styrigx-Account-Device': 'forgeddevice01',
    'X-Styrigx-Account-Scopes': 'curio.write daymark.write',
    'x-styrigx-account-reauth': '1',
  };
  const res = await worker.fetch(new Request('https://styrigx.com/api/wellbeing?d=2026-11-04', { headers: forged }), e, { waitUntil() {} });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  for (const k of Object.keys(seen[0])) assert.ok(!k.startsWith('x-styrigx-account-'), k);
});

/* ---------------- 规则 16 ---------------- */

test('规则 16：结论相关的网关源码没有账号鉴权标识（复验只叫 account.reauth / X-Styrigx-Account-Reauth）', () => {
  for (const f of ['core/conclusion.js', 'core/account-rpc.js', 'rpc/auth-verifier.js']) {
    const src = readFileSync(new URL(GW + f, import.meta.url), 'utf8');
    assert.deepEqual(layers.checkGatewayAccountAuth('workers/auth-gateway/src/' + f, src), [], f);
  }
});
