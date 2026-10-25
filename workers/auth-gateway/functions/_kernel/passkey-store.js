/**
 * 通行密钥存储（锁屏、账号两域共用的读写层）。
 *
 * 从原锁屏通行密钥接口里抽出（纯搬家，行为不变）：锁屏通行密钥接口（api/lock-passkey.js）、
 * 账号接口（api/account.js）、重置锁屏（api/lock-reset.js）、锁屏凭证状态等都从这里读写。
 *
 * KV 结构（KV_LOCK_DOOR，键名见 realms.js 各域的 kv 表）：两域分开存——
 * 每把一个键 <域>-passkey:<credId 前 12 位>，字段顺序固定；索引 <域>-passkey-index 存 credId 数组
 * （避开 kv.list 的最终一致）。键名已表明域，记录里不写也不读 class 字段。
 * 每个函数第一个业务参数是域：PASSKEY_LOCK（LockKey）/ PASSKEY_ACCOUNT（AccountKey）。
 *
 * 叶子模块：只 import _kernel（crypto / realms）。
 */
import { b64urlEnc } from './crypto.js';
import { REALM_LOCK, REALM_ACCOUNT } from './realms.js';

/* 通行密钥所属的域（= 凭证域 id）：锁屏通行密钥（LockKey）/ 账号通行密钥（AccountKey） */
export const PASSKEY_LOCK = REALM_LOCK.id;
export const PASSKEY_ACCOUNT = REALM_ACCOUNT.id;

/** @param {string} domain @returns {{passkeyPrefix:string, passkeyIndex:string, userHandle:string}} */
function domainKv(domain) {
  if (domain === PASSKEY_LOCK) return REALM_LOCK.kv;
  if (domain === PASSKEY_ACCOUNT) return REALM_ACCOUNT.kv;
  throw new Error('passkey-store: bad domain ' + JSON.stringify(domain));
}

/**
 * 通行密钥记录的键：<域>-passkey:<credId 前 12 位>。
 * @param {string} domain PASSKEY_LOCK | PASSKEY_ACCOUNT
 * @param {string} credId 完整 credId
 */
export function passkeyKey(domain, credId) {
  return domainKv(domain).passkeyPrefix + String(credId).slice(0, 12);
}
/* 通行密钥注册时 WebAuthn user.displayName（写死，用户不填；锁屏、账号两域相同） */
export const PASSKEY_DISPLAY_NAME = 'Sloan Gray';

/* AAGUID → 密码管理器（只用于显示，不参与安全判断）。
   取自 passkeydeveloper/passkey-authenticator-aaguids；iCloud 钥匙串通常回报全 0 AAGUID，显示为空。 */
const AAGUID_PROVIDERS = {
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google 密码管理器',
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'Apple 密码',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud 钥匙串',
  'd3452668-01fd-4c12-926c-83a4204853aa': 'Microsoft 密码管理器',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
};

/**
 * AAGUID → 密码管理器显示名（只用于显示；账号页注册账号通行密钥时复用）。
 * @param {string} aaguid
 */
export function providerOf(aaguid) {
  return (aaguid && AAGUID_PROVIDERS[String(aaguid).toLowerCase()]) || '';
}

/* randB64 / b64urlDec / cborDecode / parseRegAuthData / coseToJwk / derToRaw /
   checkAssertAuthData / verifyAssertion 已抽到 ../_kernel/passkey-verify.js（解锁、账号登录、重置锁屏共用） */

/**
 * 读某域的索引；索引不存在时按前缀扫一遍补建（只扫本域的键）。
 * @param {any} kv @param {string} domain
 */
async function ensureIndex(kv, domain) {
  const c = domainKv(domain);
  try {
    const idx = await kv.get(c.passkeyIndex, 'json');
    if (Array.isArray(idx)) return idx;
  } catch (e) {}
  const idx = [];
  try {
    const list = await kv.list({ prefix: c.passkeyPrefix });
    for (const k of list.keys || []) {
      try {
        const v = await kv.get(k.name, 'json');
        if (v && v.credId && !idx.includes(v.credId)) idx.push(v.credId);
      } catch (e2) {}
    }
    await kv.put(c.passkeyIndex, JSON.stringify(idx));
  } catch (e3) {}
  return idx;
}

/**
 * 按索引读取某域已注册的通行密钥（不走 kv.list，避开最终一致延迟）。
 * @param {any} kv @param {string} domain PASSKEY_LOCK | PASSKEY_ACCOUNT
 */
export async function getPasskeys(kv, domain) {
  try {
    const idx = await ensureIndex(kv, domain);
    const keys = [];
    for (const credId of idx) {
      try {
        const v = await kv.get(passkeyKey(domain, credId), 'json');
        if (v && v.credId === credId) keys.push(v);
      } catch (e) {}
    }
    return keys;
  } catch (e) {
    return [];
  }
}

/**
 * 读某域的单把通行密钥（不存在 / 读失败 → null）。
 * @param {any} kv @param {string} domain @param {string} credId
 */
export async function getPasskey(kv, domain, credId) {
  try {
    const v = await kv.get(passkeyKey(domain, credId), 'json');
    return v && v.credId === credId ? v : null;
  } catch (e) {
    return null;
  }
}

/**
 * 保存某域的单把通行密钥（字段顺序固定，不写 class）。
 * @param {any} kv @param {string} domain @param {any} item
 */
export async function savePasskey(kv, domain, item) {
  const c = domainKv(domain);
  /* 字段顺序固定：name 第一位，方便后台预览 */
  const ordered = {
    name: item.name || '通行密钥',
    provider: item.provider || '',
    aaguid: item.aaguid || '',
    createdAt: item.createdAt || Date.now(),
    lastUsedAt: item.lastUsedAt || 0,
    credId: item.credId,
    publicKey: item.publicKey,
    signCount: item.signCount || 0,
    uv: item.uv ? 1 : 0,
  };
  await kv.put(passkeyKey(domain, item.credId), JSON.stringify(ordered), {
    metadata: { name: ordered.name, provider: ordered.provider, createdAt: ordered.createdAt },
  });
  /* 同步更新索引（避开 kv.list 的最终一致延迟） */
  try {
    let idx = await kv.get(c.passkeyIndex, 'json');
    if (!Array.isArray(idx)) idx = [];
    if (!idx.includes(item.credId)) {
      idx.push(item.credId);
      await kv.put(c.passkeyIndex, JSON.stringify(idx));
    }
  } catch (e) {}
  return ordered;
}

/**
 * 删除某域的单把通行密钥。
 * @param {any} kv @param {string} domain @param {string} credId
 * @returns {Promise<any|null>} 被删除的记录
 */
export async function deletePasskey(kv, domain, credId) {
  const c = domainKv(domain);
  const keyName = passkeyKey(domain, credId);
  let rec = null;
  try { rec = await kv.get(keyName, 'json'); } catch (e) {}
  await kv.delete(keyName);
  try {
    let idx = await kv.get(c.passkeyIndex, 'json');
    if (Array.isArray(idx)) {
      idx = idx.filter(id => id !== credId);
      await kv.put(c.passkeyIndex, JSON.stringify(idx));
    }
  } catch (e) {}
  return rec;
}

/**
 * 获取或创建固定用户 ID（32 字节随机，存 KV）。
 * 锁屏、账号两域各用一个 handle（lock-user-id / account-user-id，见 realms.js），
 * 不共用，防止 Samsung Pass 把 AccountKey 覆盖到 LockKey 上。
 * @param {any} kv
 * @param {string} domain PASSKEY_ACCOUNT | PASSKEY_LOCK
 */
export async function getUserHandle(kv, domain) {
  const key = domainKv(domain).userHandle;
  try {
    let uh = await kv.get(key);
    if (!uh) {
      const u8 = crypto.getRandomValues(new Uint8Array(32));
      uh = b64urlEnc(u8);
      await kv.put(key, uh);
    }
    return uh;
  } catch (e) {
    return null;
  }
}
