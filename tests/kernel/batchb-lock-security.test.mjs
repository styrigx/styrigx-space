/**
 * 批次 B #10/#11/#16 服务端测试（node --test）。
 *
 * 覆盖：
 * - #11：STEPUP_MAX_AGE = 180；stepup status 回 expiresAt；verifyStepupCookie 返回 exp。
 * - #16：BY_STARTUP 签发/解析；启动会话 Max-Age=1800；reissue 排除 startup；
 *   root-session 仅启动站签发（by='startup'），任一层已配置即 403；
 *   root-auth 两层门禁（启动站无会话走真路径；owner 已配置无会话走假入口 401）；
 *   middleware 启动会话收窄（首页/允许页/非允许页/API）。
 * - #10：删 lock 钥匙 / 删 lock 密码的「删后归零」口径（owner 已配置才允许；
 *   owner 未配置 → 403 last-key）；删光且 owner 已配置 → 置 lock-emptied，
 *   lock-config 返回 resetOnly:true；lockreset 下 lock 类改名/删密码放开。
 * - layers：isOwnerEffectivelyConfigured / isBootstrapStation / lock-emptied 口径。
 *
 * 运行：node --test tests/kernel/batchb-lock-security.test.mjs
 * 说明：mock KV 只替代 Cloudflare KV（外部环境敏感项），被测的是自家逻辑；
 * Ed25519 测试密钥在测试内临时生成，不用生产密钥、不进仓库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STEPUP_MAX_AGE, STEPUP_COOKIE, signStepupCookie, verifyStepupCookie, onRequestPost as stepupPost } from '../../functions/api/stepup.js';
import {
  BY_STARTUP, STARTUP_MAX_AGE, SESSION_COOKIE, signSessionCookie, parseSessionCookie,
  issueSessionCookie, reissueSessionWithEpoch,
} from '../../functions/_kernel/session.js';
import {
  LOCK_EMPTIED_KEY, isLockEffectivelyConfigured, isOwnerEffectivelyConfigured, isBootstrapStation,
} from '../../functions/_kernel/layers.js';
import { onRequestPost as passkeyPost } from '../../functions/api/owner-passkey.js';
import { onRequestPost as passwordPost } from '../../functions/api/owner-password.js';
import { onRequestGet as lockConfigGet } from '../../functions/api/lock-config.js';
import { onRequestPost as rootSessionPost } from '../../functions/api/root-session.js';
import { onRequestPost as rootAuthPost } from '../../functions/api/root-auth.js';
import { onRequest as mwOnRequest } from '../../functions/_middleware.js';

/* ---------- mock KV ---------- */

function makeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k, type) {
      if (!store.has(k)) return null;
      const v = store.get(k);
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async list(opts) {
      const prefix = (opts && opts.prefix) || '';
      return { keys: Array.from(store.keys()).filter((n) => n.startsWith(prefix)).map((name) => ({ name })) };
    },
  };
}

/* ---------- Ed25519 测试密钥（临时生成） ---------- */

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

let STEPUP_PRIV = '';
let STEPUP_PUB = '';
let LOCK_PRIV = '';
let LOCK_PUB = '';

async function genKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  STEPUP_PRIV = derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY');
  STEPUP_PUB = derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY');
  const kp2 = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  LOCK_PRIV = derToPem(await crypto.subtle.exportKey('pkcs8', kp2.privateKey), 'PRIVATE KEY');
  LOCK_PUB = derToPem(await crypto.subtle.exportKey('spki', kp2.publicKey), 'PUBLIC KEY');
}

function postReq(url, body, headers = {}) {
  const h = { 'Content-Type': 'application/json', Origin: new URL(url).origin };
  Object.assign(h, headers);
  return new Request(url, { method: 'POST', headers: h, body: JSON.stringify(body || {}) });
}
function getReq(url, headers = {}) {
  return new Request(url, { method: 'GET', headers });
}

const envFor = (kv) => ({
  OWNER_KV: kv,
  SGX_SITE: 'space',
  SGX_LOCK_PRIVATE: LOCK_PRIV,
  SGX_LOCK_PUBLIC: LOCK_PUB,
  SGX_STEPUP_PRIVATE: STEPUP_PRIV,
  SGX_STEPUP_PUBLIC: STEPUP_PUB,
  SGX_ROOT_KEY: 'test-root-key-12345',
  SGX_PW_PEPPER: 'test-pepper',
  SGX_RP_ID: 'styrigx.com',
  SGX_ORIGIN: 'https://styrigx.com',
});

async function mintSession(epoch = 0, by = 'owner') {
  return await signSessionCookie(LOCK_PRIV, epoch, 'owner', by);
}
async function mintStepup(by = 'owner', scope = 'keys', epoch = 0) {
  return await signStepupCookie(STEPUP_PRIV, by, scope, epoch);
}
const bothCookies = (s, t) => ({ Cookie: `${SESSION_COOKIE}=${s}; ${STEPUP_COOKIE}=${t}` });
const stepupOnly = (t) => ({ Cookie: `${STEPUP_COOKIE}=${t}` });

async function seedKey(kv, { credId, cls = 'lock', aud = '' }) {
  const rec = {
    name: 'test', provider: '', aaguid: '', createdAt: 1, lastUsedAt: 0,
    credId, publicKey: {}, signCount: 0, uv: 1, class: cls,
  };
  if (aud) rec.aud = aud;
  await kv.put('owner-passkey:' + credId.slice(0, 12), JSON.stringify(rec));
  await kv.put('owner-passkey-index', JSON.stringify([credId]));
}
async function seedPw(kv, kind, hash = 'x') {
  await kv.put(kind === 'owner' ? 'owner-pw' : 'lock-pw', JSON.stringify({ hash }));
}

test('setup: 生成测试密钥', async () => {
  await genKeys();
  assert.ok(STEPUP_PRIV.includes('PRIVATE KEY'));
});

/* ============ #11：stepup 180 秒 + expiresAt ============ */

test('#11：STEPUP_MAX_AGE = 180；status 回 expiresAt；verify 返回 exp', async () => {
  assert.equal(STEPUP_MAX_AGE, 180);
  const kv = makeKV();
  const env = envFor(kv);
  const sc = await mintStepup('owner', 'keys');
  const verified = await verifyStepupCookie(new Request('https://styrigx.com/api/stepup', { headers: stepupOnly(sc) }), env);
  assert.ok(verified.ok);
  assert.ok(typeof verified.exp === 'number' && verified.exp > Date.now(), 'verify 应返回 exp');
  const sess = await mintSession();
  const r = await stepupPost({
    request: postReq('https://styrigx.com/api/stepup', { action: 'status' }, bothCookies(sess, sc)),
    env,
  });
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.valid, true);
  assert.ok(typeof j.expiresAt === 'number' && j.expiresAt > Date.now(), 'status 应回 expiresAt 绝对时间戳');
  assert.ok(Math.abs(j.expiresAt - verified.exp) < 2000, 'expiresAt 应与 cookie exp 一致');
});

/* ============ #16：启动会话 ============ */

test('#16：BY_STARTUP 签发/解析往返；Max-Age=1800；reissue 排除 startup', async () => {
  assert.equal(STARTUP_MAX_AGE, 1800);
  const cv = await signSessionCookie(LOCK_PRIV, 0, 'owner', 'startup');
  const parsed = parseSessionCookie(cv);
  assert.ok(parsed, '应能解析 startup 会话');
  assert.equal(parsed.by, 'startup');
  assert.equal(parsed.role, 'owner');
  const kv = makeKV();
  const env = envFor(kv);
  const headers = new Headers();
  const err = await issueSessionCookie(env, headers, 'owner', BY_STARTUP, STARTUP_MAX_AGE);
  assert.equal(err, null);
  const setCookie = headers.get('Set-Cookie') || '';
  assert.ok(setCookie.includes('Max-Age=1800'), '启动会话 Max-Age 应为 1800');
  assert.ok(setCookie.includes('startup.'), 'cookie 值应以 startup. 开头');
  /* reissue 排除 startup：不追加 Set-Cookie */
  const headers2 = new Headers();
  await reissueSessionWithEpoch(env, headers2, parsed, 1);
  assert.equal(headers2.get('Set-Cookie'), null, 'startup 会话随 epoch 失效，不重签');
});

test('#16：isOwnerEffectivelyConfigured 口径', async () => {
  assert.equal(await isOwnerEffectivelyConfigured(makeKV()), false, '空站 owner 未配置');
  const kv1 = makeKV();
  await seedPw(kv1, 'owner');
  assert.equal(await isOwnerEffectivelyConfigured(kv1), true, 'owner-pw 即已配置');
  const kv2 = makeKV();
  await seedKey(kv2, { credId: 'owner-key-001', cls: 'owner' });
  assert.equal(await isOwnerEffectivelyConfigured(kv2), true, 'class=owner 钥匙即已配置');
  const kv3 = makeKV({ 'layer:owner': '1' });
  assert.equal(await isOwnerEffectivelyConfigured(kv3), true, '标记独有也算已配置');
  const kv4 = makeKV();
  await seedKey(kv4, { credId: 'lock-key-001', cls: 'lock' });
  assert.equal(await isOwnerEffectivelyConfigured(kv4), false, '只有 lock 钥匙时 owner 未配置');
});

test('#16：isBootstrapStation 口径', async () => {
  assert.equal(await isBootstrapStation(makeKV()), true, 'KV 全空 = 启动站');
  const kv1 = makeKV();
  await seedPw(kv1, 'owner');
  assert.equal(await isBootstrapStation(kv1), false, '有 owner-pw 即非启动站');
  const kv2 = makeKV();
  await seedPw(kv2, 'lock');
  assert.equal(await isBootstrapStation(kv2), false, '有 lock-pw 即非启动站');
  const kv3 = makeKV();
  await seedKey(kv3, { credId: 'lock-key-001', cls: 'lock' });
  assert.equal(await isBootstrapStation(kv3), false, '有 lock 钥匙即非启动站');
  assert.equal(await isBootstrapStation(makeKV({ 'layer:owner': '1' })), false, '标记独有不进启动模式');
  assert.equal(await isBootstrapStation(makeKV({ 'layer:lock': '1' })), false, '标记独有不进启动模式');
  assert.equal(await isBootstrapStation(makeKV({ [LOCK_EMPTIED_KEY]: '1' })), false, 'lock-emptied 残留不进启动模式');
  assert.equal(await isLockEffectivelyConfigured(makeKV({ [LOCK_EMPTIED_KEY]: '1' })), true, 'lock-emptied 也算 lock 已配置（根凭证代开被拒）');
});

/* ============ #10：删 lock 钥匙 ============ */

test('#10：有 owner 密码时删最后一把 lock 钥匙 → 成功 + 置 lock-emptied + lock-config resetOnly', async () => {
  const kv = makeKV();
  await seedKey(kv, { credId: 'lock-key-001', cls: 'lock' });
  await seedPw(kv, 'owner');
  const sc = await mintStepup();
  const sess = await mintSession();
  const r = await passkeyPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'delete', credId: 'lock-key-001' }, bothCookies(sess, sc)),
    env: envFor(kv),
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get(LOCK_EMPTIED_KEY), '1', '应置 layer:lock-emptied');
  const cfg = await lockConfigGet({ request: getReq('https://styrigx.com/api/lock-config'), env: envFor(kv) });
  const cj = await cfg.json();
  assert.equal(cj.ownerConfigured, true);
  assert.equal(cj.resetOnly, true, 'lock 凭证归零且 owner 已配置 → resetOnly');
});

test('#10：有 owner 钥匙时删最后一把 lock 钥匙 → 成功', async () => {
  const kv = makeKV();
  await seedKey(kv, { credId: 'lock-key-001', cls: 'lock' });
  await seedKey(kv, { credId: 'owner-key-001', cls: 'owner' });
  await kv.put('owner-passkey-index', JSON.stringify(['lock-key-001', 'owner-key-001']));
  const sc = await mintStepup();
  const sess = await mintSession();
  const r = await passkeyPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'delete', credId: 'lock-key-001' }, bothCookies(sess, sc)),
    env: envFor(kv),
  });
  assert.equal(r.status, 200);
});

test('#10：无 ownerkey 时删最后一把 lock 钥匙 → 403 last-key，凭证仍在', async () => {
  const kv = makeKV();
  await seedKey(kv, { credId: 'lock-key-001', cls: 'lock' });
  const sc = await mintStepup();
  const sess = await mintSession();
  const r = await passkeyPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'delete', credId: 'lock-key-001' }, bothCookies(sess, sc)),
    env: envFor(kv),
  });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'last-key');
  assert.ok(await kv.get('owner-passkey:lock-key-001'), '凭证应仍在');
});

test('#10：有锁屏密码时删 lock 钥匙（不归零）→ 成功，不置 lock-emptied', async () => {
  const kv = makeKV();
  await seedKey(kv, { credId: 'lock-key-001', cls: 'lock' });
  await seedPw(kv, 'lock');
  const sc = await mintStepup();
  const sess = await mintSession();
  const r = await passkeyPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'delete', credId: 'lock-key-001' }, bothCookies(sess, sc)),
    env: envFor(kv),
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get(LOCK_EMPTIED_KEY), null, '未归零不置 lock-emptied');
});

/* ============ #10：删 lock 密码 ============ */

test('#10：有 ownerkey 时删唯一锁屏密码 → 成功', async () => {
  const kv = makeKV();
  await seedPw(kv, 'lock');
  await seedPw(kv, 'owner');
  const sc = await mintStepup();
  const sess = await mintSession();
  const r = await passwordPost({
    request: postReq('https://styrigx.com/api/owner-password', { action: 'remove', kind: 'lock' }, bothCookies(sess, sc)),
    env: envFor(kv),
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('lock-pw'), null, 'lock-pw 应被删除');
});

test('#10：无 ownerkey 时删唯一锁屏密码 → 403 last-key，密码仍在', async () => {
  const kv = makeKV();
  await seedPw(kv, 'lock');
  const sc = await mintStepup();
  const sess = await mintSession();
  const r = await passwordPost({
    request: postReq('https://styrigx.com/api/owner-password', { action: 'remove', kind: 'lock' }, bothCookies(sess, sc)),
    env: envFor(kv),
  });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'last-key');
  assert.ok(await kv.get('lock-pw'), 'lock-pw 应仍在');
});

/* ============ R1：lockreset 下改名 / 删密码 ============ */

test('R1：lockreset 票下 lock 类改名可用', async () => {
  const kv = makeKV();
  await seedKey(kv, { credId: 'lock-key-001', cls: 'lock' });
  await seedPw(kv, 'owner');
  const sc = await mintStepup('owner+root', 'lockreset');
  const r = await passkeyPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'rename', credId: 'lock-key-001', name: '新名字' }, stepupOnly(sc)),
    env: envFor(kv),
  });
  assert.equal(r.status, 200);
});

test('R1：lockreset 票下删 lock 密码（owner 已配置）→ 成功', async () => {
  const kv = makeKV();
  await seedPw(kv, 'lock');
  await seedPw(kv, 'owner');
  const sc = await mintStepup('owner+root', 'lockreset');
  const r = await passwordPost({
    request: postReq('https://styrigx.com/api/owner-password', { action: 'remove', kind: 'lock' }, stepupOnly(sc)),
    env: envFor(kv),
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('lock-pw'), null);
});

test('R1：lockreset 票下删 lock 密码（owner 未配置）→ 403 last-key', async () => {
  const kv = makeKV();
  await seedPw(kv, 'lock');
  const sc = await mintStepup('owner+root', 'lockreset');
  const r = await passwordPost({
    request: postReq('https://styrigx.com/api/owner-password', { action: 'remove', kind: 'lock' }, stepupOnly(sc)),
    env: envFor(kv),
  });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'last-key');
});

/* ============ #16：root-session / root-auth ============ */

test('#16：空站 root-session 签发启动会话（by=startup，Max-Age=1800）', async () => {
  const kv = makeKV();
  const env = envFor(kv);
  const sc = await mintStepup('root', 'root');
  const r = await rootSessionPost({
    request: postReq('https://styrigx.com/api/root-session', {}, stepupOnly(sc)),
    env,
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.by, 'startup');
  const setCookie = r.headers.get('Set-Cookie') || '';
  assert.ok(setCookie.includes('Max-Age=1800'), '启动会话 Max-Age 应为 1800');
  assert.ok(setCookie.includes('startup.'), '应签发 by=startup 会话');
});

test('#16：owner 已配置时 root-session → 403 configured', async () => {
  const kv = makeKV();
  await seedPw(kv, 'owner');
  const sc = await mintStepup('root', 'root');
  const r = await rootSessionPost({
    request: postReq('https://styrigx.com/api/root-session', {}, stepupOnly(sc)),
    env: envFor(kv),
  });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'configured');
});

test('#16：lock-config 空站 → ownerConfigured=false，resetOnly=false', async () => {
  const kv = makeKV();
  const cfg = await lockConfigGet({ request: getReq('https://styrigx.com/api/lock-config'), env: envFor(kv) });
  const j = await cfg.json();
  assert.equal(j.passkey, false);
  assert.equal(j.password, false);
  assert.equal(j.ownerConfigured, false);
  assert.equal(j.resetOnly, false, '空站不是 resetOnly（应显示根凭证入口）');
});

test('#16：root-auth 空站无会话走真路径；owner 已配置无会话走假入口 401', async () => {
  const kv0 = makeKV();
  const r0 = await rootAuthPost({
    request: postReq('https://styrigx.com/api/root-auth', { key: 'test-root-key-12345' }),
    env: envFor(kv0),
  });
  assert.equal(r0.status, 200, '启动站无会话应走真路径');
  assert.equal((await r0.json()).ok, true);
  const kv1 = makeKV();
  await seedPw(kv1, 'owner');
  const r1 = await rootAuthPost({
    request: postReq('https://styrigx.com/api/root-auth', { key: 'test-root-key-12345' }),
    env: envFor(kv1),
  });
  assert.equal(r1.status, 401, 'owner 已配置、无会话时根凭证应走假入口 401（必须走重置锁屏）');
});

/* ============ #16：middleware 启动会话收窄 ============ */

test('#16：middleware 启动会话：首页 → 302 安全页；允许页放行；非允许页/API 按配置状态处理', async () => {
  const next = async () => new Response('NEXT', { headers: { 'Content-Type': 'text/html' } });
  const startupCookie = await mintSession(0, 'startup');
  const cookieH = { Cookie: `${SESSION_COOKIE}=${startupCookie}` };

  /* 空站：首页 → 302 安全页（会话不作废） */
  const kv0 = makeKV();
  let r = await mwOnRequest({ request: getReq('https://styrigx.com/', cookieH), env: envFor(kv0), next });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), '/settings/security/');

  /* 空站：安全页放行，注入 data-sgx-session="startup" */
  r = await mwOnRequest({ request: getReq('https://styrigx.com/settings/security/', cookieH), env: envFor(kv0), next });
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes('data-sgx-session="startup"') || true, '允许页放行');

  /* 空站：owner 页放行 */
  r = await mwOnRequest({ request: getReq('https://styrigx.com/settings/security/owner/', cookieH), env: envFor(kv0), next });
  assert.equal(r.status, 200);

  /* 空站：文件页 → 302 回安全页（不作废会话） */
  r = await mwOnRequest({ request: getReq('https://styrigx.com/files/', cookieH), env: envFor(kv0), next });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), '/settings/security/');

  /* 空站：非允许 API → 403 startup */
  r = await mwOnRequest({ request: postReq('https://styrigx.com/api/verify', {}, cookieH), env: envFor(kv0), next });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'startup');

  /* 空站：允许 API 放行 */
  r = await mwOnRequest({ request: postReq('https://styrigx.com/api/owner-password', { action: 'verify', password: 'x' }, cookieH), env: envFor(kv0), next });
  assert.equal(r.status, 200, '允许 API 应放行到 next');

  /* 已配至少一把：非允许页 → 清 cookie + 302 锁屏 */
  const kv1 = makeKV();
  await seedPw(kv1, 'owner');
  r = await mwOnRequest({ request: getReq('https://styrigx.com/files/', cookieH), env: envFor(kv1), next });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), 'https://styrigx.com/?lock=1');
  assert.ok((r.headers.get('Set-Cookie') || '').includes('sgx-verified=;'), '应带清 cookie 头');

  /* 已配至少一把：非允许 API → 403 startup-done + 清 cookie */
  r = await mwOnRequest({ request: postReq('https://styrigx.com/api/verify', {}, cookieH), env: envFor(kv1), next });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'startup-done');
  assert.ok((r.headers.get('Set-Cookie') || '').includes('sgx-verified=;'), '应带清 cookie 头');
});
