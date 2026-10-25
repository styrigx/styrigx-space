/**
 * LockReauthTicket / LockResetTicket（锁屏凭证再验证、重置锁屏）+ 删除应用凭证。
 *
 * 覆盖：
 * - 短票（_kernel/tickets.js）：LockReauth / LockReset 用 SGX_LOCK_* 签、各自 cookie；签名串带 cookie 名，
 *   互相冒充不了；账号钥匙签的票验不过；by 按票限制（LockReset 只认 root / account）；纪元 = Lock 纪元
 * - 再验证：解锁密码 verify reauth:true 只签 LockReauthTicket 不签会话；访客写死「密码错误」不读存储；没会话 401；
 *   锁屏通行密钥 auth reauth:true 同样要 admin 会话、访客写死失败；
 *   根凭证 /api/root-auth purpose=lock-reauth 签 LockReauthTicket(by=root)
 * - /api/lock-reauth：status（凭证是否已设置 + 票有效期）、clear；LockResetTicket 无会话也能读状态
 * - 管理：lock-passkey / lock-password / lock-all-devices / root-audit 没票 403 reauth、没会话 401；
 *   AccountReauthTicket 不能开锁屏凭证；LockResetTicket 只能 list/register/delete、set/change，不能 rename/remove
 * - 纪元推进（改解锁密码 / 删锁屏通行密钥）：票与当前设备会话随即重签，票剩余时间不延长
 * - 删最后一把锁屏凭证（A-2）：账号未配置 → 403 last-key；账号已配置 → 200，lock-configured 保留
 * - /api/root-session 已删除；锁屏未设置时根凭证只能签 LockResetTicket（purpose=lock-reset）
 * - /api/lock-reset：签 LockResetTicket(by=account)
 * - 删除：/api/stepup、/api/app-token 路由不存在；源码里没有 SGX_STEPUP_* / SGX_APP_*
 *
 * 运行：node --test tests/workers/auth-gateway/lock-reauth.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { testLockSession, testTicket } from './_tickets.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GW = REPO + '/workers/auth-gateway/';
const API = GW + 'functions/api/';

const tickets = await import(GW + 'functions/_kernel/tickets.js');
const { makePasswordRecord } = await import(GW + 'functions/_kernel/password.js');

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
const PEPPER = 'test-pepper';
const ROOT_KEY = 'root-secret-123';

function makeKV(seed = {}, { throwOn = null } = {}) {
  const m = new Map(Object.entries(seed));
  const reads = [];
  return {
    get: async (k, fmt) => {
      reads.push(k);
      if (throwOn && throwOn(k)) throw new Error('kv down');
      const v = m.has(k) ? m.get(k) : null;
      if (v === null) return null;
      return fmt === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter((n) => n.startsWith(prefix)).map((name) => ({ name })) }),
    _map: m,
    _reads: reads,
  };
}

const envFor = (kv, extra = {}) => ({
  KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv,
  SGX_LOCK_PRIVATE: LOCK.priv,
  SGX_LOCK_PUBLIC: LOCK.pub,
  SGX_ACCOUNT_PRIVATE: ACCT.priv,
  SGX_ACCOUNT_PUBLIC: ACCT.pub,
  SGX_PW_PEPPER: PEPPER,
  SGX_ROOT_KEY: ROOT_KEY,
  SGX_RP_ID: 'styrigx.com',
  SGX_ORIGIN: 'https://styrigx.com',
  ...extra,
});

function post(url, body, cookie) {
  const headers = { 'Content-Type': 'application/json', Origin: 'https://styrigx.com', 'CF-Connecting-IP': '203.0.113.9' };
  if (cookie) headers.Cookie = cookie;
  return new Request('https://styrigx.com' + url, { method: 'POST', headers, body: JSON.stringify(body) });
}
function get(url, cookie) {
  return new Request('https://styrigx.com' + url, { headers: cookie ? { Cookie: cookie } : {} });
}
function setCookies(res) {
  return typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
}
function pick(res, name) {
  for (const c of setCookies(res)) {
    if (c.startsWith(name + '=')) return c.slice(name.length + 1).split(';')[0];
  }
  return null;
}
const adminSess = (epoch = 0, by = 'password') => testLockSession(LOCK.priv, epoch, 'admin', by);
const visitorSess = (epoch = 0) => testLockSession(LOCK.priv, epoch, 'visitor');
const reauthTicket = (by = 'password', epoch = 0, now) => testTicket(LOCK.priv, 'LockReauthTicket', by, epoch, now);
const resetTicket = (by = 'root', epoch = 0) => testTicket(LOCK.priv, 'LockResetTicket', by, epoch);
const cookies = (o) => Object.entries(o).map(([k, v]) => k + '=' + v).join('; ');

async function seedLockKey(kv, credId = 'LOCKKEY1234567890', domain = 'lock') {
  kv._map.set(domain + '-passkey:' + credId.slice(0, 12), JSON.stringify({
    name: 'Samsung Pass', provider: '', aaguid: '', createdAt: 1, lastUsedAt: 0,
    credId, publicKey: {}, signCount: 0, uv: 1,
  }));
  const idx = JSON.parse(kv._map.get(domain + '-passkey-index') || '[]');
  idx.push(credId);
  kv._map.set(domain + '-passkey-index', JSON.stringify(idx));
  return credId;
}

/* ================= 短票 ================= */

test('短票：LockReauth / LockReset 用 SGX_LOCK_* 签，纪元 = Lock 纪元；账号钥匙签的票验不过；互相冒充不了', async () => {
  const kv = makeKV({ 'lock-epoch': '4' });
  const t = await reauthTicket('root', 4);
  const ok = await tickets.verifyLockReauthTicket(get('/', 'sgx-lock-reauth=' + t), envFor(kv));
  assert.equal(ok.ok, true);
  assert.equal(ok.by, 'root');
  /* 纪元不对 → epoch-changed */
  const old = await reauthTicket('root', 3);
  assert.equal((await tickets.verifyLockReauthTicket(get('/', 'sgx-lock-reauth=' + old), envFor(kv))).reason, 'epoch-changed');
  /* 账号钥匙签的票 → bad-sig */
  const forged = await testTicket(ACCT.priv, 'LockReauthTicket', 'root', 4);
  assert.equal((await tickets.verifyLockReauthTicket(get('/', 'sgx-lock-reauth=' + forged), envFor(kv))).reason, 'bad-sig');
  /* 同一把钥匙签的 LockReauth 票塞进 sgx-lock-reset：签名串带 cookie 名 → bad-sig */
  assert.equal((await tickets.verifyLockResetTicket(get('/', 'sgx-lock-reset=' + t), envFor(kv))).reason, 'bad-sig');
  /* 只读自己的 cookie */
  assert.equal((await tickets.verifyLockResetTicket(get('/', 'sgx-lock-reauth=' + t), envFor(kv))).reason, 'no-cookie');
  /* 票内容：by.epoch.iat.exp.sig */
  const parts = t.split('.');
  assert.equal(parts.length, 5);
  assert.equal(parts[0], 'root');
  assert.equal(parts[1], '4');
});

test('短票：by 按票限制（LockReset 只认 root / account；LockReauth 不认 account）；3 分钟', async () => {
  await assert.rejects(testTicket(LOCK.priv, 'LockResetTicket', 'password', 0));
  await assert.rejects(testTicket(LOCK.priv, 'LockReauthTicket', 'account', 0));
  await assert.rejects(testTicket(LOCK.priv, 'LockSessionTicket', 'root', 0));
  const r = await resetTicket('account');
  assert.equal(tickets.parseTicket('LockResetTicket', r).by, 'account');
  assert.equal(tickets.SHORT_TICKET_MAX_AGE, 180);
});

/* ================= 再验证 ================= */

test('再验证（解锁密码）：verify reauth:true 只签 3 分钟 LockReauthTicket，不签会话；密码错计入限速', async () => {
  const kv = makeKV({ 'lock-password': JSON.stringify(await makePasswordRecord('lockpass99', PEPPER)) });
  const { onRequestPost } = await import(API + 'lock-password.js');
  const sess = await adminSess();
  let res = await onRequestPost({ request: post('/api/lock-password', { action: 'verify', password: 'lockpass99', reauth: true }, 'sgx-lock-session=' + sess), env: envFor(kv) });
  assert.equal(res.status, 200);
  const t = pick(res, 'sgx-lock-reauth');
  assert.ok(t && t.startsWith('password.0.'), '应签 LockReauthTicket, by=password');
  assert.equal(pick(res, 'sgx-lock-session'), null, '再验证不签会话');
  assert.ok(setCookies(res).some((c) => c.startsWith('sgx-lock-reauth=') && c.includes('Max-Age=180') && !c.includes('Domain=') && c.includes('SameSite=Strict')));
  res = await onRequestPost({ request: post('/api/lock-password', { action: 'verify', password: 'wrong-pass', reauth: true }, 'sgx-lock-session=' + sess), env: envFor(kv) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'wrong');
  assert.equal(kv._map.get('lock-password-fail:203.0.113.9'), '1');
});

test('再验证（解锁密码）：访客写死「密码错误」不读存储；没有会话 → 401 session', async () => {
  const kv = makeKV({ 'lock-password': JSON.stringify(await makePasswordRecord('lockpass99', PEPPER)) });
  const { onRequestPost } = await import(API + 'lock-password.js');
  let res = await onRequestPost({ request: post('/api/lock-password', { action: 'verify', password: 'lockpass99', reauth: true }, 'sgx-lock-session=' + (await visitorSess())), env: envFor(kv) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'wrong');
  assert.deepEqual(kv._reads, [], '访客：不读任何存储');
  res = await onRequestPost({ request: post('/api/lock-password', { action: 'verify', password: 'lockpass99', reauth: true }), env: envFor(kv) });
  assert.equal(res.status, 401);
  assert.equal(pick(res, 'sgx-lock-reauth'), null);
});

test('再验证（锁屏通行密钥）：auth reauth:true 访客写死失败不读存储；没会话 401', async () => {
  const kv = makeKV();
  const { onRequestPost } = await import(API + 'lock-passkey.js');
  let res = await onRequestPost({ request: post('/api/lock-passkey', { action: 'auth', reauth: true, cid: 'x', credential: {} }, 'sgx-lock-session=' + (await visitorSess())), env: envFor(kv) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'verify');
  assert.deepEqual(kv._reads, []);
  res = await onRequestPost({ request: post('/api/lock-passkey', { action: 'auth', reauth: true, cid: 'x', credential: {} }), env: envFor(kv) });
  assert.equal(res.status, 401);
});

test('再验证（根凭证）：purpose=lock-reauth + admin 会话 → 签 LockReauthTicket(by=root)，不签会话；错 → 401；缺 purpose → 400', async () => {
  const kv = makeKV({ 'lock-configured': '1' });
  const { onRequestPost } = await import(API + 'root-auth.js');
  const sess = await adminSess();
  let res = await onRequestPost({ request: post('/api/root-auth', { key: ROOT_KEY, purpose: 'lock-reauth' }, 'sgx-lock-session=' + sess), env: envFor(kv) });
  assert.equal(res.status, 200);
  assert.ok((pick(res, 'sgx-lock-reauth') || '').startsWith('root.'));
  assert.equal(pick(res, 'sgx-lock-session'), null);
  res = await onRequestPost({ request: post('/api/root-auth', { key: 'nope', purpose: 'lock-reauth' }, 'sgx-lock-session=' + sess), env: envFor(kv) });
  assert.equal(res.status, 401);
  res = await onRequestPost({ request: post('/api/root-auth', { key: ROOT_KEY }, 'sgx-lock-session=' + sess), env: envFor(kv) });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'purpose');
  /* 缺锁屏钥匙 → 503 config */
  res = await onRequestPost({ request: post('/api/root-auth', { key: ROOT_KEY, purpose: 'lock-reauth' }, 'sgx-lock-session=' + sess), env: envFor(kv, { SGX_LOCK_PRIVATE: '' }) });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'config');
});

/* ================= /api/lock-reauth ================= */

test('/api/lock-reauth status：有会话无票 → valid=false + 凭证是否已设置；有票 → ticket=lock-reauth + expiresAt', async () => {
  const kv = makeKV({ 'lock-password': JSON.stringify(await makePasswordRecord('lockpass99', PEPPER)) });
  const { onRequestPost } = await import(API + 'lock-reauth.js');
  const sess = await adminSess();
  let res = await onRequestPost({ request: post('/api/lock-reauth', { action: 'status' }, 'sgx-lock-session=' + sess), env: envFor(kv) });
  let j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.valid, false);
  assert.equal(j.password, true);
  assert.equal(j.passkey, false);
  const t = await reauthTicket('password');
  res = await onRequestPost({ request: post('/api/lock-reauth', { action: 'status' }, cookies({ 'sgx-lock-session': sess, 'sgx-lock-reauth': t })), env: envFor(kv) });
  j = await res.json();
  assert.equal(j.valid, true);
  assert.equal(j.ticket, 'lock-reauth');
  assert.ok(j.expiresAt > Date.now() && j.expiresAt <= Date.now() + 180000);
  /* LockReauthTicket 没有会话 → 401 */
  res = await onRequestPost({ request: post('/api/lock-reauth', { action: 'status' }, 'sgx-lock-reauth=' + t), env: envFor(kv) });
  assert.equal(res.status, 401);
});

test('/api/lock-reauth status：LockResetTicket 无会话也能读（ticket=lock-reset）；clear 只清 LockReauthTicket', async () => {
  const kv = makeKV();
  const { onRequestPost } = await import(API + 'lock-reauth.js');
  let res = await onRequestPost({ request: post('/api/lock-reauth', { action: 'status' }, 'sgx-lock-reset=' + (await resetTicket())), env: envFor(kv) });
  const j = await res.json();
  assert.equal(j.valid, true);
  assert.equal(j.ticket, 'lock-reset');
  res = await onRequestPost({ request: post('/api/lock-reauth', { action: 'clear' }), env: envFor(kv) });
  assert.equal(res.status, 200);
  const sc = setCookies(res);
  assert.ok(sc.some((c) => c.startsWith('sgx-lock-reauth=;') && c.includes('Max-Age=0')));
  assert.ok(!sc.some((c) => c.startsWith('sgx-lock-reset=')), '不动 LockResetTicket');
});

/* ================= 管理 ================= */

test('管理：锁屏通行密钥 list —— 没会话 401；有会话没票 403 reauth；AccountReauthTicket 403；LockReauthTicket 200', async () => {
  const kv = makeKV();
  await seedLockKey(kv);
  const { onRequestPost } = await import(API + 'lock-passkey.js');
  const sess = await adminSess();
  const call = (c) => onRequestPost({ request: post('/api/lock-passkey', { action: 'list' }, c), env: envFor(kv) });
  let res = await call('sgx-lock-reauth=' + (await reauthTicket()));
  assert.equal(res.status, 401);
  res = await call('sgx-lock-session=' + sess);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'reauth');
  const acct = await testTicket(ACCT.priv, 'AccountReauthTicket', 'password', 0);
  res = await call(cookies({ 'sgx-lock-session': sess, 'sgx-account-reauth': acct }));
  assert.equal((await res.json()).error, 'reauth');
  res = await call(cookies({ 'sgx-lock-session': sess, 'sgx-lock-reauth': await reauthTicket() }));
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.keys.length, 1);
  assert.equal(j.ticket, 'lock-reauth');
  /* 本接口只列锁屏通行密钥：账号通行密钥（account-passkey:*）不出现 */
  await seedLockKey(kv, 'ACCOUNTKEY123456', 'account');
  res = await call(cookies({ 'sgx-lock-session': sess, 'sgx-lock-reauth': await reauthTicket() }));
  assert.equal((await res.json()).keys.length, 1);
});

test('管理：LockResetTicket 可 list，不可 rename；可改解锁密码，不可删', async () => {
  const kv = makeKV();
  const credId = await seedLockKey(kv);
  const pk = (await import(API + 'lock-passkey.js')).onRequestPost;
  const pw = (await import(API + 'lock-password.js')).onRequestPost;
  const rc = 'sgx-lock-reset=' + (await resetTicket('account'));
  let res = await pk({ request: post('/api/lock-passkey', { action: 'list' }, rc), env: envFor(kv) });
  assert.equal(res.status, 200);
  res = await pk({ request: post('/api/lock-passkey', { action: 'rename', credId, name: 'x' }, rc), env: envFor(kv) });
  assert.equal(res.status, 401, '重置锁屏不能改名（无会话 → 401）');
  res = await pw({ request: post('/api/lock-password', { action: 'set', password: 'newlock123' }, rc), env: envFor(kv) });
  assert.equal(res.status, 200);
  res = await pw({ request: post('/api/lock-password', { action: 'remove' }, rc), env: envFor(kv) });
  assert.equal(res.status, 401, '重置锁屏不能删密码');
});

test('管理：lock-all-devices 要 LockReauthTicket；通过后 epoch+1、清会话和票', async () => {
  const kv = makeKV({ 'lock-epoch': '2' });
  const { onRequestPost } = await import(API + 'lock-all-devices.js');
  const sess = await adminSess(2);
  let res = await onRequestPost({ request: post('/api/lock-all-devices', {}, 'sgx-lock-session=' + sess), env: envFor(kv) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'reauth');
  assert.equal(kv._map.get('lock-epoch'), '2');
  res = await onRequestPost({ request: post('/api/lock-all-devices', {}, cookies({ 'sgx-lock-session': sess, 'sgx-lock-reauth': await reauthTicket('passkey', 2) })), env: envFor(kv) });
  assert.equal(res.status, 200);
  assert.equal(kv._map.get('lock-epoch'), '3');
  const sc = setCookies(res);
  assert.ok(sc.some((c) => c.startsWith('sgx-lock-session=;')));
  assert.ok(sc.some((c) => c.startsWith('sgx-lock-reauth=;')));
});

test('管理：root-audit 要 LockReauthTicket', async () => {
  const kv = makeKV();
  const { onRequestGet } = await import(API + 'root-audit.js');
  const sess = await adminSess();
  let res = await onRequestGet({ request: get('/api/root-audit', 'sgx-lock-session=' + sess), env: envFor(kv) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'reauth');
  res = await onRequestGet({ request: get('/api/root-audit', cookies({ 'sgx-lock-session': sess, 'sgx-lock-reauth': await reauthTicket('root') })), env: envFor(kv) });
  assert.equal(res.status, 200);
});

/* ================= 纪元推进后重签 ================= */

test('改解锁密码：epoch+1，LockReauthTicket 与当前设备会话重签到新纪元，票剩余时间不延长', async () => {
  const kv = makeKV({ 'lock-epoch': '5', 'lock-configured': '1', 'lock-password': JSON.stringify(await makePasswordRecord('lockpass99', PEPPER)) });
  const { onRequestPost } = await import(API + 'lock-password.js');
  const iat = Date.now() - 60000; /* 已过 1 分钟 */
  const t = await reauthTicket('password', 5, iat);
  const res = await onRequestPost({ request: post('/api/lock-password', { action: 'change', password: 'newlock123' }, cookies({ 'sgx-lock-session': await adminSess(5), 'sgx-lock-reauth': t })), env: envFor(kv) });
  assert.equal(res.status, 200);
  assert.equal(kv._map.get('lock-epoch'), '6');
  const nt = tickets.parseTicket('LockReauthTicket', pick(res, 'sgx-lock-reauth'));
  assert.equal(nt.epoch, 6);
  assert.equal(nt.by, 'password');
  assert.equal(nt.exp, iat + 180000, '不延长');
  assert.ok(pick(res, 'sgx-lock-session'), '当前设备会话重签');
});

test('删锁屏通行密钥：epoch+1 后重签票；账号已配置时可删最后一把（lock-configured 保留），未配置 → 403 last-key', async () => {
  const { onRequestPost } = await import(API + 'lock-passkey.js');
  /* 账号未配置：最后一把不能删 */
  let kv = makeKV({ 'lock-epoch': '1', 'lock-configured': '1' });
  let credId = await seedLockKey(kv);
  let res = await onRequestPost({ request: post('/api/lock-passkey', { action: 'delete', credId }, cookies({ 'sgx-lock-session': await adminSess(1), 'sgx-lock-reauth': await reauthTicket('passkey', 1) })), env: envFor(kv) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'last-key');
  assert.equal(kv._map.get('lock-epoch'), '1');
  /* 账号已配置（有账号密码） */
  kv = makeKV({ 'lock-epoch': '1', 'lock-configured': '1', 'account-configured': '1', 'account-password': JSON.stringify(await makePasswordRecord('acctpass99', PEPPER)) });
  credId = await seedLockKey(kv);
  res = await onRequestPost({ request: post('/api/lock-passkey', { action: 'delete', credId }, cookies({ 'sgx-lock-session': await adminSess(1), 'sgx-lock-reauth': await reauthTicket('passkey', 1) })), env: envFor(kv) });
  assert.equal(res.status, 200);
  assert.equal(kv._map.get('lock-epoch'), '2');
  assert.equal(kv._map.get('lock-configured'), '1');
  assert.equal(tickets.parseTicket('LockReauthTicket', pick(res, 'sgx-lock-reauth')).epoch, 2);
});

/* ================= 根凭证 / 重置锁屏 ================= */

test('/api/root-session 已删除：路由和文件都不在', async () => {
  const { API_ROUTES } = await import(GW + 'src/routes.js');
  assert.ok(!API_ROUTES.has('/api/root-session'));
  assert.ok(!existsSync(API + 'root-session.js'));
  assert.ok(!existsSync(REPO + '/web/assets/js/lib/root-session.js'));
});

test('从零设置：锁屏未配置时根凭证无会话只能签 LockResetTicket（purpose=lock-reset）；lock-reauth 无会话 → 假入口 401；已配置时 lock-reset → 401', async () => {
  const { onRequestPost } = await import(API + 'root-auth.js');
  let kv = makeKV();
  let res = await onRequestPost({ request: post('/api/root-auth', { key: ROOT_KEY, purpose: 'lock-reset' }), env: envFor(kv) });
  assert.equal(res.status, 200);
  assert.ok((pick(res, 'sgx-lock-reset') || '').startsWith('root.'));
  assert.equal(pick(res, 'sgx-lock-session'), null, '根凭证不签会话');
  res = await onRequestPost({ request: post('/api/root-auth', { key: ROOT_KEY, purpose: 'lock-reauth' }), env: envFor(kv) });
  assert.equal(res.status, 401);
  kv = makeKV({ 'lock-configured': '1', 'lock-password': JSON.stringify(await makePasswordRecord('lockpass99', PEPPER)) });
  res = await onRequestPost({ request: post('/api/root-auth', { key: ROOT_KEY, purpose: 'lock-reset' }, 'sgx-lock-session=' + (await adminSess())), env: envFor(kv) });
  assert.equal(res.status, 401);
  assert.equal(pick(res, 'sgx-lock-reset'), null);
});

test('/api/lock-reset：恢复开关关闭时根凭证 + 账号密码 → 签 LockResetTicket(by=account)', async () => {
  const kv = makeKV({ 'account-configured': '1', 'account-password': JSON.stringify(await makePasswordRecord('acctpass99', PEPPER)) });
  const { onRequestPost } = await import(API + 'lock-reset.js');
  const res = await onRequestPost({
    request: post('/api/lock-reset', { action: 'verify', rootKey: ROOT_KEY, accountProof: { type: 'password', password: 'acctpass99' } }),
    env: envFor(kv),
  });
  const j = await res.json();
  assert.equal(res.status, 200, JSON.stringify(j));
  assert.ok(!j.needAccount);
  const t = pick(res, 'sgx-lock-reset');
  assert.ok(t && t.startsWith('account.'), t);
});
/* ================= 删除 ================= */

test('删除：/api/stepup、/api/app-token 路由与文件都不在；源码不再引用 SGX_STEPUP_* / SGX_APP_*', async () => {
  const { API_ROUTES } = await import(GW + 'src/routes.js');
  assert.ok(!API_ROUTES.has('/api/stepup'));
  assert.ok(!API_ROUTES.has('/api/app-token'));
  assert.ok(API_ROUTES.has('/api/lock-reauth'));
  assert.ok(!existsSync(API + 'stepup.js'));
  assert.ok(!existsSync(API + 'app-token.js'));
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith('.js')) files.push(path.join(d, e.name));
    }
  };
  walk(GW + 'functions');
  walk(GW + 'src');
  walk(REPO + '/web/assets/js');
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/SGX_STEPUP_|SGX_APP_|\/api\/stepup|\/api\/app-token|sgx-stepup/.test(src), path.relative(REPO, f) + ' 不应再引用 stepup / app 凭证');
  }
});
