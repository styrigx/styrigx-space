/**
 * 账号通行密钥（account_passkey 表）与 WebAuthn user handle（account_user_handle 表）；
 * 以及四个入口共用的两步：发 challenge、验断言（session / reauth 登录）和验注册（keys / reset 添加）。
 *
 * user handle：handle = 账号 handle（第一次注册时生成）；legacy_handle = 拆分前锁屏用的 handle（'' = 没有）。
 * 两个值都是 WebAuthn user.id，旧通行密钥断言时带的就是它：0005 迁移逐字节照抄，代码只读不改。
 * 账号通行密钥登录时 userHandle 等于其中任一个都认。
 *
 * provider：存中性 id（samsung-pass、google-password-manager…），显示名由前端按语言取；
 * 旧库里存的显示名（含中文）已由 migrations/0005_account_tables.sql 一次改好，这里不再认旧值。
 *
 * 只 import workers/account/src/lib/ 和本目录的 config.js。
 */
import { b64urlEnc } from '../lib/crypto.js';
import { onDb, parseRecord } from '../lib/db.js';
import { json, apiError } from '../lib/http.js';
import {
  b64urlDec,
  randB64,
  cborDecode,
  parseRegAuthData,
  coseToJwk,
  verifyAssertion,
  rpIdHashOf,
  consumeChallenge,
  issueChallenge,
  findStoredKey,
} from '../lib/webauthn.js';
import { CHALLENGE_TTL, KEY_ACCOUNT_PASSKEY, PASSKEY_DISPLAY_NAME } from './config.js';

export { findStoredKey, KEY_ACCOUNT_PASSKEY, PASSKEY_DISPLAY_NAME };

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
export function providerOf(aaguid) {
  return (aaguid && AAGUID_PROVIDERS[String(aaguid).toLowerCase()]) || '';
}

/** 存储里的 provider → 认识的 id，否则 '' @param {any} v */
export function providerId(v) {
  const s = String(v || '');
  return PROVIDER_IDS.has(s) ? s : '';
}

/** 用户给的名字：去控制字符、去首尾空白、最多 40 字 @param {any} v */
export function cleanPasskeyName(v) {
  // eslint-disable-next-line no-control-regex
  return String(v || '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 40);
}

/* ---------------- account_passkey ---------------- */

/** 全部通行密钥记录（按注册顺序）。出错抛错。 @param {any} env @returns {Promise<any[]>} */
export async function listPasskeys(env) {
  return onDb(env, async (d) => {
    const res = await d.prepare('SELECT record FROM account_passkey ORDER BY rowid').all();
    return ((res && res.results) || []).map(parseRecord).filter((v) => v && v.credId);
  });
}

/** 同 listPasskeys，读失败 → []（用于「有没有」以外的判断，调用方按没有处理） @param {any} env */
export async function getPasskeys(env) {
  try { return await listPasskeys(env); } catch (e) { return []; }
}

/** 单把（不存在 / 读失败 → null） @param {any} env @param {string} credId */
export async function getPasskey(env, credId) {
  try {
    return await onDb(env, async (d) => {
      const v = parseRecord(await d.prepare('SELECT record FROM account_passkey WHERE credential_id = ?').bind(String(credId)).first());
      return v && v.credId === credId ? v : null;
    });
  } catch (e) {
    return null;
  }
}

/** 字段顺序固定 @param {any} item */
function orderedRecord(item) {
  return {
    name: item.name || '',
    provider: item.provider || '',
    aaguid: item.aaguid || '',
    createdAt: item.createdAt || Date.now(),
    lastUsedAt: item.lastUsedAt || 0,
    credId: item.credId,
    publicKey: item.publicKey,
    signCount: item.signCount || 0,
    uv: item.uv ? 1 : 0,
  };
}

/** 保存（没有就加，同 credId 覆盖）。出错抛错。 @param {any} env @param {any} item */
export async function savePasskey(env, item) {
  const rec = orderedRecord(item);
  await onDb(env, (d) => d.prepare(
    'INSERT INTO account_passkey (credential_id, record) VALUES (?, ?) ON CONFLICT (credential_id) DO UPDATE SET record = excluded.record'
  ).bind(String(rec.credId), JSON.stringify(rec)).run());
  return rec;
}

/** 更新已有的一把（signCount / lastUsedAt / 改名）：已被删掉的不写回。出错抛错。 @param {any} env @param {any} item @returns {Promise<boolean>} */
export async function updatePasskey(env, item) {
  const rec = orderedRecord(item);
  const res = await onDb(env, (d) => d.prepare('UPDATE account_passkey SET record = ? WHERE credential_id = ?')
    .bind(JSON.stringify(rec), String(rec.credId)).run());
  return !!(res && res.meta && res.meta.changes > 0);
}

/** 删一把，返回被删的记录（本来就没有 → null）。出错抛错。 @param {any} env @param {string} credId */
export async function deletePasskey(env, credId) {
  return onDb(env, async (d) => parseRecord(await d.prepare('DELETE FROM account_passkey WHERE credential_id = ? RETURNING record').bind(String(credId)).first()));
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

/* ---------------- account_user_handle ---------------- */

/** 账号 handle（没有就生成 32 字节随机写入；并发第一次注册拿到同一个）。失败 → null。 @param {any} env */
export async function getUserHandle(env) {
  try {
    return await onDb(env, async (d) => {
      const sel = () => d.prepare('SELECT handle FROM account_user_handle WHERE id = 1').first();
      let row = await sel();
      if (!row) {
        await d.prepare('INSERT OR IGNORE INTO account_user_handle (id, handle) VALUES (1, ?)')
          .bind(b64urlEnc(crypto.getRandomValues(new Uint8Array(32)))).run();
        row = await sel();
      }
      return row && row.handle ? String(row.handle) : null;
    });
  } catch (e) {
    return null;
  }
}

/** 只读两个 handle（不新建）：没有 / 失败 → '' @param {any} env @returns {Promise<{handle:string, legacy:string}>} */
export async function peekUserHandles(env) {
  try {
    const row = await onDb(env, (d) => d.prepare('SELECT handle, legacy_handle FROM account_user_handle WHERE id = 1').first());
    return { handle: row && row.handle ? String(row.handle) : '', legacy: row && row.legacy_handle ? String(row.legacy_handle) : '' };
  } catch (e) {
    return { handle: '', legacy: '' };
  }
}

/* ---------------- 四个入口共用的两步 ---------------- */

/**
 * 登录 / 再验证的第一步：发 challenge（allowCredentials = 全部账号通行密钥）。一把都没有 → 403 not-set。
 * @param {any} env @param {{rpId:string, origin:string}} rp @param {string} purpose CHALLENGE_PURPOSE.session | .reauth
 * @returns {Promise<Response>}
 */
export async function assertionChallenge(env, rp, purpose) {
  const keys = await getPasskeys(env);
  if (keys.length === 0) return apiError(403, 'not-set');
  const challenge = randB64(32);
  let cid;
  try { cid = await issueChallenge(env, purpose, challenge, CHALLENGE_TTL); } catch (e) { return apiError(500, 'server'); }
  return json(200, {
    ok: true,
    cid: cid,
    challenge: challenge,
    rpId: rp.rpId,
    allowCredentials: keys.map(function (k) { return { id: k.credId, type: 'public-key' }; }),
  });
}

/**
 * 登录 / 再验证的第二步：消费 challenge → 验断言（UV 必须）→ userHandle 是账号 handle 或 legacy_handle → 记 signCount。
 * 成功 { ok:true }；失败 { ok:false, response }（challenge 403 challenge / not-set / unknown-key / verify / uv-required）。
 * @param {any} env @param {{rpId:string, origin:string}} rp @param {string} purpose @param {any} body { cid, credential }
 * @returns {Promise<{ok:true}|{ok:false, response:Response}>}
 */
export async function checkAssertion(env, rp, purpose, body) {
  const cred = (body && body.credential) || {};
  const chRec = await consumeChallenge(env, purpose, (body && body.cid) || '');
  if (!chRec) return { ok: false, response: apiError(403, 'challenge') };
  const keys = await getPasskeys(env);
  if (keys.length === 0) return { ok: false, response: apiError(403, 'not-set') };
  const stored = findStoredKey(keys, cred.rawId || '');
  if (!stored || !stored.publicKey) return { ok: false, response: apiError(403, 'unknown-key') };
  try {
    const checked = await verifyAssertion({
      credential: cred,
      challenge: chRec.challenge,
      rpIdHash: await rpIdHashOf(rp.rpId),
      expectOrigin: rp.origin,
      storedPublicKey: stored.publicKey,
      storedSignCount: stored.signCount,
      requireUV: true,
    });
    const gotUh = cred.response && cred.response.userHandle;
    if (gotUh) {
      const h = await peekUserHandles(env);
      if (h.handle && gotUh !== h.handle && (!h.legacy || gotUh !== h.legacy)) throw new Error('userHandle');
    }
    stored.signCount = checked.signCount;
    stored.lastUsedAt = Date.now();
    /* signCount / lastUsedAt 回写失败不挡登录（验签已过），但要留日志：不然计数一直停在旧值、克隆检测和「上次使用」都悄悄失效（2026-11-09） */
    try { await updatePasskey(env, stored); } catch (e) {
      console.error('[account-passkey] signCount writeback failed, sign-in allowed:', e && /** @type {any} */ (e).message ? /** @type {any} */ (e).message : e);
    }
  } catch (e) {
    console.error('[account-passkey]', e && /** @type {any} */ (e).message ? /** @type {any} */ (e).message : e);
    const code = (e && /** @type {any} */ (e).message === 'uv-required') ? 'uv-required' : 'verify';
    return { ok: false, response: json(403, { ok: false, error: code }) };
  }
  return { ok: true };
}

/**
 * 添加的第一步：发注册 challenge（user = 账号 handle + AccountPasskey；excludeCredentials = 已有的）。
 * @param {any} env @param {{rpId:string, origin:string}} rp @param {string} purpose CHALLENGE_PURPOSE.keysAdd | .resetAdd
 * @returns {Promise<Response>}
 */
export async function registrationChallenge(env, rp, purpose) {
  const keys = await getPasskeys(env);
  const userHandle = await getUserHandle(env);
  if (!userHandle) return apiError(503, 'server');
  const challenge = randB64(32);
  let cid;
  try { cid = await issueChallenge(env, purpose, challenge, CHALLENGE_TTL); } catch (e) { return apiError(500, 'server'); }
  return json(200, {
    ok: true,
    cid: cid,
    challenge: challenge,
    rpId: rp.rpId,
    rp: { id: rp.rpId, name: 'Styrigx' },
    user: { id: userHandle, name: KEY_ACCOUNT_PASSKEY, displayName: PASSKEY_DISPLAY_NAME },
    excludeCredentials: keys.map(function (k) { return { id: k.credId, type: 'public-key' }; }),
  });
}

/**
 * 添加的第二步：消费 challenge → 验 clientData / attestation（UV 必须）→ 存一把。
 * 成功 { ok:true, credId }；失败 { ok:false, response }。
 * @param {any} env @param {{rpId:string, origin:string}} rp @param {string} purpose @param {any} body { cid, credential, name? }
 * @returns {Promise<{ok:true, credId:string}|{ok:false, response:Response}>}
 */
export async function addPasskey(env, rp, purpose, body) {
  const chRec = await consumeChallenge(env, purpose, (body && body.cid) || '');
  if (!chRec) return { ok: false, response: apiError(403, 'challenge') };
  try {
    const item = await verifyRegistration(rp, chRec.challenge, body);
    const dup = await getPasskey(env, item.credId);
    if (dup) item.createdAt = dup.createdAt || item.createdAt;
    await savePasskey(env, item);
    return { ok: true, credId: item.credId };
  } catch (e) {
    console.error('[account-passkey-add]', e && /** @type {any} */ (e).message ? /** @type {any} */ (e).message : e);
    const code = (e && /** @type {any} */ (e).message === 'uv-required') ? 'uv-required' : 'verify';
    return { ok: false, response: json(403, { ok: false, error: code }) };
  }
}

/**
 * 验一次注册（clientData / attestation，UV 必须），回要存的记录（不存）。账号通行密钥（addPasskey）和 v6 用户通行密钥
 * （core/identity-passkey.js）共用。失败抛错（message = 原因；uv-required 单独认）。
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
