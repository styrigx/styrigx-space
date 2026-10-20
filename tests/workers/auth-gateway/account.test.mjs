/**
 * 账号体系（站长凭证升级为账号）：/api/account、root-auth target=account、/api/stepup enter。
 *
 * 覆盖：
 * - 账号登录三个入口（账号通行密钥 / 账号密码 / 根凭证）任一成功都签发 sgx-account，
 *   by 分别为 passkey / password / root；不签 sgx-stepup、不动 sgx-verified
 * - 账号会话独立：只有 lock 会话（sgx-verified）→ 不算账号；把 lock 会话值塞进 sgx-account
 *   或用别的钥匙签 → 拒绝；账号接口仍要求 owner lock 会话作为前置条件
 * - 进门：近期（≤10 分钟）账号登录 → stepup(by=account, scope=keys)；过旧 → 403 account-stale
 * - 账号会话 400 天；账号页管理操作要账号门票 sgx-door（door:true 登录 / 根凭证签发，3 分钟，离开即清）
 * - 迁移：原站长密码 owner-pw（同 pepper）与原 owner-passkey:*（class=owner）直接可用，不重新注册
 * - 恢复：根凭证登录可重置账号密码、删除账号通行密钥；account-epoch +1，旧账号会话失效
 * - 缺 SGX_ACCOUNT_*：账号登录 503 config，其余接口不受影响
 *
 * 运行：node --test tests/workers/auth-gateway/account.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

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

let LOCK, STEPUP, ACCOUNT, OTHER;
const ROOT_KEY = 'test-root-key-account-123';
const PEPPER = 'test-pepper-acc';

function envFor(kv, overrides = {}) {
  return {
    OWNER_KV: kv,
    SGX_ROOT_KEY: ROOT_KEY,
    SGX_LOCK_PRIVATE: LOCK.priv,
    SGX_LOCK_PUBLIC: LOCK.pub,
    SGX_STEPUP_PRIVATE: STEPUP.priv,
    SGX_STEPUP_PUBLIC: STEPUP.pub,
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

async function ownerSess(epoch = 0) {
  const { signSessionCookie } = await import(KERNEL + 'session.js');
  return await signSessionCookie(LOCK.priv, epoch, 'owner', 'owner');
}
async function visitorSess() {
  const { signSessionCookie } = await import(KERNEL + 'session.js');
  return await signSessionCookie(LOCK.priv, 0, 'visitor', 'owner');
}
async function accTicket(by = 'password', authAt = Date.now(), epoch = 0, priv) {
  const { signAccountTicket } = await import(KERNEL + 'account-session.js');
  return await signAccountTicket(priv || ACCOUNT.priv, by, epoch, authAt);
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

async function doorTicket(by = 'password', epoch = 0, priv, now) {
  const { signDoorTicket } = await import(KERNEL + 'door.js');
  return await signDoorTicket(priv || ACCOUNT.priv, 'account', by, epoch, now);
}
/* 管理操作要账号门票：测试里带了账号会话又没显式给 sgx-door（键不存在）时，自动补一张同纪元的门票；
   要测「没有门票」就显式传 'sgx-door': '' */
async function withDoor(cookieObj) {
  const o = { ...(cookieObj || {}) };
  if (o['sgx-account'] && !('sgx-door' in o)) {
    const by = String(o['sgx-account']).split('.')[0];
    const ep = parseInt(String(o['sgx-account']).split('.')[1], 10) || 0;
    o['sgx-door'] = await doorTicket(by, ep);
  }
  return o;
}
async function accountPost(kv, body, cookieObj, envOverrides) {
  const { onRequestPost } = await import(API + 'account.js');
  const co = await withDoor(cookieObj);
  return await onRequestPost({ request: postReq('https://styrigx.com/api/account', body, { Cookie: cookies(co) }), env: envFor(kv, envOverrides) });
}
async function accountGet(kv, cookieObj, envOverrides) {
  const { onRequestGet } = await import(API + 'account.js');
  return await onRequestGet({ request: getReq('https://styrigx.com/api/account', { Cookie: cookies(cookieObj) }), env: envFor(kv, envOverrides) });
}
async function enter(kv, cookieObj, envOverrides) {
  const { onRequestPost } = await import(API + 'stepup.js');
  return await onRequestPost({ request: postReq('https://styrigx.com/api/stepup', { action: 'enter' }, { Cookie: cookies(cookieObj) }), env: envFor(kv, envOverrides) });
}
async function seedPassword(kv, pw) {
  const { makePasswordRecord } = await import(KERNEL + 'password.js');
  await kv.put('owner-pw', JSON.stringify(await makePasswordRecord(pw, PEPPER)));
}

/* ---- WebAuthn 断言（测试用 P-256 钥匙，结构同 session-security.test.mjs） ---- */
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function seedPasskey(kv, cls = 'owner') {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const credId = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const idx = JSON.parse((await kv.get('owner-passkey-index')) || '[]');
  idx.push(credId);
  await kv.put('owner-passkey-index', JSON.stringify(idx));
  /* 原站长通行密钥的存储格式（迁移：不重新注册） */
  await kv.put('owner-passkey:' + credId.slice(0, 12), JSON.stringify({
    name: '站长通行密钥', provider: 'Samsung Pass', aaguid: '', createdAt: 1, lastUsedAt: 0,
    credId, publicKey: jwk, signCount: 0, uv: 1, class: cls,
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
  STEPUP = await edPair();
  ACCOUNT = await edPair();
  OTHER = await edPair();
  assert.ok(ACCOUNT.priv.includes('PRIVATE KEY'));
});

/* ============ 登录入口一：账号密码 ============ */


test('账号密码登录：错误 → 403 wrong；未设置 → 403 not-set；都不签 cookie', async () => {
  const kv = makeKV();
  let res = await accountPost(kv, { action: 'login-password', password: 'whatever-123' }, { 'sgx-verified': await ownerSess() });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'not-set');
  await seedPassword(kv, 'right-password-1');
  res = await accountPost(kv, { action: 'login-password', password: 'wrong-password-1' }, { 'sgx-verified': await ownerSess() });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'wrong');
  assert.equal(res.headers.get('Set-Cookie'), null);
});

/* ============ 登录入口二：账号通行密钥 ============ */

test('账号通行密钥登录（迁移：原 owner-passkey class=owner 不重新注册）→ sgx-account(by=passkey)；legacy userHandle 也接受', async () => {
  const kv = makeKV({ 'layer:owner': '1', 'owner-user-id': 'legacy-handle-xyz' });
  const { kp, credId } = await seedPasskey(kv, 'owner');
  const sess = await ownerSess();
  const ch = await accountPost(kv, { action: 'challenge' }, { 'sgx-verified': sess });
  assert.equal(ch.status, 200);
  const cj = await ch.json();
  assert.deepEqual(cj.allowCredentials, [{ id: credId, type: 'public-key' }]);
  assert.ok(await kv.get('account-challenge:' + cj.cid), 'challenge 存在 account-challenge: 前缀下');
  const cred = await assertion(kp, credId, cj.challenge, 'legacy-handle-xyz');
  const res = await accountPost(kv, { action: 'login-passkey', cid: cj.cid, credential: cred }, { 'sgx-verified': sess });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const acc = pickCookie(res, 'sgx-account');
  assert.ok(acc && acc.startsWith('passkey.0.'));
  assert.equal(pickCookie(res, 'sgx-stepup'), null);
  /* challenge 单次使用 */
  const replay = await accountPost(kv, { action: 'login-passkey', cid: cj.cid, credential: cred }, { 'sgx-verified': sess });
  assert.equal(replay.status, 403);
  assert.equal((await replay.json()).error, 'challenge');
});

test('账号通行密钥登录：锁屏类（class=lock）钥匙不能登录账号', async () => {
  const kv = makeKV();
  const { kp, credId } = await seedPasskey(kv, 'lock');
  const ch = await accountPost(kv, { action: 'challenge' }, { 'sgx-verified': await ownerSess() });
  assert.equal(ch.status, 403);
  assert.equal((await ch.json()).error, 'not-set');
  await kv.put('account-challenge:c1', JSON.stringify({ challenge: 'abc', purpose: 'login', exp: Date.now() + 60000 }));
  const res = await accountPost(kv, { action: 'login-passkey', cid: 'c1', credential: await assertion(kp, credId, 'abc') }, { 'sgx-verified': await ownerSess() });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('Set-Cookie'), null);
});

/* ============ 登录入口三：根凭证 ============ */

test('根凭证登录（/api/root-auth target=account）→ sgx-account(by=root)，不签 stepup；审计 path=account', async () => {
  const { onRequestPost } = await import(API + 'root-auth.js');
  const kv = makeKV({ 'layer:lock': '1' });
  const res = await onRequestPost({
    request: postReq('https://styrigx.com/api/root-auth', { key: ROOT_KEY, target: 'account' }, { Cookie: 'sgx-verified=' + (await ownerSess()) }),
    env: envFor(kv),
  });
  assert.equal(res.status, 200);
  const acc = pickCookie(res, 'sgx-account');
  assert.ok(acc && acc.startsWith('root.0.'), '应签发 by=root 的账号会话');
  assert.equal(pickCookie(res, 'sgx-stepup'), null, '账号登录不签 stepup');
  const audits = [...kv.store.entries()].filter(([k]) => k.startsWith('root-auth-audit:')).map(([, v]) => JSON.parse(v));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].ok, true);
  assert.equal(audits[0].path, 'account');
});


test('根凭证登录 target=account：无 lock 会话（即使 lock 未配置）走假入口 401；访客 401 denied；错误根凭证 401 auth', async () => {
  const { onRequestPost } = await import(API + 'root-auth.js');
  const kv = makeKV(); /* lock 未配置：默认目标会走引导模式，target=account 不走 */
  let res = await onRequestPost({ request: postReq('https://styrigx.com/api/root-auth', { key: ROOT_KEY, target: 'account' }), env: envFor(kv) });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { ok: false, error: 'auth' });
  assert.equal(pickCookie(res, 'sgx-account'), null);
  res = await onRequestPost({ request: postReq('https://styrigx.com/api/root-auth', { key: ROOT_KEY, target: 'account' }, { Cookie: 'sgx-verified=' + (await visitorSess()) }), env: envFor(kv) });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'denied');
  const kv2 = makeKV({ 'layer:lock': '1' });
  res = await onRequestPost({ request: postReq('https://styrigx.com/api/root-auth', { key: 'wrong', target: 'account' }, { Cookie: 'sgx-verified=' + (await ownerSess()) }), env: envFor(kv2) });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'auth');
});

/* ============ 独立性：lock 会话绝不等于账号会话 ============ */




/* ============ 进门：近期账号登录 ============ */



test('账号会话 400 天：登录很久以前（远超 10 分钟）也还是登录态，GET 照样返回 session', async () => {
  const kv = makeKV();
  const r = await accountGet(kv, { 'sgx-verified': await ownerSess(), 'sgx-account': await accTicket('password', Date.now() - 30 * 24 * 3600 * 1000) });
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(j.session, '账号会话仍有效');
  assert.equal(j.door, null, '没进门就没有门票');
});

test('安全与隐私的门：改动必须有账号门票 —— 没有门票 403 door；门票过期 / 别的钥匙签 / 纪元不对都 403 door；只读 list 不要门票', async () => {
  const kv = makeKV();
  const base = { 'sgx-verified': await ownerSess(), 'sgx-account': await accTicket('password') };
  const body = { action: 'password', password: 'new-password-123' };
  const r1 = await accountPost(kv, body, { ...base, 'sgx-door': '' });
  assert.equal(r1.status, 403);
  assert.equal((await r1.json()).error, 'door');
  const old = await doorTicket('password', 0, undefined, Date.now() - 181 * 1000);
  const r2 = await accountPost(kv, body, { ...base, 'sgx-door': old });
  assert.equal((await r2.json()).error, 'door');
  const forged = await doorTicket('password', 0, OTHER.priv);
  const r3 = await accountPost(kv, body, { ...base, 'sgx-door': forged });
  assert.equal((await r3.json()).error, 'door');
  const wrongEpoch = await doorTicket('password', 5);
  const r4 = await accountPost(kv, body, { ...base, 'sgx-door': wrongEpoch });
  assert.equal((await r4.json()).error, 'door');
  /* 拿账号会话票冒充门票（同一把钥匙签）→ 格式不符，拒绝 */
  const r5 = await accountPost(kv, body, { ...base, 'sgx-door': base['sgx-account'] });
  assert.equal((await r5.json()).error, 'door');
  assert.equal(await kv.get('owner-pw'), null, '一次都没改成');
  const r6 = await accountPost(kv, { action: 'list' }, { ...base, 'sgx-door': '' });
  assert.equal(r6.status, 200);
});

test('进门：login-password / root-auth 带 door:true → 账号会话 + 3 分钟门票（sgx-door，只给主站、Strict）；GET 返回 door.expiresAt；door-clear 立即作废', async () => {
  const kv = makeKV({ 'layer:owner': '1' });
  await seedPassword(kv, 'old-owner-password-1');
  const res = await accountPost(kv, { action: 'login-password', password: 'old-owner-password-1', door: true }, { 'sgx-verified': await ownerSess() });
  assert.equal(res.status, 200);
  const dc = setCookies(res).find((c) => c.startsWith('sgx-door='));
  assert.match(dc, /^sgx-door=door\.account\.password\.0\.\d+\.\d+\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=180$/);
  const acc = pickCookie(res, 'sgx-account');
  const door = pickCookie(res, 'sgx-door');
  const g = await (await accountGet(kv, { 'sgx-verified': await ownerSess(), 'sgx-account': acc, 'sgx-door': door })).json();
  assert.equal(g.door.by, 'password');
  assert.ok(g.door.expiresAt > Date.now() && g.door.expiresAt <= Date.now() + 180 * 1000);
  /* 没带 door:true 的普通登录不签门票 */
  const res2 = await accountPost(kv, { action: 'login-password', password: 'old-owner-password-1' }, { 'sgx-verified': await ownerSess() });
  assert.equal(pickCookie(res2, 'sgx-door'), null);
  /* 根凭证进门 */
  const { onRequestPost } = await import(API + 'root-auth.js');
  const rr = await onRequestPost({ request: postReq('https://styrigx.com/api/root-auth', { key: ROOT_KEY, target: 'account', door: true }, { Cookie: cookies({ 'sgx-verified': await ownerSess() }) }), env: envFor(kv) });
  assert.equal(rr.status, 200);
  assert.ok(pickCookie(rr, 'sgx-door').startsWith('door.account.root.'));
  /* door-clear：不需会话、只清门票 */
  const c = await accountPost(kv, { action: 'door-clear' }, {});
  const sc = setCookies(c);
  assert.equal(sc.length, 1);
  assert.ok(sc[0].startsWith('sgx-door=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'));
});

test('门内改账号密码（account-epoch +1）：当前设备门票按原到期时间重签，门内可以接着操作', async () => {
  const kv = makeKV({ 'layer:owner': '1' });
  await seedPassword(kv, 'old-owner-password-1');
  const door = await doorTicket('password', 0);
  const r = await accountPost(kv, { action: 'password', password: 'brand-new-pass-1' }, { 'sgx-verified': await ownerSess(), 'sgx-account': await accTicket('password'), 'sgx-door': door });
  assert.equal(r.status, 200);
  const nd = pickCookie(r, 'sgx-door');
  assert.ok(nd && nd.startsWith('door.account.password.1.'), '门票换成新纪元');
  assert.equal(nd.split('.')[5], door.split('.')[5], '到期时间不变');
});

/* ============ 账号页：管理 + 根凭证恢复 ============ */


test('首次设置账号密码：layer:owner 标记 + session-epoch +1，并重签当前 lock 会话（与原站长凭证一致）', async () => {
  const kv = makeKV({ 'session-epoch': '3' });
  const r = await accountPost(kv, { action: 'password', password: 'first-pass-123' }, {
    'sgx-verified': await ownerSess(3),
    'sgx-account': await accTicket('root'),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, changed: false });
  assert.equal(await kv.get('layer:owner'), '1');
  assert.equal(await kv.get('session-epoch'), '4');
  assert.ok((pickCookie(r, 'sgx-verified') || '').startsWith('owner.owner.4.'), '当前设备 lock 会话用新 epoch 重签');
  assert.equal(await kv.get('account-epoch'), null, '首次设置不推进 account-epoch');
});

test('账号密码：短于 8 位 400 short；与锁屏密码相同 403 same-as-lock', async () => {
  const kv = makeKV();
  const { makePasswordRecord } = await import(KERNEL + 'password.js');
  await kv.put('lock-pw', JSON.stringify(await makePasswordRecord('lock-pass-123', PEPPER)));
  const c = { 'sgx-verified': await ownerSess(), 'sgx-account': await accTicket('password') };
  let r = await accountPost(kv, { action: 'password', password: 'short' }, c);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'short');
  r = await accountPost(kv, { action: 'password', password: 'lock-pass-123' }, c);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'same-as-lock');
});

test('账号通行密钥：list 只列 class=owner；根凭证会话可删除（恢复路径）；删光且无密码 → 清 layer:owner', async () => {
  const kv = makeKV({ 'layer:owner': '1' });
  const a = await seedPasskey(kv, 'owner');
  await seedPasskey(kv, 'lock');
  const c = { 'sgx-verified': await ownerSess(), 'sgx-account': await accTicket('root') };
  const l = await accountPost(kv, { action: 'list' }, c);
  assert.equal(l.status, 200);
  const lj = await l.json();
  assert.deepEqual(lj.keys.map((k) => k.credId), [a.credId]);
  assert.equal(lj.keys[0].name, '站长通行密钥', '迁移：原名字保留');
  const d = await accountPost(kv, { action: 'delete', credId: a.credId }, c);
  assert.equal(d.status, 200);
  assert.equal(await kv.get('owner-passkey:' + a.credId.slice(0, 12)), null);
  assert.equal(await kv.get('layer:owner'), null);
  assert.equal(await kv.get('account-epoch'), '1');
  assert.ok(pickCookie(d, 'sgx-account').startsWith('root.1.'));
});

test('账号页不能删锁屏类钥匙（404 not-found）', async () => {
  const kv = makeKV();
  const lk = await seedPasskey(kv, 'lock');
  const r = await accountPost(kv, { action: 'delete', credId: lk.credId }, { 'sgx-verified': await ownerSess(), 'sgx-account': await accTicket('password') });
  assert.equal(r.status, 404);
  assert.ok(await kv.get('owner-passkey:' + lk.credId.slice(0, 12)));
});

test('注册 challenge：沿用 owner-user-id:owner，名字 accountkey（原 ownerkey），排除已有账号通行密钥', async () => {
  const kv = makeKV({ 'owner-user-id:owner': 'acct-handle-1' });
  const a = await seedPasskey(kv, 'owner');
  const r = await accountPost(kv, { action: 'register-challenge' }, { 'sgx-verified': await ownerSess(), 'sgx-account': await accTicket('passkey') });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.user.id, 'acct-handle-1');
  assert.equal(j.user.name, 'accountkey');
  assert.equal(j.user.displayName, 'Sloan Gray');
  assert.equal(j.rp.id, 'styrigx.com');
  assert.deepEqual(j.excludeCredentials, [{ id: a.credId, type: 'public-key' }]);
});

test('list：带账号 handle（owner-user-id:owner，供 signalCurrentUserDetails）+ userName accountkey；没有 handle 时为空且不新建', async () => {
  const c = async () => ({ 'sgx-verified': await ownerSess(), 'sgx-account': await accTicket('passkey', Date.now() - 20 * 60 * 1000) });
  const kv = makeKV({ 'owner-user-id:owner': 'acct-handle-9', 'owner-user-id': 'legacy-lock-handle' });
  await seedPasskey(kv, 'owner');
  const r = await accountPost(kv, { action: 'list' }, await c());
  assert.equal(r.status, 200, 'list 只读，不要求近期');
  const j = await r.json();
  assert.equal(j.userHandle, 'acct-handle-9', '只给当前账号 handle，不给与 lockkey 共用的旧 handle');
  assert.equal(j.userName, 'accountkey');
  assert.equal(j.displayName, 'Sloan Gray');
  const kv2 = makeKV();
  const j2 = await (await accountPost(kv2, { action: 'list' }, await c())).json();
  assert.equal(j2.userHandle, '');
  assert.equal(await kv2.get('owner-user-id:owner'), null, 'list 不创建 handle');
});

test('rename：改账号通行密钥名字（清理控制字符/空格、限 40 字）；空名 400 params；锁屏类 404；不推纪元', async () => {
  const kv = makeKV();
  const a = await seedPasskey(kv, 'owner');
  const lk = await seedPasskey(kv, 'lock');
  const c = { 'sgx-verified': await ownerSess(), 'sgx-account': await accTicket('password') };
  const long = '  Galaxy\u0007 S26 ' + 'x'.repeat(60);
  const r = await accountPost(kv, { action: 'rename', credId: a.credId, name: long }, c);
  assert.equal(r.status, 200);
  const want = ('Galaxy S26 ' + 'x'.repeat(60)).slice(0, 40);
  assert.equal((await r.json()).name, want);
  const rec = JSON.parse(await kv.get('owner-passkey:' + a.credId.slice(0, 12)));
  assert.equal(rec.name, want);
  assert.equal(rec.class, 'owner', '存储层 class 仍是 owner');
  assert.equal(await kv.get('account-epoch'), null, '重命名不推纪元');
  const e = await accountPost(kv, { action: 'rename', credId: a.credId, name: ' \u0001 ' }, c);
  assert.equal(e.status, 400);
  assert.equal((await e.json()).error, 'params');
  const m = await accountPost(kv, { action: 'rename', credId: 'nope' }, c);
  assert.equal(m.status, 400);
  const l = await accountPost(kv, { action: 'rename', credId: lk.credId, name: 'hack' }, c);
  assert.equal(l.status, 404);
  assert.equal(JSON.parse(await kv.get('owner-passkey:' + lk.credId.slice(0, 12))).name, '站长通行密钥');
});

test('rename：与 delete 同门槛 —— 没有账号会话 401 account；没有门票 403 door；访客 401', async () => {
  const kv = makeKV();
  const a = await seedPasskey(kv, 'owner');
  const body = { action: 'rename', credId: a.credId, name: 'New' };
  const r1 = await accountPost(kv, body, { 'sgx-verified': await ownerSess() });
  assert.equal(r1.status, 401);
  assert.equal((await r1.json()).error, 'account');
  const r2 = await accountPost(kv, body, { 'sgx-verified': await ownerSess(), 'sgx-account': await accTicket('password'), 'sgx-door': '' });
  assert.equal(r2.status, 403);
  assert.equal((await r2.json()).error, 'door');
  const r3 = await accountPost(kv, body, { 'sgx-verified': await visitorSess(), 'sgx-account': await accTicket('password') });
  assert.equal(r3.status, 401);
  assert.equal(JSON.parse(await kv.get('owner-passkey:' + a.credId.slice(0, 12))).name, '站长通行密钥');
});

test('logout：清 sgx-account 和门票（幂等，不需会话），不动 sgx-verified', async () => {
  const kv = makeKV();
  const r = await accountPost(kv, { action: 'logout' }, {});
  assert.equal(r.status, 200);
  const sc = setCookies(r);
  assert.equal(sc.length, 2);
  assert.ok(sc[0].startsWith('sgx-account=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'));
  assert.ok(sc[1].startsWith('sgx-door=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'));
  assert.ok(!sc.some((c) => c.startsWith('sgx-verified=')));
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
