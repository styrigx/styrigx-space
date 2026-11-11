/**
 * 账号 Worker 单测的 WebAuthn 公共件（v6 P4 起旧账号会话 / reauth / reset / keys 与它们的测试台删除，只留通行密钥断言 / 注册凭据）。
 *
 * - ORIGIN：https://styrigx.com
 * - b64url(buf)
 * - assertion(kp, credId, challenge, userHandle, o?)：按 styrigx.com 的 rpIdHash 签一条断言（UV 默认 1；uv:false 测 UV 必须）
 * - makeAttestationCredential：注册凭据（cred-e2e-helpers）
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const { makeAttestationCredential } = require('../../space/e2e/helpers/cred-e2e-helpers.cjs');

export const ORIGIN = 'https://styrigx.com';

export const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

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
