/**
 * 通行密钥的共用件：AAGUID → 密码管理器 id、给前端的一把（passkeyView）、验一次注册（verifyRegistration）。
 * v6 用户通行密钥（core/identity-passkey.js）用；旧账号通行密钥（account_passkey / account_user_handle 与四个入口）随旧账号会话删除。
 *
 * provider：存中性 id（samsung-pass、google-password-manager…），显示名由前端按语言取。
 *
 * 只 import workers/account/src/lib/。
 */
import { b64urlEnc } from '../lib/crypto.js';
import { b64urlDec, cborDecode, parseRegAuthData, coseToJwk, rpIdHashOf } from '../lib/webauthn.js';

/* AAGUID → 密码管理器 id（只用于显示，不参与安全判断）。存中性 id，不存显示文案：显示名由前端按页面语言从字符串表取（pkProvider.<id>）。
   取自 passkeydeveloper/passkey-authenticator-aaguids；iCloud 钥匙串通常回报全 0 AAGUID，显示为空。 */
const AAGUID_PROVIDERS = {
  '53414d53-554e-4700-0000-000000000000': 'samsung-pass',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'google-password-manager',
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'apple-passwords',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'icloud-keychain',
  'd3452668-01fd-4c12-926c-83a4204853aa': 'microsoft-password-manager',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'windows-hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'windows-hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'windows-hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'bitwarden',
};
const PROVIDER_IDS = new Set(Object.values(AAGUID_PROVIDERS));

/** AAGUID → 密码管理器 id（不认识 → ''）。只用于显示。 @param {string} aaguid */
function providerOf(aaguid) {
  return (aaguid && AAGUID_PROVIDERS[String(aaguid).toLowerCase()]) || '';
}

/** 存储里的 provider → 认识的 id，否则 '' @param {any} v */
function providerId(v) {
  const s = String(v || '');
  return PROVIDER_IDS.has(s) ? s : '';
}

/** 用户给的名字：去控制字符、去首尾空白、最多 40 字 @param {any} v */
function cleanPasskeyName(v) {
  // eslint-disable-next-line no-control-regex
  return String(v || '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 40);
}

/** 给前端的一把 @param {any} k */
export function passkeyView(k) {
  return {
    credId: k.credId,
    name: String(k.name || ''),
    provider: providerId(k.provider),
    createdAt: k.createdAt || 0,
    lastUsedAt: k.lastUsedAt || 0,
  };
}

/**
 * 验一次注册（clientData / attestation，UV 必须），回要存的记录（不存）。v6 用户通行密钥（core/identity-passkey.js）用。失败抛错（message = 原因；uv-required 单独认）。
 * @param {{rpId:string, origin:string}} rp @param {string} challenge 已消费的 challenge @param {any} body { credential, name? }
 */
export async function verifyRegistration(rp, challenge, body) {
  const cred = (body && body.credential) || {};
  const clientData = JSON.parse(new TextDecoder().decode(b64urlDec(cred.response.clientDataJSON)));
  if (clientData.type !== 'webauthn.create') throw new Error('type');
  if (String(clientData.challenge || '').replace(/=+$/, '') !== String(challenge).replace(/=+$/, '')) throw new Error('challenge');
  if (clientData.origin !== rp.origin) throw new Error('origin');
  const attObj = cborDecode(b64urlDec(cred.response.attestationObject)).value;
  if (!(attObj instanceof Map)) throw new Error('attestationObject');
  const authData = attObj.get('authData');
  if (!(authData instanceof Uint8Array)) throw new Error('authData');
  const parsed = parseRegAuthData(authData, await rpIdHashOf(rp.rpId));
  if (!parsed.uv) throw new Error('uv-required');
  const jwk = coseToJwk(parsed.coseKey);
  const credIdB64 = b64urlEnc(parsed.credId);
  let aaguid = '';
  try {
    if (parsed.aaguid) {
      const h = Array.from(parsed.aaguid, (b) => b.toString(16).padStart(2, '0')).join('');
      aaguid = h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    }
  } catch (e) {}
  return {
    /* 用户没起名就存空（不存显示文案），前端按页面语言显示默认名 */
    name: cleanPasskeyName(body && body.name),
    provider: providerOf(aaguid),
    aaguid: aaguid,
    createdAt: Date.now(),
    lastUsedAt: 0,
    credId: credIdB64,
    publicKey: jwk,
    signCount: parsed.signCount,
    uv: 1,
  };
}
