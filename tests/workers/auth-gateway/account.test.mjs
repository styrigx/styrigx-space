/**
 * 账号体系（管理员凭证升级为账号）：/api/account、root-auth target=account、/api/stepup enter。
 *
 * 覆盖：
 * - 账号登录三个入口（账号通行密钥 / 账号密码 / 根凭证）任一成功都签发 sgx-account，
 *   by 分别为 passkey / password / root；不签 sgx-stepup、不动 sgx-verified
 * - 账号会话独立：只有 lock 会话（sgx-verified）→ 不算账号；把 lock 会话值塞进 sgx-account
 *   或用别的钥匙签 → 拒绝；账号接口仍要求 admin lock 会话作为前置条件
 * - 进门：近期（≤10 分钟）账号登录 → stepup(by=account, scope=keys)；过旧 → 403 account-stale
 * - 账号会话 400 天；账号页管理操作要 AccountReauthTicket sgx-account-reauth（reauth:true 登录 / 根凭证 purpose:account-reauth 签发，3 分钟，离开即清）
 * - 存储：账号密码 account-password、账号通行密钥 account-passkey:*（第 5 层键名；数据由迁移脚本搬过来，值不变）
 * - 恢复：根凭证登录可重置账号密码、删除账号通行密钥；account-epoch +1，旧账号会话失效
 * - 缺 SGX_ACCOUNT_*：账号登录 503 config，其余接口不受影响
 *
 * 运行：node --test tests/workers/auth-gateway/account.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession, testAccountSession, testTicket } from './_tickets.mjs';

const API = '../../../workers/auth-gateway/functions/api/';
const KERNEL = '../../../workers/auth-gateway/functions/_kernel/';

function makeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k, type) {
      if (!store.has(k)) return null;
      const v = store.get(k);
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix } = {}) {
      return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) };
    },
  };
}

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}
async function edPair() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    priv: derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY'),
    pub: derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY'),
  };
}

let LOCK, ACCOUNT, OTHER;
const ROOT_KEY = 'test-root-key-account-123';
const PEPPER = 'test-pepper-acc';

function envFor(kv, overrides = {}) {
  return {
    KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv,
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

function postReq(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://styrigx.com', 'CF-Connecting-IP': '10.9.9.9', ...headers },
    body: JSON.stringify(body),
  });
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
async function resetTicket(epoch = 0, priv, now) {
  return await testTicket(priv || ACCOUNT.priv, 'AccountResetTicket', 'root', epoch, now);
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
  await kv.put('account-password', JSON.stringify(await makePasswordRecord(pw, PEPPER)));
}

/* ---- WebAuthn 断言（测试用 P-256 钥匙，结构同 session-security.test.mjs） ---- */
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** 按存储格式直接写一把通行密钥；domain = 'account'（账号通行密钥）| 'lock'（锁屏通行密钥） */
async function seedPasskey(kv, domain = 'account') {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const credId = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const idx = JSON.parse((await kv.get(domain + '-passkey-index')) || '[]');
  idx.push(credId);
  await kv.put(domain + '-passkey-index', JSON.stringify(idx));
  await kv.put(domain + '-passkey:' + credId.slice(0, 12), JSON.stringify({
    name: '管理员通行密钥', provider: 'Samsung Pass', aaguid: '', createdAt: 1, lastUsedAt: 0,
    credId, publicKey: jwk, signCount: 0, uv: 1,
  }));
  return { kp, credId };
}
function toDer(raw) {
  const trim = (v) => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    v = v.slice(i);
    if (v[0] >= 0x80) { const w = new Uint8Array(v.length + 1); w.set(v, 1); return w; }
    return v;
  };
  const r = trim(raw.slice(0, 32)), s = trim(raw.slice(32, 64));
  const len = 2 + r.length + 2 + s.length;
  const der = new Uint8Array(2 + len);
  let o = 0;
  der[o++] = 0x30; der[o++] = len;
  der[o++] = 0x02; der[o++] = r.length; der.set(r, o); o += r.length;
  der[o++] = 0x02; der[o++] = s.length; der.set(s, o);
  return der;
}
async function assertion(kp, credId, challenge, userHandle) {
  const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('styrigx.com')));
  const authData = new Uint8Array(37);
  authData.set(rpIdHash, 0);
  authData[32] = 0x05; /* UP + UV */
  authData[36] = 1;
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'https://styrigx.com' }));
  const cdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
  const base = new Uint8Array(authData.length + cdHash.length);
  base.set(authData, 0);
  base.set(cdHash, authData.length);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, base));
  return {
    id: credId,
    rawId: credId,
    type: 'public-key',
    response: {
      clientDataJSON: b64url(clientDataJSON),
      authenticatorData: b64url(authData),
      signature: b64url(toDer(raw)),
      userHandle: userHandle || null,
    },
  };
}

test('setup: 生成测试钥匙', async () => {
  LOCK = await edPair();
  ACCOUNT = await edPair();
  OTHER = await edPair();
  assert.ok(ACCOUNT.priv.includes('PRIVATE KEY'));
});

/* ============ 登录入口一：账号密码 ============ */


test('账号密码登录：错误 → 403 wrong；未设置 → 403 not-set；都不签 cookie', async () => {
  const kv = makeKV();
  let res = await accountPost(kv, { action: 'login-password', password: 'whatever-123' }, { 'sgx-lock-session': await adminSess() });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'not-set');
  await seedPassword(kv, 'right-password-1');
  res = await accountPost(kv, { action: 'login-password', password: 'wrong-password-1' }, { 'sgx-lock-session': await adminSess() });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'wrong');
  assert.equal(res.headers.get('Set-Cookie'), null);
});

test('账号密码限速：同 IP 连错 5 次 → 429 cooldown（冷却中密码对也进不去）；计数键 account-password-fail / -cooldown，和锁屏密码分开', async () => {
  const kv = makeKV();
  await seedPassword(kv, 'right-password-1');
  const c = { 'sgx-lock-session': await adminSess() };
  for (let i = 0; i < 4; i++) {
    const r = await accountPost(kv, { action: 'login-password', password: 'wrong-password-1' }, c);
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'wrong');
  }
  assert.equal(await kv.get('account-password-fail:10.9.9.9'), '4');
  assert.equal(await kv.get('lock-password-fail:10.9.9.9'), null, '不计入锁屏密码的计数');
  const fifth = await accountPost(kv, { action: 'login-password', password: 'wrong-password-1' }, c);
  assert.equal(fifth.status, 429);
  assert.equal((await fifth.json()).error, 'cooldown');
  assert.ok(Number(await kv.get('account-password-cooldown:10.9.9.9')) > Date.now());
  const ok = await accountPost(kv, { action: 'login-password', password: 'right-password-1' }, c);
  assert.equal(ok.status, 429, '冷却中密码对也不验');
  assert.equal(ok.headers.get('Set-Cookie'), null);
  /* 冷却过了：对的密码登录成功并清计数 */
  await kv.put('account-password-cooldown:10.9.9.9', String(Date.now() - 1));
  const after = await accountPost(kv, { action: 'login-password', password: 'right-password-1' }, c);
  assert.equal(after.status, 200);
  assert.equal(await kv.get('account-password-fail:10.9.9.9'), null);
  assert.equal(await kv.get('account-password-cooldown:10.9.9.9'), null);
});

/* ============ 登录入口二：账号通行密钥 ============ */

test('账号通行密钥登录→ sgx-account(by=passkey)；legacy userHandle 也接受', async () => {
  const kv = makeKV({ 'account-configured': '1', 'lock-user-id': 'legacy-handle-xyz' });
  const { kp, credId } = await seedPasskey(kv, 'account');
  const sess = await adminSess();
  const ch = await accountPost(kv, { action: 'login-challenge' }, { 'sgx-lock-session': sess });
  assert.equal(ch.status, 200);
  const cj = await ch.json();
  assert.deepEqual(cj.allowCredentials, [{ id: credId, type: 'public-key' }]);
  assert.ok(await kv.get('account-passkey-challenge:' + cj.cid), 'challenge 存在 account-passkey-challenge: 前缀下');
  const cred = await assertion(kp, credId, cj.challenge, 'legacy-handle-xyz');
  const res = await accountPost(kv, { action: 'login-passkey', cid: cj.cid, credential: cred }, { 'sgx-lock-session': sess });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const acc = pickCookie(res, 'sgx-account-session');
  assert.ok(acc && acc.startsWith('passkey.0.'));
  assert.equal(pickCookie(res, 'sgx-stepup'), null);
  /* challenge 单次使用 */
  const replay = await accountPost(kv, { action: 'login-passkey', cid: cj.cid, credential: cred }, { 'sgx-lock-session': sess });
  assert.equal(replay.status, 403);
  assert.equal((await replay.json()).error, 'challenge');
});

test('账号通行密钥登录：锁屏通行密钥（lock-passkey:*）不能登录账号', async () => {
  const kv = makeKV();
  const { kp, credId } = await seedPasskey(kv, 'lock');
  const ch = await accountPost(kv, { action: 'login-challenge' }, { 'sgx-lock-session': await adminSess() });
  assert.equal(ch.status, 403);
  assert.equal((await ch.json()).error, 'not-set');
  await kv.put('account-passkey-challenge:c1', JSON.stringify({ challenge: 'abc', purpose: 'login', exp: Date.now() + 60000 }));
  const res = await accountPost(kv, { action: 'login-passkey', cid: 'c1', credential: await assertion(kp, credId, 'abc') }, { 'sgx-lock-session': await adminSess() });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('Set-Cookie'), null);
});

/* ============ 登录入口三：根凭证 ============ */

test('重置登录（/api/root-auth purpose=account-reset）→ 只签 AccountResetTicket(by=root)，不签账号会话；审计 path=account-reset', async () => {
  const { onRequestPost } = await import(API + 'root-auth.js');
  const kv = makeKV({ 'lock-configured': '1' });
  const res = await onRequestPost({
    request: postReq('https://styrigx.com/api/root-auth', { key: ROOT_KEY, purpose: 'account-reset' }, { Cookie: 'sgx-lock-session=' + (await adminSess()) }),
    env: envFor(kv),
  });
  assert.equal(res.status, 200);
  assert.equal(pickCookie(res, 'sgx-account-session'), null, '根凭证不签账号会话');
  const t = pickCookie(res, 'sgx-account-reset');
  assert.ok(t && t.startsWith('root.0.'), '签 AccountResetTicket(by=root)');
  assert.ok(setCookies(res).some((c) => c.startsWith('sgx-account-reset=') && c.includes('Max-Age=180') && c.includes('SameSite=Strict') && !c.includes('Domain=')));
  const audits = [...kv.store.entries()].filter(([k]) => k.startsWith('root-audit:')).map(([, v]) => JSON.parse(v));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].ok, true);
  assert.equal(audits[0].path, 'account-reset');
});

test('重置登录 purpose=account-reset：无 lock 会话（即使 lock 未配置）走假入口 401；访客 401 denied；错误根凭证 401 auth', async () => {
  const { onRequestPost } = await import(API + 'root-auth.js');
  const kv = makeKV(); /* lock 未配置：只有 lock-reset 能无会话走真路径 */
  let res = await onRequestPost({ request: postReq('https://styrigx.com/api/root-auth', { key: ROOT_KEY, purpose: 'account-reset' }), env: envFor(kv) });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { ok: false, error: 'auth' });
  assert.equal(pickCookie(res, 'sgx-account-reset'), null);
  res = await onRequestPost({ request: postReq('https://styrigx.com/api/root-auth', { key: ROOT_KEY, purpose: 'account-reset' }, { Cookie: 'sgx-lock-session=' + (await visitorSess()) }), env: envFor(kv) });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'denied');
  const kv2 = makeKV({ 'lock-configured': '1' });
  res = await onRequestPost({ request: postReq('https://styrigx.com/api/root-auth', { key: 'wrong', purpose: 'account-reset' }, { Cookie: 'sgx-lock-session=' + (await adminSess()) }), env: envFor(kv2) });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'auth');
});

test('账号再验证（/api/root-auth purpose=account-reauth）：要账号会话（没有 → 401 account），签 AccountReauthTicket(by=root)', async () => {
  const { onRequestPost } = await import(API + 'root-auth.js');
  const kv = makeKV({ 'lock-configured': '1' });
  let res = await onRequestPost({ request: postReq('https://styrigx.com/api/root-auth', { key: ROOT_KEY, purpose: 'account-reauth' }, { Cookie: 'sgx-lock-session=' + (await adminSess()) }), env: envFor(kv) });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'account');
  res = await onRequestPost({ request: postReq('https://styrigx.com/api/root-auth', { key: ROOT_KEY, purpose: 'account-reauth' }, { Cookie: cookies({ 'sgx-lock-session': await adminSess(), 'sgx-account-session': await accTicket('password') }) }), env: envFor(kv) });
  assert.equal(res.status, 200);
  assert.ok((pickCookie(res, 'sgx-account-reauth') || '').startsWith('root.0.'));
});

test('AccountResetTicket：没有账号会话也能改账号密码 / 列出 / 删除账号通行密钥（推 Account 纪元、票重签）；不能管设备', async () => {
  const kv = makeKV({ 'account-configured': '1' });
  await seedPassword(kv, 'old-account-password-1');
  const base = { 'sgx-lock-session': await adminSess(), 'sgx-account-reset': await resetTicket(0) };
  let r = await accountPost(kv, { action: 'passkey-list' }, base);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).by, 'root', '前端据此显示「重置」标题');
  r = await accountPost(kv, { action: 'password-change', password: 'brand-new-pass-1' }, base);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, changed: true });
  assert.equal(await kv.get('account-epoch'), '1');
  assert.equal(pickCookie(r, 'sgx-account-session'), null, '重置登录不签账号会话');
  assert.ok((pickCookie(r, 'sgx-account-reset') || '').startsWith('root.1.'), 'reset 票重签到新纪元');
  r = await accountPost(kv, { action: 'device-list' }, base);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'account');
  /* 没有 reset 票也没有账号会话 → 401 account */
  r = await accountPost(kv, { action: 'passkey-list' }, { 'sgx-lock-session': await adminSess() });
  assert.equal(r.status, 401);
});

/* ============ 独立性：lock 会话绝不等于账号会话 ============ */




/* ============ 进门：近期账号登录 ============ */



test('账号会话 400 天：登录很久以前（远超 10 分钟）也还是登录态，GET 照样返回 session', async () => {
  const kv = makeKV();
  const r = await accountGet(kv, { 'sgx-lock-session': await adminSess(), 'sgx-account-session': await accTicket('password', Date.now() - 30 * 24 * 3600 * 1000) });
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(j.session, '账号会话仍有效');
  assert.equal(j.reauth, null, '没再验证就没有 reauth 票');
  assert.equal(j.reset, null);
});

test('账号安全：改动必须有 AccountReauthTicket —— 没有票 403 reauth；票过期 / 别的钥匙签 / 纪元不对都 403 reauth；只读 list 不要票', async () => {
  const kv = makeKV();
  const base = { 'sgx-lock-session': await adminSess(), 'sgx-account-session': await accTicket('password') };
  const body = { action: 'password-change', password: 'new-password-123' };
  const r1 = await accountPost(kv, body, { ...base, 'sgx-account-reauth': '' });
  assert.equal(r1.status, 403);
  assert.equal((await r1.json()).error, 'reauth');
  const old = await reauthTicket('password', 0, undefined, Date.now() - 181 * 1000);
  const r2 = await accountPost(kv, body, { ...base, 'sgx-account-reauth': old });
  assert.equal((await r2.json()).error, 'reauth');
  const forged = await reauthTicket('password', 0, OTHER.priv);
  const r3 = await accountPost(kv, body, { ...base, 'sgx-account-reauth': forged });
  assert.equal((await r3.json()).error, 'reauth');
  const wrongEpoch = await reauthTicket('password', 5);
  const r4 = await accountPost(kv, body, { ...base, 'sgx-account-reauth': wrongEpoch });
  assert.equal((await r4.json()).error, 'reauth');
  /* 拿账号会话票冒充 reauth 票（同一把钥匙签）→ 格式 / 签名串不符，拒绝 */
  const r5 = await accountPost(kv, body, { ...base, 'sgx-account-reauth': base['sgx-account-session'] });
  assert.equal((await r5.json()).error, 'reauth');
  assert.equal(await kv.get('account-password'), null, '一次都没改成');
  const r6 = await accountPost(kv, { action: 'passkey-list' }, { ...base, 'sgx-account-reauth': '' });
  assert.equal(r6.status, 200);
});

test('再验证：login-password 带 reauth:true → 账号会话 + 3 分钟 AccountReauthTicket（只给主站、Strict）；GET 返回 reauth.expiresAt；reauth-clear 立即作废 reauth / reset 票', async () => {
  const kv = makeKV({ 'account-configured': '1' });
  await seedPassword(kv, 'old-account-password-1');
  const res = await accountPost(kv, { action: 'login-password', password: 'old-account-password-1', reauth: true }, { 'sgx-lock-session': await adminSess() });
  assert.equal(res.status, 200);
  const dc = setCookies(res).find((c) => c.startsWith('sgx-account-reauth='));
  assert.match(dc, /^sgx-account-reauth=password\.0\.\d+\.\d+\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=180$/);
  const acc = pickCookie(res, 'sgx-account-session');
  const rt = pickCookie(res, 'sgx-account-reauth');
  const g = await (await accountGet(kv, { 'sgx-lock-session': await adminSess(), 'sgx-account-session': acc, 'sgx-account-reauth': rt })).json();
  assert.equal(g.reauth.by, 'password');
  assert.ok(g.reauth.expiresAt > Date.now() && g.reauth.expiresAt <= Date.now() + 180 * 1000);
  /* 没带 reauth:true 的普通登录不签票 */
  const res2 = await accountPost(kv, { action: 'login-password', password: 'old-account-password-1' }, { 'sgx-lock-session': await adminSess() });
  assert.equal(pickCookie(res2, 'sgx-account-reauth'), null);
  /* reauth-clear：不需会话，清 reauth / reset 两张票 */
  const c = await accountPost(kv, { action: 'reauth-clear' }, {});
  const sc = setCookies(c);
  assert.equal(sc.length, 2);
  assert.ok(sc.some((x) => x.startsWith('sgx-account-reauth=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0')));
  assert.ok(sc.some((x) => x.startsWith('sgx-account-reset=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0')));
});

test('账号安全里改账号密码（account-epoch +1）：AccountReauthTicket 按原到期时间重签，可以接着操作', async () => {
  const kv = makeKV({ 'account-configured': '1' });
  await seedPassword(kv, 'old-account-password-1');
  const rt = await reauthTicket('password', 0);
  const r = await accountPost(kv, { action: 'password-change', password: 'brand-new-pass-1' }, { 'sgx-lock-session': await adminSess(), 'sgx-account-session': await accTicket('password'), 'sgx-account-reauth': rt });
  assert.equal(r.status, 200);
  const nd = pickCookie(r, 'sgx-account-reauth');
  assert.ok(nd && nd.startsWith('password.1.'), '票换成新纪元');
  assert.equal(nd.split('.')[3], rt.split('.')[3], '到期时间不变');
});

/* ============ 账号页：管理 + 根凭证恢复 ============ */


test('首次设置账号密码：account-configured 标记 + lock-epoch +1，并重签当前 lock 会话（与原管理员凭证一致）', async () => {
  const kv = makeKV({ 'lock-epoch': '3' });
  const r = await accountPost(kv, { action: 'password-change', password: 'first-pass-123' }, {
    'sgx-lock-session': await adminSess(3),
    'sgx-account-reset': await resetTicket(0),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, changed: false });
  assert.equal(await kv.get('account-configured'), '1');
  assert.equal(await kv.get('lock-epoch'), '4');
  assert.ok((pickCookie(r, 'sgx-lock-session') || '').startsWith('password.admin.4.'), '当前设备 lock 会话用新 epoch 重签');
  assert.equal(await kv.get('account-epoch'), null, '首次设置不推进 account-epoch');
});

test('账号密码：短于 8 位 400 short；与锁屏密码相同 403 same-as-lock', async () => {
  const kv = makeKV();
  const { makePasswordRecord } = await import(KERNEL + 'password.js');
  await kv.put('lock-password', JSON.stringify(await makePasswordRecord('lock-pass-123', PEPPER)));
  const c = { 'sgx-lock-session': await adminSess(), 'sgx-account-session': await accTicket('password') };
  let r = await accountPost(kv, { action: 'password-change', password: 'short' }, c);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'short');
  r = await accountPost(kv, { action: 'password-change', password: 'lock-pass-123' }, c);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'same-as-lock');
});

test('账号通行密钥：list 只列账号通行密钥（account-passkey:*）；AccountResetTicket 可删除（恢复路径）；删光且无密码 → 清 account-configured', async () => {
  const kv = makeKV({ 'account-configured': '1' });
  const a = await seedPasskey(kv, 'account');
  await seedPasskey(kv, 'lock');
  const c = { 'sgx-lock-session': await adminSess(), 'sgx-account-reset': await resetTicket(0) };
  const l = await accountPost(kv, { action: 'passkey-list' }, c);
  assert.equal(l.status, 200);
  const lj = await l.json();
  assert.deepEqual(lj.keys.map((k) => k.credId), [a.credId]);
  assert.equal(lj.keys[0].name, '管理员通行密钥', '迁移：原名字保留');
  const d = await accountPost(kv, { action: 'passkey-delete', credId: a.credId }, c);
  assert.equal(d.status, 200);
  assert.equal(await kv.get('account-passkey:' + a.credId.slice(0, 12)), null);
  assert.equal(await kv.get('account-configured'), null);
  assert.equal(await kv.get('account-epoch'), '1');
  assert.ok(pickCookie(d, 'sgx-account-reset').startsWith('root.1.'));
});

test('账号页不能删锁屏类钥匙（404 not-found）', async () => {
  const kv = makeKV();
  const lk = await seedPasskey(kv, 'lock');
  const r = await accountPost(kv, { action: 'passkey-delete', credId: lk.credId }, { 'sgx-lock-session': await adminSess(), 'sgx-account-session': await accTicket('password') });
  assert.equal(r.status, 404);
  assert.ok(await kv.get('lock-passkey:' + lk.credId.slice(0, 12)));
});

test('注册 challenge：沿用 account-user-id，名字 AccountKey（原 OwnerKey），排除已有账号通行密钥', async () => {
  const kv = makeKV({ 'account-user-id': 'acct-handle-1' });
  const a = await seedPasskey(kv, 'account');
  const r = await accountPost(kv, { action: 'passkey-register-challenge' }, { 'sgx-lock-session': await adminSess(), 'sgx-account-session': await accTicket('passkey') });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.user.id, 'acct-handle-1');
  assert.equal(j.user.name, 'AccountKey');
  assert.equal(j.user.displayName, 'Sloan Gray');
  assert.equal(j.rp.id, 'styrigx.com');
  assert.deepEqual(j.excludeCredentials, [{ id: a.credId, type: 'public-key' }]);
});

test('list：带账号 handle（account-user-id，供 signalCurrentUserDetails）+ userName AccountKey；没有 handle 时为空且不新建', async () => {
  const c = async () => ({ 'sgx-lock-session': await adminSess(), 'sgx-account-session': await accTicket('passkey', Date.now() - 20 * 60 * 1000) });
  const kv = makeKV({ 'account-user-id': 'acct-handle-9', 'lock-user-id': 'legacy-lock-handle' });
  await seedPasskey(kv, 'account');
  const r = await accountPost(kv, { action: 'passkey-list' }, await c());
  assert.equal(r.status, 200, 'list 只读，不要求近期');
  const j = await r.json();
  assert.equal(j.userHandle, 'acct-handle-9', '只给当前账号 handle，不给与 LockKey 共用的旧 handle');
  assert.equal(j.userName, 'AccountKey');
  assert.equal(j.displayName, 'Sloan Gray');
  const kv2 = makeKV();
  const j2 = await (await accountPost(kv2, { action: 'passkey-list' }, await c())).json();
  assert.equal(j2.userHandle, '');
  assert.equal(await kv2.get('account-user-id'), null, 'list 不创建 handle');
});

test('rename：改账号通行密钥名字（清理控制字符/空格、限 40 字）；空名 400 params；锁屏类 404；不推纪元', async () => {
  const kv = makeKV();
  const a = await seedPasskey(kv, 'account');
  const lk = await seedPasskey(kv, 'lock');
  const c = { 'sgx-lock-session': await adminSess(), 'sgx-account-session': await accTicket('password') };
  const long = '  Galaxy\u0007 S26 ' + 'x'.repeat(60);
  const r = await accountPost(kv, { action: 'passkey-rename', credId: a.credId, name: long }, c);
  assert.equal(r.status, 200);
  const want = ('Galaxy S26 ' + 'x'.repeat(60)).slice(0, 40);
  assert.equal((await r.json()).name, want);
  const rec = JSON.parse(await kv.get('account-passkey:' + a.credId.slice(0, 12)));
  assert.equal(rec.name, want);
  assert.equal('class' in rec, false, '记录不再写 class（键名已表明域）');
  assert.equal(await kv.get('account-epoch'), null, '重命名不推纪元');
  const e = await accountPost(kv, { action: 'passkey-rename', credId: a.credId, name: ' \u0001 ' }, c);
  assert.equal(e.status, 400);
  assert.equal((await e.json()).error, 'params');
  const m = await accountPost(kv, { action: 'passkey-rename', credId: 'nope' }, c);
  assert.equal(m.status, 400);
  const l = await accountPost(kv, { action: 'passkey-rename', credId: lk.credId, name: 'hack' }, c);
  assert.equal(l.status, 404);
  assert.equal(JSON.parse(await kv.get('lock-passkey:' + lk.credId.slice(0, 12))).name, '管理员通行密钥');
});

test('rename：与 delete 同门槛 —— 没有账号会话 401 account；没有 reauth 票 403 reauth；访客 401', async () => {
  const kv = makeKV();
  const a = await seedPasskey(kv, 'account');
  const body = { action: 'passkey-rename', credId: a.credId, name: 'New' };
  const r1 = await accountPost(kv, body, { 'sgx-lock-session': await adminSess() });
  assert.equal(r1.status, 401);
  assert.equal((await r1.json()).error, 'account');
  const r2 = await accountPost(kv, body, { 'sgx-lock-session': await adminSess(), 'sgx-account-session': await accTicket('password'), 'sgx-account-reauth': '' });
  assert.equal(r2.status, 403);
  assert.equal((await r2.json()).error, 'reauth');
  const r3 = await accountPost(kv, body, { 'sgx-lock-session': await visitorSess(), 'sgx-account-session': await accTicket('password') });
  assert.equal(r3.status, 401);
  assert.equal(JSON.parse(await kv.get('account-passkey:' + a.credId.slice(0, 12))).name, '管理员通行密钥');
});

test('logout：清账号会话和 reauth / reset 票（幂等，不需会话），不动锁屏会话', async () => {
  const kv = makeKV();
  const r = await accountPost(kv, { action: 'logout' }, {});
  assert.equal(r.status, 200);
  const sc = setCookies(r);
  assert.equal(sc.length, 3);
  assert.ok(sc[0].startsWith('sgx-account-session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'));
  assert.ok(sc[1].startsWith('sgx-account-reauth=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'));
  assert.ok(sc[2].startsWith('sgx-account-reset=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'));
  assert.ok(!sc.some((c) => c.startsWith('sgx-lock-session=')));
});

test('跨站请求（Origin 不同）→ 403', async () => {
  const { onRequestPost } = await import(API + 'account.js');
  const kv = makeKV();
  const r = await onRequestPost({
    request: new Request('https://styrigx.com/api/account', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"action":"logout"}' }),
    env: envFor(kv),
  });
  assert.equal(r.status, 403);
});

/* ============ 缺账号钥匙：优雅降级 ============ */


test('路由：/api/account 已登记，/api/owner-status 已移除', async () => {
  const { API_ROUTES } = await import('../../../workers/auth-gateway/src/routes.js');
  assert.ok(API_ROUTES.has('/api/account'));
  assert.ok(!API_ROUTES.has('/api/owner-status'));
});
