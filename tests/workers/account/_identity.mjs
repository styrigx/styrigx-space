/**
 * 账号身份接口（workers/account/src/identity/，账号拆分 PR2b）单测的公共测试台。
 *
 * - keys()：一次生成 ACCOUNT / OTHER 两对 Ed25519 钥匙（before 里调）
 * - makeEnv(overrides?)：账号 Worker env：D1_ACCOUNT_AUTH（node:sqlite 替身，跑过账号全部迁移）、账号票钥匙、根密钥、pepper、RP
 * - req / post / get：带网关身份头（默认 admin、by=password、客户端地址 10.9.9.9、CN / Shanghai）的请求；identity:null 表示不带身份头
 * - accSession / reauth / reset：按真实格式签账号会话和两张短票（账号侧的签名函数）
 * - seedPassword / seedPasskey / assertion：账号库里直接写凭证；按 WebAuthn 格式签断言
 * - setCookies / pickCookie / cookies
 */
import { createRequire } from 'node:module';
import { genKeyPair, postReq } from '../_harness.mjs';
import { makeAccountD1 } from './_d1.mjs';

const require = createRequire(import.meta.url);
export const { makeAttestationCredential } = require('../../web/e2e/cred-e2e-helpers.cjs');

const ID = '../../../workers/account/src/identity/';
export const account = await import(ID + 'account.js');
export const session = await import(ID + 'account-session.js');
export const devices = await import(ID + 'account-devices.js');
export const root = await import(ID + 'account-root.js');
export const store = await import(ID + 'account-store.js');
export const realm = await import(ID + 'realm.js');

export const ROOT_KEY = 'test-account-root-key-0123456789';
export const PEPPER = 'test-pepper-acc';
export const IP = '10.9.9.9';
export const URL_ = 'https://styrigx.com/api/account';
export const TEST_DEVICE_ID = 'devtestdevtest01';

/** @type {{ACCOUNT:{priv:string,pub:string}, OTHER:{priv:string,pub:string}}} */
export const K = /** @type {any} */ ({});
export async function keys() {
  K.ACCOUNT = await genKeyPair();
  K.OTHER = await genKeyPair();
}

export function makeEnv(overrides = {}) {
  return {
    D1_ACCOUNT_AUTH: makeAccountD1(),
    SGX_ACCOUNT_PRIVATE: K.ACCOUNT.priv,
    SGX_ACCOUNT_PUBLIC: K.ACCOUNT.pub,
    SGX_ACCOUNT_ROOT_KEY: ROOT_KEY,
    SGX_PW_PEPPER: PEPPER,
    SGX_RP_ID: 'styrigx.com',
    SGX_ORIGIN: 'https://styrigx.com',
    ...overrides,
  };
}

/** 网关写的身份头。identity === null → 不带任何身份头 */
export function idHeaders(identity) {
  if (identity === null) return {};
  const i = { role: 'admin', by: 'password', ip: IP, country: 'CN', city: 'Shanghai', ...(identity || {}) };
  const h = {};
  if (i.role) h['X-Styrigx-Lock-Role'] = i.role;
  if (i.by) h['X-Styrigx-Lock-By'] = i.by;
  if (i.tempkeyId) h['X-Styrigx-Lock-Tempkey-Id'] = i.tempkeyId;
  if (i.ip) h['X-Styrigx-Client-Address'] = i.ip;
  if (i.country) h['X-Styrigx-Client-Country'] = i.country;
  if (i.city) h['X-Styrigx-Client-City'] = i.city;
  return h;
}

export function cookies(o) {
  return Object.entries(o || {}).filter(([, v]) => v).map(([k, v]) => k + '=' + v).join('; ');
}

/**
 * POST /api/account。
 * @param {any} env @param {any} body @param {Record<string,string>} [ck] cookie 对象 @param {{identity?:any, headers?:any}} [o]
 */
export async function post(env, body, ck, o = {}) {
  const h = { ...idHeaders(o.identity), ...(o.headers || {}) };
  if (ck && Object.keys(ck).length) h.Cookie = cookies(ck);
  return account.onRequestPost({ request: postReq(URL_, body, h), env });
}

/** GET /api/account */
export async function get(env, ck, o = {}) {
  const h = { ...idHeaders(o.identity), ...(o.headers || {}) };
  if (ck && Object.keys(ck).length) h.Cookie = cookies(ck);
  return account.onRequestGet({ request: new Request(URL_, { method: 'GET', headers: h }), env });
}

export function accSession(by = 'password', epoch = 0, authAt = Date.now(), o = {}) {
  return session.signAccountSessionTicket(o.priv || K.ACCOUNT.priv, { by, epoch, authAt, deviceId: o.deviceId || TEST_DEVICE_ID, now: o.now });
}
export function reauth(by = 'password', epoch = 0, o = {}) {
  return session.signTicket(o.priv || K.ACCOUNT.priv, 'AccountReauthTicket', by, epoch, o.now);
}
export function reset(epoch = 0, o = {}) {
  return session.signTicket(o.priv || K.ACCOUNT.priv, 'AccountResetTicket', 'root', epoch, o.now);
}
/** 账号会话 + 同纪元 reauth 票 */
export async function full(by = 'password', epoch = 0, o = {}) {
  return { 'sgx-account-session': await accSession(by, epoch, Date.now(), o), 'sgx-account-reauth': await reauth(by, epoch) };
}

export function setCookies(res) {
  return res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('Set-Cookie') || ''];
}
export function pickCookie(res, name) {
  for (const c of setCookies(res)) if (c.startsWith(name + '=')) return c.split(';')[0].slice(name.length + 1);
  return null;
}

export const raw = (env) => env.D1_ACCOUNT_AUTH.raw;
export const one = (env, sql, ...p) => { const r = raw(env).prepare(sql).get(...p); return r ? { ...r } : null; };
export const all = (env, sql, ...p) => raw(env).prepare(sql).all(...p).map((r) => ({ ...r }));
export const epochOf = (env) => { const r = one(env, "SELECT value FROM epoch WHERE realm = 'account'"); return r ? Number(r.value) : 0; };
export const setEpoch = (env, v) => raw(env).prepare("INSERT INTO epoch (realm, value) VALUES ('account', ?) ON CONFLICT (realm) DO UPDATE SET value = excluded.value").run(v);

export async function seedPassword(env, pw) {
  const { makePasswordRecord } = await import('../../../workers/shared/password.js');
  raw(env).prepare("INSERT INTO password (realm, record) VALUES ('account', ?) ON CONFLICT (realm) DO UPDATE SET record = excluded.record").run(JSON.stringify(await makePasswordRecord(pw, PEPPER)));
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function seedPasskey(env, extra = {}) {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const credId = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const rec = { name: '管理员通行密钥', provider: 'Samsung Pass', aaguid: '', createdAt: 1, lastUsedAt: 0, credId, publicKey: jwk, signCount: 0, uv: 1, ...extra };
  raw(env).prepare("INSERT INTO passkey (realm, credential_id, record) VALUES ('account', ?, ?)").run(credId, JSON.stringify(rec));
  return { kp, credId };
}

export function setHandles(env, handle, legacy = '') {
  raw(env).prepare("INSERT INTO user_handle (realm, handle, legacy_handle) VALUES ('account', ?, ?) ON CONFLICT (realm) DO UPDATE SET handle = excluded.handle, legacy_handle = excluded.legacy_handle").run(handle, legacy);
}

function toDer(rawSig) {
  const trim = (v) => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    v = v.slice(i);
    if (v[0] >= 0x80) { const w = new Uint8Array(v.length + 1); w.set(v, 1); return w; }
    return v;
  };
  const r = trim(rawSig.slice(0, 32)), s = trim(rawSig.slice(32, 64));
  const len = 2 + r.length + 2 + s.length;
  const der = new Uint8Array(2 + len);
  let o = 0;
  der[o++] = 0x30; der[o++] = len;
  der[o++] = 0x02; der[o++] = r.length; der.set(r, o); o += r.length;
  der[o++] = 0x02; der[o++] = s.length; der.set(s, o);
  return der;
}

/** 账号通行密钥断言（UV 默认 1；uv:false 测 uv-required） */
export async function assertion(kp, credId, challenge, userHandle, o = {}) {
  const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('styrigx.com')));
  const authData = new Uint8Array(37);
  authData.set(rpIdHash, 0);
  authData[32] = o.uv === false ? 0x01 : 0x05;
  authData[36] = o.signCount || 1;
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'https://styrigx.com' }));
  const cdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
  const base = new Uint8Array(authData.length + cdHash.length);
  base.set(authData, 0);
  base.set(cdHash, authData.length);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, base));
  return {
    id: credId, rawId: credId, type: 'public-key',
    response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authData), signature: b64url(toDer(sig)), userHandle: userHandle || null },
  };
}

/** login-challenge → 断言 → login-passkey 一整套 */
export async function passkeyLogin(env, kp, credId, userHandle, body = {}, ck, aopts) {
  const ch = await (await post(env, { action: 'login-challenge' }, ck)).json();
  const cred = await assertion(kp, credId, ch.challenge, userHandle, aopts);
  return post(env, { action: 'login-passkey', cid: ch.cid, credential: cred, ...body }, ck);
}
