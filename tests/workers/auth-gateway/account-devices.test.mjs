/**
 * 账号 › 设备（2026-10-22）：每次登录一台设备记录（deviceId 进票据），设备页列出、可单独退出。
 *
 * 运行：node --test tests/workers/auth-gateway/account-devices.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession, testAccountSession, testTicket } from './_tickets.mjs';
import { makeKV, genKeyPair, postReq as jsonPost, authD1For } from '../_harness.mjs';

/* 本文件的请求都带固定客户端 IP（按 IP 的失败计数键要用） */
const postReq = (url, body, headers = {}) => jsonPost(url, body, { 'CF-Connecting-IP': '10.9.9.9', ...headers });

const API = '../../../workers/auth-gateway/functions/api/';
const KERNEL = '../../../workers/auth-gateway/functions/_kernel/';

let LOCK, ACCOUNT, OTHER;
const ROOT_KEY = 'test-root-key-account-123';
const PEPPER = 'test-pepper-acc';

function envFor(kv, overrides = {}) {
  return {
    /* kv 只当作这份 D1 替身的钥匙（authD1For）；env 里没有 KV */
    D1_LOCK_AUTH: authD1For(kv), D1_ACCOUNT_AUTH: authD1For(kv), D1_ROOT_AUTH: authD1For(kv),
    SGX_ROOT_KEY: ROOT_KEY,
    SGX_LOCK_PRIVATE: LOCK.priv,
    SGX_LOCK_PUBLIC: LOCK.pub,
    SGX_ACCOUNT_PRIVATE: ACCOUNT.priv,
    SGX_ACCOUNT_PUBLIC: ACCOUNT.pub,
    SGX_PW_PEPPER: PEPPER,
    SGX_RP_ID: 'styrigx.com',
    SGX_ORIGIN: 'https://styrigx.com',
    ...overrides,
  };
}

function getReq(url, headers = {}) {
  return new Request(url, { method: 'GET', headers });
}

async function adminSess(epoch = 0) {
  return await testLockSession(LOCK.priv, epoch, 'admin', 'password');
}
async function visitorSess() {
  return await testLockSession(LOCK.priv, 0, 'visitor');
}
async function accTicket(by = 'password', authAt = Date.now(), epoch = 0, priv) {
  return await testAccountSession(priv || ACCOUNT.priv, by, epoch, authAt);
}
function cookies(o) {
  return Object.entries(o).filter(([, v]) => v).map(([k, v]) => k + '=' + v).join('; ');
}
function setCookies(res) {
  return res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('Set-Cookie') || ''];
}
function pickCookie(res, name) {
  for (const c of setCookies(res)) {
    if (c.startsWith(name + '=')) return c.split(';')[0].slice(name.length + 1);
  }
  return null;
}

async function reauthTicket(by = 'password', epoch = 0, priv, now) {
  return await testTicket(priv || ACCOUNT.priv, 'AccountReauthTicket', by, epoch, now);
}
/* 管理操作要 AccountReauthTicket：测试里带了账号会话又没显式给 sgx-account-reauth（键不存在）时，自动补一张同纪元的票；
   要测「没有票」就显式传 'sgx-account-reauth': '' */
async function withReauth(cookieObj) {
  const o = { ...(cookieObj || {}) };
  if (o['sgx-account-session'] && !('sgx-account-reauth' in o)) {
    const by = String(o['sgx-account-session']).split('.')[0];
    const ep = parseInt(String(o['sgx-account-session']).split('.')[1], 10) || 0;
    o['sgx-account-reauth'] = await reauthTicket(by, ep);
  }
  return o;
}
async function accountPost(kv, body, cookieObj, envOverrides) {
  const { onRequestPost } = await import(API + 'account.js');
  const co = await withReauth(cookieObj);
  return await onRequestPost({ request: postReq('https://styrigx.com/api/account', body, { Cookie: cookies(co) }), env: envFor(kv, envOverrides) });
}
async function accountGet(kv, cookieObj, envOverrides) {
  const { onRequestGet } = await import(API + 'account.js');
  return await onRequestGet({ request: getReq('https://styrigx.com/api/account', { Cookie: cookies(cookieObj) }), env: envFor(kv, envOverrides) });
}
async function seedPassword(kv, pw) {
  const { makePasswordRecord } = await import(KERNEL + 'password.js');
  authD1For(kv).putPassword('account', await makePasswordRecord(pw, PEPPER));
}
/** D1 device 表里这台的行（realm=account；没有 → null） */
function devRow(kv, deviceId) {
  const r = authD1For(kv).rows('device').find((x) => x.device_id === deviceId);
  return r ? { ...r, rec: JSON.parse(r.record) } : null;
}
/** 未退出的设备行 */
const liveDevices = (kv) => authD1For(kv).rows('device').filter((r) => r.revoked_at === 0);


const SM_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36';
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

async function login(kv, cookieObj, ua, device, extra) {
  const { onRequestPost } = await import(API + 'account.js');
  const req = postReq('https://styrigx.com/api/account', { action: 'login-password', password: 'acct-pass-1234', device, ...(extra || {}) }, { Cookie: cookies(cookieObj), 'User-Agent': ua });
  return await onRequestPost({ request: req, env: envFor(kv) });
}
async function post(kv, body, cookieObj, ua) {
  const { onRequestPost } = await import(API + 'account.js');
  return await onRequestPost({ request: postReq('https://styrigx.com/api/account', body, { Cookie: cookies(cookieObj), 'User-Agent': ua || SM_UA }), env: envFor(kv) });
}
async function get(kv, cookieObj) {
  const { onRequestGet } = await import(API + 'account.js');
  return await onRequestGet({ request: new Request('https://styrigx.com/api/account', { headers: { Cookie: cookies(cookieObj), 'User-Agent': SM_UA } }), env: envFor(kv) });
}

/* 测试钥匙：before 里生成（不算一条用例，单独跑某条用例时也会先执行） */
before(async () => {
  LOCK = await genKeyPair(); ACCOUNT = await genKeyPair(); OTHER = await genKeyPair();
});

test('型号映射与 UA 解析', async () => {
  const d = await import(KERNEL + 'account-devices.js');
  assert.equal(d.modelName('SM-S918B'), 'Galaxy S23 Ultra');
  assert.equal(d.modelName('SM-S9180'), 'Galaxy S23 Ultra');
  assert.equal(d.modelName('SM-X710'), 'Galaxy Tab S9');
  assert.equal(d.modelName('Pixel 9'), 'Pixel 9');
  assert.equal(d.modelName(''), '');
  assert.deepEqual(d.parseUserAgent(SM_UA), { browser: 'Samsung Internet', platform: 'Android', model: '' });
  assert.deepEqual(d.parseUserAgent(WIN_UA), { browser: 'Chrome', platform: 'Windows', model: '' });
  assert.equal(d.parseUserAgent('Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A) Chrome/120').model, 'SM-S918B');
  assert.ok(d.isDeviceId(d.newDeviceId()));
  assert.equal(d.newDeviceId().length, 16);
});

test('登录记一台设备（型号来自 hints）；同一浏览器再登录（再验一次）沿用 deviceId，不多一台', async () => {
  const kv = makeKV();
  await seedPassword(kv, 'acct-pass-1234');
  const sess = await adminSess();
  const r1 = await login(kv, { 'sgx-lock-session': sess }, SM_UA, { model: 'SM-S918B', platform: 'Android', platformVersion: '15.0.0' });
  assert.equal(r1.status, 200);
  const acc1 = pickCookie(r1, 'sgx-account-session');
  assert.equal(acc1.split('.').length, 6, '票六段（带 deviceId）');
  const deviceId = acc1.split('.')[4];
  const row = devRow(kv, deviceId);
  assert.equal(row.realm, 'account');
  assert.equal(row.revoked_at, 0);
  const rec = row.rec;
  assert.equal(rec.deviceId, deviceId, '记录字段叫 deviceId');
  assert.equal('sid' in rec, false);
  assert.equal(rec.model, 'SM-S918B');
  assert.equal(rec.browser, 'Samsung Internet');
  assert.equal(rec.by, 'password');
  /* 再验一次（reauth:true），带着现有账号会话 → 同一个 deviceId */
  const r2 = await login(kv, { 'sgx-lock-session': sess, 'sgx-account-session': acc1 }, SM_UA, null, { reauth: true });
  assert.equal(r2.status, 200);
  assert.equal(pickCookie(r2, 'sgx-account-session').split('.')[4], deviceId);
  assert.equal(authD1For(kv).rows('device').length, 1);
  assert.equal(devRow(kv, deviceId).rec.model, 'SM-S918B', '这次没带 hints，型号保留');
});

test('devices 列出：此设备排第一并标 current；GET session.device 是此设备名字', async () => {
  const kv = makeKV();
  await seedPassword(kv, 'acct-pass-1234');
  const sess = await adminSess();
  const pc = pickCookie(await login(kv, { 'sgx-lock-session': sess }, WIN_UA, null), 'sgx-account-session');
  const phone = pickCookie(await login(kv, { 'sgx-lock-session': sess }, SM_UA, { model: 'SM-S918B', platform: 'Android' }), 'sgx-account-session');
  const r = await post(kv, { action: 'device-list' }, { 'sgx-lock-session': sess, 'sgx-account-session': phone });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.devices.length, 2);
  assert.equal(j.devices[0].current, true);
  assert.equal(j.devices[0].name, 'Galaxy S23 Ultra');
  assert.equal(j.devices[1].current, false);
  assert.equal(j.devices[1].name, 'Windows');
  assert.equal(j.devices[1].browser, 'Chrome');
  const g = await (await get(kv, { 'sgx-lock-session': sess, 'sgx-account-session': phone })).json();
  assert.equal(g.session.device, 'Galaxy S23 Ultra');
  /* 不需要 reauth 票，但要账号会话 */
  const r401 = await post(kv, { action: 'device-list' }, { 'sgx-lock-session': sess });
  assert.equal(r401.status, 401);
  assert.ok(pc);
});

test('device-revoke：别的设备立即失效（revoked）；不能退出此设备；不存在 404', async () => {
  const kv = makeKV();
  await seedPassword(kv, 'acct-pass-1234');
  const sess = await adminSess();
  const pc = pickCookie(await login(kv, { 'sgx-lock-session': sess }, WIN_UA, null), 'sgx-account-session');
  const phone = pickCookie(await login(kv, { 'sgx-lock-session': sess }, SM_UA, null), 'sgx-account-session');
  const pcDeviceId = pc.split('.')[4];
  const phoneDeviceId = phone.split('.')[4];
  const self = await post(kv, { action: 'device-revoke', deviceId: phoneDeviceId }, { 'sgx-lock-session': sess, 'sgx-account-session': phone });
  assert.equal(self.status, 400);
  assert.equal((await self.json()).error, 'current');
  const ok = await post(kv, { action: 'device-revoke', deviceId: pcDeviceId }, { 'sgx-lock-session': sess, 'sgx-account-session': phone });
  assert.equal(ok.status, 200);
  assert.ok(devRow(kv, pcDeviceId).revoked_at > 0, '行留着、标成已退出');
  assert.ok(!liveDevices(kv).some((r) => r.device_id === pcDeviceId), '设备页不再列出');
  const { verifyAccountSession } = await import(KERNEL + 'account-session.js');
  const v = await verifyAccountSession(new Request('https://styrigx.com/', { headers: { Cookie: 'sgx-account-session=' + pc } }), envFor(kv));
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'revoked');
  const again = await post(kv, { action: 'device-revoke', deviceId: pcDeviceId }, { 'sgx-lock-session': sess, 'sgx-account-session': phone });
  assert.equal(again.status, 404);
  const bad = await post(kv, { action: 'device-revoke', deviceId: 'x.y' }, { 'sgx-lock-session': sess, 'sgx-account-session': phone });
  assert.equal(bad.status, 400);
});

test('退出账号：删本机记录并拉黑 deviceId', async () => {
  const kv = makeKV();
  await seedPassword(kv, 'acct-pass-1234');
  const sess = await adminSess();
  const phone = pickCookie(await login(kv, { 'sgx-lock-session': sess }, SM_UA, null), 'sgx-account-session');
  const deviceId = phone.split('.')[4];
  const r = await post(kv, { action: 'logout' }, { 'sgx-account-session': phone });
  assert.equal(r.status, 200);
  assert.ok(devRow(kv, deviceId).revoked_at > 0, '本机标成已退出');
  assert.equal(liveDevices(kv).length, 0);
  /* 下一个请求：同一张票不再算登录 */
  const g = await (await get(kv, { 'sgx-lock-session': sess, 'sgx-account-session': phone })).json();
  assert.equal(g.session, null);
});

test('五段票（没有 deviceId 的旧格式）：不认，GET 当没登录、不下发新票、不记设备', async () => {
  const kv = makeKV();
  const sess = await adminSess();
  const six = await accTicket('passkey', Date.now() - 86400e3, 0);
  const p = six.split('.');
  assert.equal(p.length, 6);
  const five = [p[0], p[1], p[2], p[3], p[5]].join('.');
  const r = await get(kv, { 'sgx-lock-session': sess, 'sgx-account-session': five });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.session, null);
  assert.equal(pickCookie(r, 'sgx-account-session') || '', '');
  assert.equal(authD1For(kv).rows('device').length, 0);
});

test('改账号密码（纪元 +1）：当前设备沿用 deviceId，其他设备记录删掉', async () => {
  const kv = makeKV();
  await seedPassword(kv, 'acct-pass-1234');
  const sess = await adminSess();
  const pc = pickCookie(await login(kv, { 'sgx-lock-session': sess }, WIN_UA, null), 'sgx-account-session');
  const phone = pickCookie(await login(kv, { 'sgx-lock-session': sess }, SM_UA, null), 'sgx-account-session');
  const reauth = await reauthTicket('password', 0);
  const r = await post(kv, { action: 'password-change', password: 'acct-pass-5678' }, { 'sgx-lock-session': sess, 'sgx-account-session': phone, 'sgx-account-reauth': reauth });
  assert.equal(r.status, 200, await r.clone().text());
  const nv = pickCookie(r, 'sgx-account-session');
  assert.equal(nv.split('.')[4], phone.split('.')[4]);
  assert.equal(nv.split('.')[1], '1');
  assert.equal(devRow(kv, pc.split('.')[4]), null);
  assert.ok(devRow(kv, phone.split('.')[4]) && devRow(kv, phone.split('.')[4]).revoked_at === 0);
});

test('票据篡改 deviceId → bad-sig', async () => {
  const kv = makeKV();
  await seedPassword(kv, 'acct-pass-1234');
  const sess = await adminSess();
  const phone = pickCookie(await login(kv, { 'sgx-lock-session': sess }, SM_UA, null), 'sgx-account-session');
  const p = phone.split('.');
  p[4] = 'AAAAAAAAAAAAAAAA';
  const { verifyAccountSession } = await import(KERNEL + 'account-session.js');
  const v = await verifyAccountSession(new Request('https://styrigx.com/', { headers: { Cookie: 'sgx-account-session=' + p.join('.') } }), envFor(kv));
  assert.equal(v.reason, 'bad-sig');
});

test('device-revoke 在下一个请求就生效：被退出的那台 GET 当没登录、管理操作 401；同一张票再登录（reauth）也不会把它复活', async () => {
  const kv = makeKV();
  await seedPassword(kv, 'acct-pass-1234');
  const sess = await adminSess();
  const pc = pickCookie(await login(kv, { 'sgx-lock-session': sess }, WIN_UA, null), 'sgx-account-session');
  const phone = pickCookie(await login(kv, { 'sgx-lock-session': sess }, SM_UA, null), 'sgx-account-session');
  const pcId = pc.split('.')[4];
  /* 退出前 pc 好好的 */
  let g = await (await get(kv, { 'sgx-lock-session': sess, 'sgx-account-session': pc })).json();
  assert.ok(g.session, '退出前是登录状态');
  const ok = await post(kv, { action: 'device-revoke', deviceId: pcId }, { 'sgx-lock-session': sess, 'sgx-account-session': phone });
  assert.equal(ok.status, 200);
  /* 紧接着的下一个请求：没有任何等待（KV 时代最长约 60 秒还认） */
  g = await (await get(kv, { 'sgx-lock-session': sess, 'sgx-account-session': pc })).json();
  assert.equal(g.session, null, '被退出的票立刻不认');
  const list = await post(kv, { action: 'device-list' }, { 'sgx-lock-session': sess, 'sgx-account-session': pc });
  assert.equal(list.status, 401);
  /* 带着被退出的票再登录：发新 deviceId，旧行仍是已退出（upsert 不清 revoked_at） */
  const again = await login(kv, { 'sgx-lock-session': sess, 'sgx-account-session': pc }, WIN_UA, null, { reauth: true });
  assert.equal(again.status, 200);
  const fresh = pickCookie(again, 'sgx-account-session');
  assert.notEqual(fresh.split('.')[4], pcId, '被退出的 deviceId 不再沿用');
  assert.ok(devRow(kv, pcId).revoked_at > 0, '还是已退出');
  const { verifyAccountSession } = await import(KERNEL + 'account-session.js');
  const v = await verifyAccountSession(new Request('https://styrigx.com/', { headers: { Cookie: 'sgx-account-session=' + pc } }), envFor(kv));
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'revoked');
  /* 另一台不受影响 */
  g = await (await get(kv, { 'sgx-lock-session': sess, 'sgx-account-session': phone })).json();
  assert.ok(g.session);
});

test('putDevice / recordLogin 对已退出的 deviceId：不改 revoked_at、不改记录（upsert 永不复活）；revokeDevice 对没有的 id 也插一行已退出的', async () => {
  const d = await import(KERNEL + 'account-devices.js');
  const kv = makeKV();
  const env = envFor(kv);
  const id = d.newDeviceId();
  await d.recordLogin(env, id, 'password', Date.now(), { model: 'SM-S918B' });
  assert.equal(await d.isRevoked(env, id), false);
  await d.revokeDevice(env, id);
  assert.equal(await d.isRevoked(env, id), true);
  const revokedAt = devRow(kv, id).revoked_at;
  await d.putDevice(env, { deviceId: id, model: 'X', lastSeen: Date.now() });
  await d.recordLogin(env, id, 'passkey', Date.now(), { model: 'Y' });
  assert.equal(devRow(kv, id).revoked_at, revokedAt, 'revoked_at 不变');
  assert.equal(devRow(kv, id).rec.model, 'SM-S918B', '记录也不被覆盖');
  assert.equal(await d.isRevoked(env, id), true);
  assert.equal(await d.getDevice(env, id), null, '已退出的不当成设备');
  assert.deepEqual(await d.listDevices(env), []);
  const ghost = d.newDeviceId();
  await d.revokeDevice(env, ghost);
  assert.equal(await d.isRevoked(env, ghost), true);
  /* D1 出错：isRevoked 抛错（调用方按无效处理，不当成没退出） */
  authD1For(kv).failOn = (sql) => /FROM device/.test(sql);
  await assert.rejects(d.isRevoked(env, id));
});

test('设备列表有上限（DEVICE_LIST_MAX，最近活跃在前）；当前设备没排进去时 device-list 单独补上、排第一', async () => {
  const d = await import(KERNEL + 'account-devices.js');
  assert.equal(d.DEVICE_LIST_MAX, 50);
  const kv = makeKV();
  await seedPassword(kv, 'acct-pass-1234');
  const sess = await adminSess();
  /* 先登录「当前设备」，再塞 DEVICE_LIST_MAX 台更近活跃的 */
  const phone = pickCookie(await login(kv, { 'sgx-lock-session': sess }, SM_UA, { model: 'SM-S918B', platform: 'Android' }), 'sgx-account-session');
  const phoneId = phone.split('.')[4];
  const env = envFor(kv);
  const base = Date.now() + 1000;
  for (let i = 0; i < d.DEVICE_LIST_MAX; i++) {
    await d.putDevice(env, { deviceId: d.newDeviceId(), model: 'X' + i, lastSeen: base + i, createdAt: base });
  }
  const top = await d.listDevices(env);
  assert.equal(top.length, d.DEVICE_LIST_MAX);
  assert.ok(!top.some((x) => x.deviceId === phoneId), '当前设备最久没活跃，被上限挤出');
  assert.equal(top[0].model, 'X' + (d.DEVICE_LIST_MAX - 1), '最近活跃在前');
  assert.equal((await d.listDevices(env, 3)).length, 3);
  assert.equal((await d.listDevices(env, 1e9)).length, d.DEVICE_LIST_MAX, '传大数也封顶');
  const r = await post(kv, { action: 'device-list' }, { 'sgx-lock-session': sess, 'sgx-account-session': phone });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.devices.length, d.DEVICE_LIST_MAX + 1);
  assert.equal(j.devices[0].current, true);
  assert.equal(j.devices[0].name, 'Galaxy S23 Ultra');
  assert.equal(j.devices.filter((x) => x.current).length, 1);
});
