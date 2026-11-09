/**
 * 账号 session 30 天滑动续期（2026-11-09；以前 400 天）：
 * - TICKET.session.maxAge = 30 天；剩不到 15 天才重签（SESSION_RENEW_BELOW）；reauth / reset 3 分钟、锁屏进门 12 小时不变
 * - 账号接口的响应（rpc/account-service.js serviceFetch → withSessionRenewal）：需要续且验证通过 → 按原 by / authAt / epoch / deviceId 重签，
 *   cookie 名和属性不变，只换 exp / Max-Age；登录标记一起续
 * - 不需要续的请求不写 Set-Cookie；响应自己已经设了 session cookie（登录 / 退出）不碰；验不过的票（篡改 / 纪元不对 / 退出 / 过期）不续
 * - 2026-11-09 之前签的 400 天旧票：第一次用到就重签成 30 天；设备 30 天没用过的旧票按过期处理（只这一次）
 * - 单独退出的设备行仍保留 400 天（比旧票长），活跃设备行跟着 session 滑动（30 天）
 *
 * 运行：node --test tests/workers/account/session-sliding.test.mjs
 */
import './_cf-workers.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  K, keys, makeEnv, accSession, idHeaders, cookies, setCookies, pickCookie, setEpoch, one, TEST_DEVICE_ID,
  session, devices, config,
} from './_fixtures.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const { serviceFetch, withSessionRenewal } = await import(REPO + 'workers/account/src/rpc/account-service.js');
const ticket = await import(REPO + 'workers/account/src/lib/ticket.js');
const realms = await import(REPO + 'workers/space-core/src/core/realms.js');

before(keys);

const DAY = 86400000;
const CTX = { waitUntil() {} };
const SESSION_ATTRS = /^sgx-account-session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000$/;

/** 剩 leftMs 毫秒的 session 票（exp = now + leftMs） */
function sessionLeft(leftMs, o = {}) {
  return ticket.signTicket(o.priv || K.ACCOUNT.priv, config.TICKET.session, {
    by: o.by || 'passkey', epoch: o.epoch || 0, at: o.authAt || Date.now() - 100 * DAY, exp: Date.now() + leftMs, deviceId: o.deviceId || TEST_DEVICE_ID,
  });
}

/** 经 AccountService 发 GET /api/account（网关写好身份头） */
function getAccount(env, ck) {
  return serviceFetch(new Request('https://styrigx.com/api/account', { headers: { ...idHeaders(), Cookie: cookies(ck) } }), env, CTX);
}

test('时长：session 30 天、剩不到 15 天才续；reauth / reset 3 分钟、锁屏进门 12 小时不变；cookie 名不变', () => {
  assert.equal(config.TICKET.session.maxAge, 30 * 86400);
  assert.equal(config.TICKET_MAX_AGE.session, 2592000);
  assert.equal(config.SESSION_RENEW_BELOW, 15 * 86400);
  assert.equal(config.SIGNED_IN_MARKER.maxAge, 2592000, '登录标记跟着 session');
  assert.equal(config.TICKET.session.cookie, 'sgx-account-session');
  assert.equal(config.TICKET.reauth.maxAge, 180);
  assert.equal(config.TICKET.reset.maxAge, 180);
  assert.equal(realms.TICKETS[realms.LOCK_SESSION_TICKET].maxAge, 43200, '锁屏进门 12 小时');
  assert.equal(config.LEGACY_SESSION_MAX_AGE, 34560000);
});

test('sessionNeedsRenewal：剩 20 天 / 正好 30 天不续；剩 14 天续；已过期不续；400 天旧票续', () => {
  const now = Date.now();
  assert.equal(session.sessionNeedsRenewal(now + 20 * DAY, now), false);
  assert.equal(session.sessionNeedsRenewal(now + 30 * DAY, now), false);
  assert.equal(session.sessionNeedsRenewal(now + 15 * DAY + 1000, now), false);
  assert.equal(session.sessionNeedsRenewal(now + 14 * DAY, now), true);
  assert.equal(session.sessionNeedsRenewal(now + 1000, now), true);
  assert.equal(session.sessionNeedsRenewal(now - 1000, now), false);
  assert.equal(session.sessionNeedsRenewal(now + 390 * DAY, now), true);
  assert.equal(session.isLegacyExp(now + 31 * DAY + 1000, now), true);
  assert.equal(session.isLegacyExp(now + 30 * DAY, now), false);
});

test('剩 20 天：GET /api/account 照常 200，不写 session cookie（不是每个请求都续）', async () => {
  const env = makeEnv();
  const r = await getAccount(env, { 'sgx-account-session': await sessionLeft(20 * DAY) });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).session, '会话有效');
  assert.equal(pickCookie(r, 'sgx-account-session'), null);
  assert.equal(pickCookie(r, 'sgx-account-signed-in'), null);
});

test('剩 10 天：重签——同 by / authAt / epoch / deviceId，exp ≈ now + 30 天，cookie 属性不变，登录标记一起续；新票验得过', async () => {
  const env = makeEnv();
  setEpoch(env, 4);
  const authAt = Date.now() - 200 * DAY;
  const r = await getAccount(env, { 'sgx-account-session': await sessionLeft(10 * DAY, { by: 'password', epoch: 4, authAt }) });
  assert.equal(r.status, 200);
  const c = setCookies(r);
  const sc = c.filter((x) => x.startsWith('sgx-account-session='));
  assert.equal(sc.length, 1);
  assert.match(sc[0], SESSION_ATTRS);
  assert.ok(c.includes('sgx-account-signed-in=1; Path=/; Secure; SameSite=Strict; Max-Age=2592000'));
  const v = pickCookie(r, 'sgx-account-session');
  const p = session.parseSessionTicket(v);
  assert.equal(p.by, 'password');
  assert.equal(p.epoch, 4);
  assert.equal(p.authAt, authAt);
  assert.equal(p.deviceId, TEST_DEVICE_ID);
  assert.ok(Math.abs(p.exp - (Date.now() + 30 * DAY)) < 60000);
  const chk = await session.verifySession(new Request('https://styrigx.com/api/account', { headers: { Cookie: 'sgx-account-session=' + v } }), env);
  assert.equal(chk.ok, true);
  /* 设备记录不新增（record:false；touch 补的那一行就是这台） */
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM account_device').n, 1);
});

test('验不过的票不续：别的钥匙签、纪元不对、已单独退出、已过期', async () => {
  const env = makeEnv();
  setEpoch(env, 2);
  for (const v of [await sessionLeft(5 * DAY, { priv: K.OTHER.priv, epoch: 2 }), await sessionLeft(5 * DAY, { epoch: 1 }), await sessionLeft(-DAY, { epoch: 2 })]) {
    const r = await getAccount(env, { 'sgx-account-session': v });
    assert.equal(pickCookie(r, 'sgx-account-session'), null);
  }
  await devices.revokeDevice(env, TEST_DEVICE_ID);
  const r = await getAccount(env, { 'sgx-account-session': await sessionLeft(5 * DAY, { epoch: 2 }) });
  assert.equal(pickCookie(r, 'sgx-account-session'), null);
});

test('响应自己已设了 session cookie（登录 / 退出 / 轮换）：不再加第二条；5xx 不续', async () => {
  const env = makeEnv();
  const req = new Request('https://styrigx.com/api/account/session', { method: 'POST', headers: { Cookie: 'sgx-account-session=' + (await sessionLeft(5 * DAY)) } });
  const cleared = new Response('{}', { status: 200, headers: [['Set-Cookie', 'sgx-account-session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT']] });
  const out = await withSessionRenewal(req, env, cleared);
  assert.equal(setCookies(out).filter((x) => x.startsWith('sgx-account-session=')).length, 1);
  assert.match(setCookies(out)[0], /Max-Age=0/);
  const err = await withSessionRenewal(req, env, new Response('{}', { status: 503 }));
  assert.equal(pickCookie(err, 'sgx-account-session'), null);
  const ok = await withSessionRenewal(req, env, new Response('{}', { status: 200 }));
  assert.match(setCookies(ok).find((x) => x.startsWith('sgx-account-session=')), SESSION_ATTRS);
});

test('400 天旧票：设备最近用过 → 有效并重签成 30 天；设备 31 天没用过 → 按过期处理，不续', async () => {
  const env = makeEnv();
  const legacy = await sessionLeft(390 * DAY);
  await devices.putDevice(env, { deviceId: TEST_DEVICE_ID, by: 'passkey', createdAt: Date.now() - 10 * DAY, authAt: Date.now() - 10 * DAY, lastSeen: Date.now() - 2 * DAY });
  const r = await getAccount(env, { 'sgx-account-session': legacy });
  assert.equal(r.status, 200);
  const p = session.parseSessionTicket(pickCookie(r, 'sgx-account-session'));
  assert.ok(p && Math.abs(p.exp - (Date.now() + 30 * DAY)) < 60000, '旧票第一次用到就缩成 30 天');

  const env2 = makeEnv();
  await devices.putDevice(env2, { deviceId: TEST_DEVICE_ID, by: 'passkey', createdAt: Date.now() - 100 * DAY, authAt: Date.now() - 100 * DAY, lastSeen: Date.now() - 31 * DAY });
  const req = new Request('https://styrigx.com/api/account', { headers: { Cookie: 'sgx-account-session=' + legacy } });
  assert.equal((await session.verifySession(req, env2)).reason, 'expired');
  const r2 = await getAccount(env2, { 'sgx-account-session': legacy });
  assert.equal((await r2.json()).session, null);
  assert.equal(pickCookie(r2, 'sgx-account-session'), null);
});

test('设备行：活跃行 expires_at ≈ now + 30 天（跟着 session 滑动）；单独退出的行保留 400 天（比旧票长）', async () => {
  const env = makeEnv();
  await devices.putDevice(env, { deviceId: TEST_DEVICE_ID, by: 'passkey', lastSeen: Date.now() });
  const a = one(env, 'SELECT expires_at FROM account_device WHERE device_id = ?', TEST_DEVICE_ID);
  assert.ok(Math.abs(Number(a.expires_at) - (Date.now() + 30 * DAY)) < 60000);
  await devices.revokeDevice(env, TEST_DEVICE_ID);
  const b = one(env, 'SELECT expires_at FROM account_device WHERE device_id = ?', TEST_DEVICE_ID);
  assert.ok(Math.abs(Number(b.expires_at) - (Date.now() + 400 * DAY)) < 60000);
  /* 退出后，哪怕是 400 天旧票也一直被拒 */
  const req = new Request('https://styrigx.com/api/account', { headers: { Cookie: 'sgx-account-session=' + (await sessionLeft(390 * DAY)) } });
  assert.equal((await session.verifySession(req, env)).reason, 'revoked');
});

test('新签的 session（登录）就是 30 天', async () => {
  const v = await accSession('passkey');
  const p = session.parseSessionTicket(v);
  assert.ok(Math.abs(p.exp - (Date.now() + 30 * DAY)) < 60000);
});
