/**
 * 鉴权重做：锁屏凭证的门（取代 stepup）+ 删除应用凭证。
 *
 * 覆盖：
 * - 门票（_kernel/door.js）：door=lock / lockreset 用 SGX_LOCK_* 签；账号钥匙签的票验不过；
 *   by 按门限制（lockreset 只认 root / account+root）；纪元 = session-epoch
 * - 进门：解锁密码 verify door:true 只签门票不签会话；访客写死「密码错误」不读存储；没会话 401；
 *   锁屏通行密钥 auth door:true 同样要 owner 会话、访客写死失败；
 *   根凭证 /api/root-auth 签 door=lock(by=root)
 * - /api/lock-door：status（凭证是否已设置 + 门票有效期）、clear；重置门票无会话也能读状态
 * - 门禁：owner-passkey / owner-password / lock-all-devices / root-audit 没门票 403 door、没会话 401；
 *   账号门票（door=account）不能开锁屏的门；重置门票只能 list/register/delete、set/change，不能 rename/remove
 * - 纪元推进（改解锁密码 / 删锁屏通行密钥）：门票与当前设备会话随即重签，门票剩余时间不延长
 * - 删最后一把锁屏凭证（A-2）：账号未配置 → 403 last-key；账号已配置 → 200，layer:lock 保留
 * - root-session：只认 by=root 的锁屏门票，且锁屏未配置
 * - lockreset：签 door=lockreset
 * - 删除：/api/stepup、/api/app-token 路由不存在；源码里没有 SGX_STEPUP_* / SGX_APP_*
 *
 * 运行：node --test tests/workers/auth-gateway/lock-door.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GW = REPO + '/workers/auth-gateway/';
const API = GW + 'functions/api/';

const door = await import(GW + 'functions/_kernel/door.js');
const { signSessionCookie } = await import(GW + 'functions/_kernel/session.js');
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
const ownerSess = (epoch = 0, by = 'owner') => signSessionCookie(LOCK.priv, epoch, 'owner', by);
const visitorSess = (epoch = 0) => signSessionCookie(LOCK.priv, epoch, 'visitor', 'owner');
const lockTicket = (by = 'password', epoch = 0, now) => door.signDoorTicket(LOCK.priv, 'lock', by, epoch, now);
const resetTicket = (by = 'root', epoch = 0) => door.signDoorTicket(LOCK.priv, 'lockreset', by, epoch);
const cookies = (o) => Object.entries(o).map(([k, v]) => k + '=' + v).join('; ');

async function seedLockKey(kv, credId = 'LOCKKEY1234567890') {
  kv._map.set('owner-passkey:' + credId.slice(0, 12), JSON.stringify({
    name: 'Samsung Pass', provider: '', aaguid: '', createdAt: 1, lastUsedAt: 0,
    credId, publicKey: {}, signCount: 0, uv: 1, class: 'lock',
  }));
  const idx = JSON.parse(kv._map.get('owner-passkey-index') || '[]');
  idx.push(credId);
  kv._map.set('owner-passkey-index', JSON.stringify(idx));
  return credId;
}

/* ================= 门票 ================= */

test('门票：lock / lockreset 用 SGX_LOCK_* 签，纪元 = session-epoch；账号钥匙签的票验不过', async () => {
  const kv = makeKV({ 'session-epoch': '4' });
  const t = await lockTicket('root', 4);
  const ok = await door.verifyDoorCookie(get('/', 'sgx-door=' + t), envFor(kv), 'lock');
  assert.equal(ok.ok, true);
  assert.equal(ok.by, 'root');
  /* 纪元不对 → epoch-changed */
  const old = await lockTicket('root', 3);
  assert.equal((await door.verifyDoorCookie(get('/', 'sgx-door=' + old), envFor(kv), 'lock')).reason, 'epoch-changed');
  /* 账号钥匙签的 lock 票 → bad-sig */
  const forged = await door.signDoorTicket(ACCT.priv, 'lock', 'root', 4);
  assert.equal((await door.verifyDoorCookie(get('/', 'sgx-door=' + forged), envFor(kv), 'lock')).reason, 'bad-sig');
  /* 门不对 → wrong-door */
  assert.equal((await door.verifyDoorCookie(get('/', 'sgx-door=' + t), envFor(kv), 'lockreset')).reason, 'wrong-door');
  const acct = await door.signDoorTicket(ACCT.priv, 'account', 'password', 0);
  assert.equal((await door.verifyDoorCookie(get('/', 'sgx-door=' + acct), envFor(kv), 'lock')).reason, 'wrong-door');
});

test('门票：by 按门限制（lockreset 只认 root / account+root；lock 不认 account+root）', async () => {
  await assert.rejects(door.signDoorTicket(LOCK.priv, 'lockreset', 'password', 0));
  await assert.rejects(door.signDoorTicket(LOCK.priv, 'lock', 'account+root', 0));
  await assert.rejects(door.signDoorTicket(LOCK.priv, 'stepup', 'root', 0));
  const r = await resetTicket('account+root');
  assert.equal(door.parseDoorTicket(r).by, 'account+root');
  assert.equal(door.DOOR_MAX_AGE, 180);
});

/* ================= 进门 ================= */

test('进门（解锁密码）：verify door:true 只签 3 分钟锁屏门票，不签会话；密码错计入限速', async () => {
  const kv = makeKV({ 'lock-pw': JSON.stringify(await makePasswordRecord('lockpass99', PEPPER)) });
  const { onRequestPost } = await import(API + 'owner-password.js');
  const sess = await ownerSess();
  let res = await onRequestPost({ request: post('/api/owner-password', { action: 'verify', password: 'lockpass99', door: true }, 'sgx-verified=' + sess), env: envFor(kv) });
  assert.equal(res.status, 200);
  const t = pick(res, 'sgx-door');
  assert.ok(t && t.startsWith('door.lock.password.0.'), '应签 door=lock, by=password');
  assert.equal(pick(res, 'sgx-verified'), null, '门口验证不签会话');
  assert.ok(setCookies(res).some((c) => c.startsWith('sgx-door=') && c.includes('Max-Age=180') && !c.includes('Domain=')));
  res = await onRequestPost({ request: post('/api/owner-password', { action: 'verify', password: 'wrong-pass', door: true }, 'sgx-verified=' + sess), env: envFor(kv) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'wrong');
  assert.equal(kv._map.get('pw-fail:203.0.113.9'), '1');
});

test('进门（解锁密码）：访客写死「密码错误」不读存储；没有会话 → 401 session', async () => {
  const kv = makeKV({ 'lock-pw': JSON.stringify(await makePasswordRecord('lockpass99', PEPPER)) });
  const { onRequestPost } = await import(API + 'owner-password.js');
  let res = await onRequestPost({ request: post('/api/owner-password', { action: 'verify', password: 'lockpass99', door: true }, 'sgx-verified=' + (await visitorSess())), env: envFor(kv) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'wrong');
  assert.deepEqual(kv._reads, [], '访客：不读任何存储');
  res = await onRequestPost({ request: post('/api/owner-password', { action: 'verify', password: 'lockpass99', door: true }), env: envFor(kv) });
  assert.equal(res.status, 401);
  assert.equal(pick(res, 'sgx-door'), null);
});

test('进门（锁屏通行密钥）：auth door:true 访客写死失败不读存储；没会话 401', async () => {
  const kv = makeKV();
  const { onRequestPost } = await import(API + 'owner-passkey.js');
  let res = await onRequestPost({ request: post('/api/owner-passkey', { action: 'auth', door: true, cid: 'x', credential: {} }, 'sgx-verified=' + (await visitorSess())), env: envFor(kv) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'verify');
  assert.deepEqual(kv._reads, []);
  res = await onRequestPost({ request: post('/api/owner-passkey', { action: 'auth', door: true, cid: 'x', credential: {} }), env: envFor(kv) });
  assert.equal(res.status, 401);
});

test('进门（根凭证）：有会话 → 签 door=lock(by=root)，不签会话；错 → 401', async () => {
  const kv = makeKV({ 'layer:lock': '1' });
  const { onRequestPost } = await import(API + 'root-auth.js');
  const sess = await ownerSess();
  let res = await onRequestPost({ request: post('/api/root-auth', { key: ROOT_KEY }, 'sgx-verified=' + sess), env: envFor(kv) });
  assert.equal(res.status, 200);
  assert.ok((pick(res, 'sgx-door') || '').startsWith('door.lock.root.'));
  assert.equal(pick(res, 'sgx-verified'), null);
  assert.equal(pick(res, 'sgx-stepup'), null);
  res = await onRequestPost({ request: post('/api/root-auth', { key: 'nope' }, 'sgx-verified=' + sess), env: envFor(kv) });
  assert.equal(res.status, 401);
  /* 缺锁屏钥匙 → 503 config（不再看 SGX_STEPUP_*） */
  res = await onRequestPost({ request: post('/api/root-auth', { key: ROOT_KEY }, 'sgx-verified=' + sess), env: envFor(kv, { SGX_LOCK_PRIVATE: '' }) });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'config');
});

/* ================= /api/lock-door ================= */

test('/api/lock-door status：有会话无门票 → valid=false + 凭证是否已设置；有门票 → expiresAt', async () => {
  const kv = makeKV({ 'lock-pw': JSON.stringify(await makePasswordRecord('lockpass99', PEPPER)) });
  const { onRequestPost } = await import(API + 'lock-door.js');
  const sess = await ownerSess();
  let res = await onRequestPost({ request: post('/api/lock-door', { action: 'status' }, 'sgx-verified=' + sess), env: envFor(kv) });
  let j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.valid, false);
  assert.equal(j.password, true);
  assert.equal(j.passkey, false);
  const t = await lockTicket('password');
  res = await onRequestPost({ request: post('/api/lock-door', { action: 'status' }, cookies({ 'sgx-verified': sess, 'sgx-door': t })), env: envFor(kv) });
  j = await res.json();
  assert.equal(j.valid, true);
  assert.equal(j.door, 'lock');
  assert.ok(j.expiresAt > Date.now() && j.expiresAt <= Date.now() + 180000);
  /* 锁屏门票没有会话 → 401 */
  res = await onRequestPost({ request: post('/api/lock-door', { action: 'status' }, 'sgx-door=' + t), env: envFor(kv) });
  assert.equal(res.status, 401);
});

test('/api/lock-door status：重置门票无会话也能读（door=lockreset）；clear 清门票', async () => {
  const kv = makeKV();
  const { onRequestPost } = await import(API + 'lock-door.js');
  let res = await onRequestPost({ request: post('/api/lock-door', { action: 'status' }, 'sgx-door=' + (await resetTicket())), env: envFor(kv) });
  const j = await res.json();
  assert.equal(j.valid, true);
  assert.equal(j.door, 'lockreset');
  res = await onRequestPost({ request: post('/api/lock-door', { action: 'clear' }), env: envFor(kv) });
  assert.equal(res.status, 200);
  assert.ok(setCookies(res).some((c) => c.startsWith('sgx-door=;') && c.includes('Max-Age=0')));
});

/* ================= 门禁 ================= */

test('门禁：锁屏通行密钥 list —— 没会话 401；有会话没门票 403 door；账号门票 403 door；锁屏门票 200', async () => {
  const kv = makeKV();
  await seedLockKey(kv);
  const { onRequestPost } = await import(API + 'owner-passkey.js');
  const sess = await ownerSess();
  const call = (c) => onRequestPost({ request: post('/api/owner-passkey', { action: 'list', pkClass: 'lock' }, c), env: envFor(kv) });
  let res = await call('sgx-door=' + (await lockTicket()));
  assert.equal(res.status, 401);
  res = await call('sgx-verified=' + sess);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'door');
  const acct = await door.signDoorTicket(ACCT.priv, 'account', 'password', 0);
  res = await call(cookies({ 'sgx-verified': sess, 'sgx-door': acct }));
  assert.equal((await res.json()).error, 'door');
  res = await call(cookies({ 'sgx-verified': sess, 'sgx-door': await lockTicket() }));
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.keys.length, 1);
  assert.equal(j.door, 'lock');
  /* 账号通行密钥：一律 403 scope（只在账号页管理） */
  res = await onRequestPost({ request: post('/api/owner-passkey', { action: 'list', pkClass: 'owner' }, cookies({ 'sgx-verified': sess, 'sgx-door': await lockTicket() })), env: envFor(kv) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).reason, 'account');
  /* 应用类已删除 → 400 params */
  res = await onRequestPost({ request: post('/api/owner-passkey', { action: 'list', pkClass: 'app' }, cookies({ 'sgx-verified': sess, 'sgx-door': await lockTicket() })), env: envFor(kv) });
  assert.equal(res.status, 400);
});

test('门禁：重置门票可 list，不可 rename；可改解锁密码，不可删', async () => {
  const kv = makeKV();
  const credId = await seedLockKey(kv);
  const pk = (await import(API + 'owner-passkey.js')).onRequestPost;
  const pw = (await import(API + 'owner-password.js')).onRequestPost;
  const rc = 'sgx-door=' + (await resetTicket('account+root'));
  let res = await pk({ request: post('/api/owner-passkey', { action: 'list', pkClass: 'lock' }, rc), env: envFor(kv) });
  assert.equal(res.status, 200);
  res = await pk({ request: post('/api/owner-passkey', { action: 'rename', credId, name: 'x' }, rc), env: envFor(kv) });
  assert.equal(res.status, 401, '重置门票不能改名（无会话 → 401）');
  res = await pw({ request: post('/api/owner-password', { action: 'set', kind: 'lock', password: 'newlock123' }, rc), env: envFor(kv) });
  assert.equal(res.status, 200);
  res = await pw({ request: post('/api/owner-password', { action: 'remove', kind: 'lock' }, rc), env: envFor(kv) });
  assert.equal(res.status, 401, '重置门票不能删密码');
});

test('门禁：lock-all-devices 要锁屏门票；通过后 epoch+1、清会话和门票', async () => {
  const kv = makeKV({ 'session-epoch': '2' });
  const { onRequestPost } = await import(API + 'lock-all-devices.js');
  const sess = await ownerSess(2);
  let res = await onRequestPost({ request: post('/api/lock-all-devices', {}, 'sgx-verified=' + sess), env: envFor(kv) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'door');
  assert.equal(kv._map.get('session-epoch'), '2');
  res = await onRequestPost({ request: post('/api/lock-all-devices', {}, cookies({ 'sgx-verified': sess, 'sgx-door': await lockTicket('passkey', 2) })), env: envFor(kv) });
  assert.equal(res.status, 200);
  assert.equal(kv._map.get('session-epoch'), '3');
  const sc = setCookies(res);
  assert.ok(sc.some((c) => c.startsWith('sgx-verified=;')));
  assert.ok(sc.some((c) => c.startsWith('sgx-door=;')));
});

test('门禁：root-audit 要锁屏门票', async () => {
  const kv = makeKV();
  const { onRequestGet } = await import(API + 'root-audit.js');
  const sess = await ownerSess();
  let res = await onRequestGet({ request: get('/api/root-audit', 'sgx-verified=' + sess), env: envFor(kv) });
  assert.equal(res.status, 403);
  res = await onRequestGet({ request: get('/api/root-audit', cookies({ 'sgx-verified': sess, 'sgx-door': await lockTicket('root') })), env: envFor(kv) });
  assert.equal(res.status, 200);
});

/* ================= 纪元推进后重签 ================= */

test('改解锁密码：epoch+1，门票与当前设备会话重签到新纪元，门票剩余时间不延长', async () => {
  const kv = makeKV({ 'session-epoch': '5', 'layer:lock': '1', 'lock-pw': JSON.stringify(await makePasswordRecord('lockpass99', PEPPER)) });
  const { onRequestPost } = await import(API + 'owner-password.js');
  const iat = Date.now() - 60000; /* 已过 1 分钟 */
  const t = await lockTicket('password', 5, iat);
  const res = await onRequestPost({ request: post('/api/owner-password', { action: 'change', kind: 'lock', password: 'newlock123' }, cookies({ 'sgx-verified': await ownerSess(5), 'sgx-door': t })), env: envFor(kv) });
  assert.equal(res.status, 200);
  assert.equal(kv._map.get('session-epoch'), '6');
  const nt = door.parseDoorTicket(pick(res, 'sgx-door'));
  assert.equal(nt.epoch, 6);
  assert.equal(nt.by, 'password');
  assert.equal(nt.exp, iat + 180000, '不延长');
  assert.ok(pick(res, 'sgx-verified'), '当前设备会话重签');
});

test('删锁屏通行密钥：epoch+1 后重签门票；账号已配置时可删最后一把（layer:lock 保留），未配置 → 403 last-key', async () => {
  const { onRequestPost } = await import(API + 'owner-passkey.js');
  /* 账号未配置：最后一把不能删 */
  let kv = makeKV({ 'session-epoch': '1', 'layer:lock': '1' });
  let credId = await seedLockKey(kv);
  let res = await onRequestPost({ request: post('/api/owner-passkey', { action: 'delete', credId }, cookies({ 'sgx-verified': await ownerSess(1), 'sgx-door': await lockTicket('passkey', 1) })), env: envFor(kv) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'last-key');
  assert.equal(kv._map.get('session-epoch'), '1');
  /* 账号已配置（有账号密码） */
  kv = makeKV({ 'session-epoch': '1', 'layer:lock': '1', 'layer:owner': '1', 'owner-pw': JSON.stringify(await makePasswordRecord('acctpass99', PEPPER)) });
  credId = await seedLockKey(kv);
  res = await onRequestPost({ request: post('/api/owner-passkey', { action: 'delete', credId }, cookies({ 'sgx-verified': await ownerSess(1), 'sgx-door': await lockTicket('passkey', 1) })), env: envFor(kv) });
  assert.equal(res.status, 200);
  assert.equal(kv._map.get('session-epoch'), '2');
  assert.equal(kv._map.get('layer:lock'), '1');
  assert.equal(door.parseDoorTicket(pick(res, 'sgx-door')).epoch, 2);
});

/* ================= 根凭证代开 / 重置锁屏 ================= */

test('root-session：锁屏未配置 + by=root 锁屏门票 → by=root 会话；by≠root 或已配置 → 403', async () => {
  const { onRequestPost } = await import(API + 'root-session.js');
  let kv = makeKV();
  let res = await onRequestPost({ request: post('/api/root-session', {}, 'sgx-door=' + (await lockTicket('root'))), env: envFor(kv) });
  assert.equal(res.status, 200);
  assert.ok((pick(res, 'sgx-verified') || '').startsWith('root.owner.'));
  res = await onRequestPost({ request: post('/api/root-session', {}, 'sgx-door=' + (await lockTicket('password'))), env: envFor(kv) });
  assert.equal(res.status, 403);
  res = await onRequestPost({ request: post('/api/root-session', {}), env: envFor(kv) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'door');
  kv = makeKV({ 'layer:lock': '1' });
  res = await onRequestPost({ request: post('/api/root-session', {}, 'sgx-door=' + (await lockTicket('root'))), env: envFor(kv) });
  assert.equal(res.status, 403);
});

test('引导：锁屏未配置时根凭证无会话也能签 by=root 锁屏门票（再换 root-session）', async () => {
  const kv = makeKV();
  const { onRequestPost } = await import(API + 'root-auth.js');
  const res = await onRequestPost({ request: post('/api/root-auth', { key: ROOT_KEY }), env: envFor(kv) });
  assert.equal(res.status, 200);
  assert.ok((pick(res, 'sgx-door') || '').startsWith('door.lock.root.'));
});

test('lockreset：恢复开关关闭时根凭证 + 账号密码 → 签 door=lockreset(by=account+root)', async () => {
  const kv = makeKV({ 'layer:owner': '1', 'owner-pw': JSON.stringify(await makePasswordRecord('acctpass99', PEPPER)) });
  const { onRequestPost } = await import(API + 'lockreset.js');
  const res = await onRequestPost({
    request: post('/api/lockreset', { action: 'verify', rootKey: ROOT_KEY, ownerProof: { type: 'password', password: 'acctpass99' } }),
    env: envFor(kv),
  });
  const j = await res.json();
  assert.equal(res.status, 200, JSON.stringify(j));
  assert.ok(!j.needOwner);
  const t = pick(res, 'sgx-door');
  assert.ok(t && t.startsWith('door.lockreset.account+root.'), t);
});

/* ================= 删除 ================= */

test('删除：/api/stepup、/api/app-token 路由与文件都不在；源码不再引用 SGX_STEPUP_* / SGX_APP_*', async () => {
  const { API_ROUTES } = await import(GW + 'src/routes.js');
  assert.ok(!API_ROUTES.has('/api/stepup'));
  assert.ok(!API_ROUTES.has('/api/app-token'));
  assert.ok(API_ROUTES.has('/api/lock-door'));
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
