/**
 * 账号 Worker 接口（workers/account/src/api/account/*.js + src/core/）单测的公共测试台（命名 v2；原 _identity.mjs）。
 *
 * - keys()：一次生成 ACCOUNT / OTHER 两对 Ed25519 钥匙（before 里调）
 * - makeEnv(overrides?)：env：D1_ACCOUNT（node:sqlite 替身，跑过账号全部迁移）、签名钥匙、恢复密钥、账号密码 pepper、RP
 * - post(env, entry, body, ck?, o?) / get(env, ck?, o?)：POST /api/account/<entry>（session / reauth / reset / keys / devices / grants）、
 *   GET /api/account。默认带网关身份头（进站会话 X-Styrigx-Space-Session: 1、by=password、客户端地址 10.9.9.9、CN / Shanghai；
 *   identity.role 写一条网关从不写的外来头 X-Styrigx-Space-Level，用来验证账号 Worker 不看它）；identity:null = 不带身份头
 * - accSession / reauthTicket / resetTicket / full：按真实格式签三张票
 * - seedPassword / seedPasskey / setHandles / assertion / passkeyLogin
 * - raw / one / all / epochOf / setEpoch / setCookies / pickCookie / cookies
 */
import { createRequire } from 'node:module';
import { genKeyPair, postReq } from '../_harness.mjs';
import { makeAccountD1 } from './_d1.mjs';

const require = createRequire(import.meta.url);
export const { makeAttestationCredential } = require('../../space/e2e/helpers/cred-e2e-helpers.cjs');

const SRC = '../../../workers/account/src/';
export const api = {
  status: await import(SRC + 'api/account/status.js'),
  session: await import(SRC + 'api/account/session.js'),
  reauth: await import(SRC + 'api/account/reauth.js'),
  reset: await import(SRC + 'api/account/reset.js'),
  keys: await import(SRC + 'api/account/keys.js'),
  devices: await import(SRC + 'api/account/devices.js'),
  grants: await import(SRC + 'api/account/grants.js'),
};
export const config = await import(SRC + 'core/config.js');
export const session = await import(SRC + 'core/session.js');
export const reauthCore = await import(SRC + 'core/reauth.js');
export const resetCore = await import(SRC + 'core/reset.js');
export const devices = await import(SRC + 'core/devices.js');
export const passkey = await import(SRC + 'core/passkey.js');
export const password = await import(SRC + 'core/password.js');
export const audit = await import(SRC + 'core/audit.js');
export const recoveryKey = await import(SRC + 'core/recovery-key.js');

export const RECOVERY_KEY = 'test-account-recovery-key-0123456789';
export const PEPPER = 'test-account-password-pepper';
export const IP = '10.9.9.9';
export const ORIGIN = 'https://styrigx.com';
export const TEST_DEVICE_ID = 'devtestdevtest01';

/** @type {{ACCOUNT:{priv:string,pub:string}, OTHER:{priv:string,pub:string}}} */
export const K = /** @type {any} */ ({});
export async function keys() {
  K.ACCOUNT = await genKeyPair();
  K.OTHER = await genKeyPair();
}

export function makeEnv(overrides = {}) {
  return {
    D1_ACCOUNT: makeAccountD1(),
    SGX_ACCOUNT_PRIVATE: K.ACCOUNT.priv,
    SGX_ACCOUNT_PUBLIC: K.ACCOUNT.pub,
    SGX_ACCOUNT_RECOVERY_KEY: RECOVERY_KEY,
    SGX_ACCOUNT_PASSWORD_PEPPER: PEPPER,
    SGX_RP_ID: 'styrigx.com',
    SGX_ORIGIN: ORIGIN,
    ...overrides,
  };
}

/** 网关写的身份头。identity === null → 不带任何身份头；identity.session = '' → 不带 X-Styrigx-Space-Session（= 没有进站会话） */
export function idHeaders(identity) {
  if (identity === null) return {};
  const i = { session: '1', role: 'password', by: 'password', ip: IP, country: 'CN', city: 'Shanghai', ...(identity || {}) };
  const h = {};
  if (i.session) h['X-Styrigx-Space-Session'] = i.session;
  if (i.role) h['X-Styrigx-Space-Level'] = i.role;
  if (i.by) h['X-Styrigx-Space-By'] = i.by;
  if (i.tempkeyId) h['X-Styrigx-Space-Tempkey-Id'] = i.tempkeyId;
  if (i.ip) h['X-Styrigx-Client-Address'] = i.ip;
  if (i.country) h['X-Styrigx-Client-Country'] = i.country;
  if (i.city) h['X-Styrigx-Client-City'] = i.city;
  return h;
}

export function cookies(o) {
  return Object.entries(o || {}).filter(([, v]) => v).map(([k, v]) => k + '=' + v).join('; ');
}

/**
 * POST /api/account/<entry>。
 * @param {any} env @param {'session'|'reauth'|'reset'|'keys'|'devices'|'grants'} entry @param {any} body
 * @param {Record<string,string>} [ck] cookie 对象 @param {{identity?:any, headers?:any}} [o]
 */
export async function post(env, entry, body, ck, o = {}) {
  const h = { ...idHeaders(o.identity), ...(o.headers || {}) };
  if (ck && Object.keys(ck).length) h.Cookie = cookies(ck);
  return api[entry].onRequestPost({ request: postReq(ORIGIN + '/api/account/' + entry, body, h), env });
}

/** GET /api/account */
export async function get(env, ck, o = {}) {
  const h = { ...idHeaders(o.identity), ...(o.headers || {}) };
  if (ck && Object.keys(ck).length) h.Cookie = cookies(ck);
  return api.status.onRequestGet({ request: new Request(ORIGIN + '/api/account', { method: 'GET', headers: h }), env });
}

export function accSession(by = 'password', epoch = 0, authAt = Date.now(), o = {}) {
  return session.signSessionTicket(o.priv || K.ACCOUNT.priv, { by, epoch, authAt, deviceId: o.deviceId || TEST_DEVICE_ID, now: o.now });
}
export function reauthTicket(by = 'password', epoch = 0, o = {}) {
  return reauthCore.signReauthTicket(o.priv || K.ACCOUNT.priv, { by, epoch, deviceId: o.deviceId || TEST_DEVICE_ID, iat: o.iat });
}
export function resetTicket(epoch = 0, o = {}) {
  return resetCore.signResetTicket(o.priv || K.ACCOUNT.priv, { epoch, iat: o.iat });
}
/** session + 同纪元、同设备的 reauth 票 */
export async function full(by = 'password', epoch = 0, o = {}) {
  return { 'sgx-account-session': await accSession(by, epoch, Date.now(), o), 'sgx-account-reauth': await reauthTicket(by, epoch, o) };
}

export function setCookies(res) {
  return res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('Set-Cookie') || ''];
}
export function pickCookie(res, name) {
  for (const c of setCookies(res)) if (c.startsWith(name + '=')) return c.split(';')[0].slice(name.length + 1);
  return null;
}

export const raw = (env) => env.D1_ACCOUNT.raw;
export const one = (env, sql, ...p) => { const r = raw(env).prepare(sql).get(...p); return r ? { ...r } : null; };
export const all = (env, sql, ...p) => raw(env).prepare(sql).all(...p).map((r) => ({ ...r }));
export const epochOf = (env, name = 'session') => { const r = one(env, 'SELECT value FROM account_epoch WHERE name = ?', name); return r ? Number(r.value) : 0; };
export const setEpoch = (env, v, name = 'session') => raw(env).prepare('INSERT INTO account_epoch (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value').run(name, v);
export const auditEvents = (env) => all(env, 'SELECT event, ok FROM account_audit ORDER BY ts, rowid').map((r) => r.event + (r.ok ? '' : ':fail'));

export async function seedPassword(env, pw) {
  raw(env).prepare('INSERT INTO account_password (id, record) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record')
    .run(JSON.stringify(await password.makePasswordRecord(pw, PEPPER)));
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function seedPasskey(env, extra = {}) {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const credId = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const rec = { name: '', provider: 'samsung-pass', aaguid: '', createdAt: 1, lastUsedAt: 0, credId, publicKey: jwk, signCount: 0, uv: 1, ...extra };
  raw(env).prepare('INSERT INTO account_passkey (credential_id, record) VALUES (?, ?)').run(credId, JSON.stringify(rec));
  return { kp, credId };
}

export function setHandles(env, handle, legacy = '') {
  raw(env).prepare('INSERT INTO account_user_handle (id, handle, legacy_handle) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET handle = excluded.handle, legacy_handle = excluded.legacy_handle').run(handle, legacy);
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
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN }));
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

/** passkey-challenge → 断言 → passkey 一整套（entry = session | reauth） */
export async function passkeyLogin(env, kp, credId, userHandle, body = {}, ck, aopts, entry = 'session') {
  const ch = await (await post(env, entry, { action: 'passkey-challenge' }, ck)).json();
  const cred = await assertion(kp, credId, ch.challenge, userHandle, aopts);
  return post(env, entry, { action: 'passkey', cid: ch.cid, credential: cred, ...body }, ck);
}
