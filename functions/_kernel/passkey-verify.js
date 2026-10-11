/**
 * 共享 WebAuthn 验证逻辑（L3，无鉴权逻辑）。
 *
 * 从 functions/api/owner-passkey.js 抽出，供登录（owner-passkey）和
 * 二次验证（stepup）复用。安全逻辑只有一套。
 *
 * - cborDecode：最小 CBOR 解码器（RFC 7049）
 * - parseRegAuthData：注册时解析 authenticatorData
 * - coseToJwk：COSE_Key → P-256 JWK（严格校验）
 * - derToRaw：DER 签名 → 64 字节 r||s
 * - checkAssertAuthData：断言时校验 authenticatorData
 * - verifyAssertion：完整断言验证（clientData + authData + signCount + 签名 + UV）
 * - randB64：challenge 随机数
 */
import { b64urlEnc } from './crypto.js';

/** @param {string} b64url @returns {Uint8Array} */
export function b64urlDec(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/** @param {number} n @returns {string} base64url 随机串 */
export function randB64(n) {
  const u8 = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 最小 CBOR 解码器（RFC 7049）：支持 uint/int、bytes、text、array、map、bool/null。
 * 返回 { value, off }：off 是解码结束位置，带扩展数据（ED 位）时可继续解析。
 * @param {Uint8Array} u8
 * @param {number} [start]
 */
export function cborDecode(u8, start) {
  /** @param {number} off @param {number} ai */
  function readUint(off, ai) {
    if (ai < 24) return { value: ai, off: off };
    if (ai === 24) return { value: u8[off], off: off + 1 };
    if (ai === 25) return { value: (u8[off] << 8) | u8[off + 1], off: off + 2 };
    if (ai === 26) {
      const v = u8[off] * 16777216 + ((u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3]);
      return { value: v, off: off + 4 };
    }
    throw new Error('cbor: uint too large');
  }
  /** @param {number} off */
  function decode(off) {
    if (off >= u8.length) throw new Error('cbor: truncated');
    const b = u8[off];
    const mt = b >> 5, ai = b & 31;
    if (mt === 0) {
      const r = readUint(off + 1, ai);
      return { value: r.value, off: r.off };
    }
    if (mt === 1) {
      const r = readUint(off + 1, ai);
      return { value: -1 - r.value, off: r.off };
    }
    if (mt === 2 || mt === 3) {
      const r = readUint(off + 1, ai);
      const end = r.off + r.value;
      if (end > u8.length) throw new Error('cbor: truncated str');
      const slice = u8.slice(r.off, end);
      return { value: mt === 2 ? slice : new TextDecoder().decode(slice), off: end };
    }
    if (mt === 4) {
      const r = readUint(off + 1, ai);
      const arr = [];
      let o = r.off;
      for (let i = 0; i < r.value; i++) {
        const d = decode(o);
        arr.push(d.value);
        o = d.off;
      }
      return { value: arr, off: o };
    }
    if (mt === 5) {
      const r = readUint(off + 1, ai);
      const map = new Map();
      let o = r.off;
      for (let i = 0; i < r.value; i++) {
        const k = decode(o); o = k.off;
        const v = decode(o); o = v.off;
        map.set(k.value, v.value);
      }
      return { value: map, off: o };
    }
    if (mt === 7) {
      if (ai === 20) return { value: false, off: off + 1 };
      if (ai === 21) return { value: true, off: off + 1 };
      if (ai === 22) return { value: null, off: off + 1 };
      throw new Error('cbor: unsupported simple');
    }
    throw new Error('cbor: unsupported major type ' + mt);
  }
  return decode(start || 0);
}

/**
 * 解析注册时的 authenticatorData，校验 rpIdHash / UP 位，提取 credentialId 与 COSE key。
 * authData: rpIdHash(32) | flags(1) | signCount(4) | attestedCredData | [extensions]
 * @param {Uint8Array} authData
 * @param {Uint8Array} rpIdHash
 */
export function parseRegAuthData(authData, rpIdHash) {
  if (authData.length < 37) throw new Error('authData: too short');
  for (let i = 0; i < 32; i++) {
    if (authData[i] !== rpIdHash[i]) throw new Error('authData: rpIdHash mismatch');
  }
  const flags = authData[32];
  if ((flags & 0x01) === 0) throw new Error('authData: UP not set');
  if ((flags & 0x40) === 0) throw new Error('authData: AT not set');
  const signCount = (authData[33] << 24) | (authData[34] << 16) | (authData[35] << 8) | authData[36];
  const uv = (flags & 0x04) !== 0;
  const aaguid = authData.slice(37, 53); // 16 字节 AAGUID
  let off = 37 + 16; // skip AAGUID
  if (off + 2 > authData.length) throw new Error('authData: truncated credIdLen');
  const credIdLen = (authData[off] << 8) | authData[off + 1];
  off += 2;
  if (off + credIdLen > authData.length) throw new Error('authData: truncated credId');
  const credId = authData.slice(off, off + credIdLen);
  off += credIdLen;
  /* COSE key 用 CBOR 严格解，返回结束偏移（ED 扩展数据不影响） */
  const coseRes = cborDecode(authData, off);
  if (!(coseRes.value instanceof Map)) throw new Error('cose: not a map');
  return { credId: credId, coseKey: coseRes.value, signCount: signCount, uv: uv, aaguid: aaguid };
}

/**
 * 从 COSE_Key 提取 P-256 公钥 x, y（严格校验，不再启发式扫描）。
 * 要求：1(kty)=2, 3(alg)=-7, -1(crv)=1, -2/-3 为 32 字节 x/y。
 * @param {Map} coseKey
 */
export function coseToJwk(coseKey) {
  if (coseKey.get(1) !== 2) throw new Error('cose: kty != EC2');
  if (coseKey.get(3) !== -7) throw new Error('cose: alg != ES256');
  if (coseKey.get(-1) !== 1) throw new Error('cose: crv != P-256');
  const x = coseKey.get(-2);
  const y = coseKey.get(-3);
  if (!(x instanceof Uint8Array) || x.length !== 32) throw new Error('cose: bad x');
  if (!(y instanceof Uint8Array) || y.length !== 32) throw new Error('cose: bad y');
  return { kty: 'EC', crv: 'P-256', x: b64urlEnc(x), y: b64urlEnc(y) };
}

/**
 * DER 编码的 ECDSA 签名 → 64 字节 r||s（WebCrypto verify 需要 raw 格式）。
 * 去掉整数前导 0，左右补齐到 32 字节。
 * @param {Uint8Array} der
 */
export function derToRaw(der) {
  let off = 0;
  if (der[off++] !== 0x30) throw new Error('sig: not DER sequence');
  let seqLen = der[off++];
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f;
    if (n > 2) throw new Error('sig: bad DER length');
    seqLen = 0;
    for (let i = 0; i < n; i++) seqLen = (seqLen << 8) | der[off++];
  }
  if (der[off++] !== 0x02) throw new Error('sig: no r');
  const rLen = der[off++];
  let r = der.slice(off, off + rLen);
  off += rLen;
  if (der[off++] !== 0x02) throw new Error('sig: no s');
  const sLen = der[off++];
  let s = der.slice(off, off + sLen);
  /** @param {Uint8Array} v */
  function norm(v) {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    v = v.slice(i);
    if (v.length > 32) throw new Error('sig: int too large');
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  }
  const raw = new Uint8Array(64);
  raw.set(norm(r), 0);
  raw.set(norm(s), 32);
  return raw;
}

/**
 * 校验断言时的 authenticatorData：rpIdHash、UP 位；返回 signCount 与 UV。
 * @param {Uint8Array} authData
 * @param {Uint8Array} rpIdHash
 */
export function checkAssertAuthData(authData, rpIdHash) {
  if (authData.length < 37) throw new Error('authData: too short');
  for (let i = 0; i < 32; i++) {
    if (authData[i] !== rpIdHash[i]) throw new Error('authData: rpIdHash mismatch');
  }
  const flags = authData[32];
  if ((flags & 0x01) === 0) throw new Error('authData: UP not set');
  const signCount = (authData[33] << 24) | (authData[34] << 16) | (authData[35] << 8) | authData[36];
  return { signCount: signCount, uv: (flags & 0x04) !== 0 };
}

/**
 * 完整 WebAuthn 断言验证（登录和 stepup 共用）。
 *
 * 校验：clientData.type=webauthn.get、challenge 相等、origin 严格相等、
 * authenticatorData（rpIdHash、UP）、signCount 递增（双方非零时）、
 * ES256 签名、UV（requireUV 时）。
 *
 * @param {object} opts
 * @param {object} opts.credential { rawId, response: { clientDataJSON, authenticatorData, signature } }
 * @param {string} opts.challenge 服务端下发的 challenge（base64url）
 * @param {Uint8Array} opts.rpIdHash SHA-256(RP_ID)
 * @param {string} opts.expectOrigin 期望 origin（严格相等）
 * @param {object} opts.storedPublicKey 已存 JWK 公钥
 * @param {number} opts.storedSignCount 已存 signCount
 * @param {boolean} [opts.requireUV] 是否强制 UV=1（stepup 必须 true）
 * @returns {Promise<{signCount:number, uv:boolean}>} 成功时返回新 signCount
 * @throws {Error} 失败时抛错，message 为具体原因（challenge/origin/sig/uv-required 等）
 */
export async function verifyAssertion(opts) {
  const { credential, challenge, rpIdHash, expectOrigin, storedPublicKey, storedSignCount, requireUV } = opts;
  const cred = credential || {};
  /* 验证 clientData */
  const clientData = JSON.parse(new TextDecoder().decode(b64urlDec(cred.response.clientDataJSON)));
  if (clientData.type !== 'webauthn.get') throw new Error('type');
  const expChallenge = String(challenge || '').replace(/=+$/, '');
  const gotChallenge = String(clientData.challenge || '').replace(/=+$/, '');
  if (gotChallenge !== expChallenge) throw new Error('challenge');
  if (clientData.origin !== expectOrigin) throw new Error('origin');
  /* 校验 authenticatorData：rpIdHash、UP 位 */
  const authData = b64urlDec(cred.response.authenticatorData);
  const checked = checkAssertAuthData(authData, rpIdHash);
  /* signCount：双方非零时必须递增（防克隆） */
  const oldCount = storedSignCount || 0;
  if (oldCount !== 0 && checked.signCount !== 0 && checked.signCount <= oldCount) {
    throw new Error('signCount');
  }
  /* 验证签名：WebAuthn ES256 签名是 DER 编码，转 64 字节 r||s */
  const cdBytes = b64urlDec(cred.response.clientDataJSON);
  const cdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', cdBytes));
  const sigBase = new Uint8Array(authData.length + cdHash.length);
  sigBase.set(authData, 0);
  sigBase.set(cdHash, authData.length);
  const sigRaw = derToRaw(b64urlDec(cred.response.signature));
  const key = await crypto.subtle.importKey('jwk', storedPublicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sigRaw, sigBase);
  if (!ok) throw new Error('sig');
  /* UV：requireUV 时必须为 1 */
  if (requireUV && !checked.uv) throw new Error('uv-required');
  return { signCount: checked.signCount, uv: checked.uv };
}
