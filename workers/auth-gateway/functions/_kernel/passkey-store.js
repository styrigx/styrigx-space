/**
 * 通行密钥存储（锁屏、账号两域共用的读写层）。
 *
 * 从原锁屏通行密钥接口里抽出（纯搬家，行为不变）：锁屏通行密钥接口（api/lock-passkey.js）、
 * 账号接口（api/account.js）、重置锁屏（api/lock-reset.js）、锁屏凭证状态等都从这里读写。
 *
 * KV 结构（KV_LOCK_DOOR，存储键名见 key-names.js）：每把一个键 PASSKEY_KEY_PREFIX + credId 前 12 位，
 * 字段顺序固定；索引 PASSKEY_INDEX_KEY 存 credId 数组（避开 kv.list 的最终一致）。
 * 记录的 class 字段区分域：PK_CLASS_LOCK（LockKey）/ PK_CLASS_ACCOUNT（AccountKey）。
 *
 * 叶子模块：只 import _kernel（crypto / key-names）。
 */
import { b64urlEnc } from './crypto.js';
import {
  STORE_CLASS_ACCOUNTKEY,
  STORE_CLASS_LOCKKEY,
  passkeyKey,
  PASSKEY_KEY_PREFIX,
  PASSKEY_INDEX_KEY,
  LEGACY_PASSKEY_ARRAY_KEY,
  LOCK_USER_HANDLE_KEY,
  ACCOUNT_USER_HANDLE_KEY,
} from './key-names.js';

/* 通行密钥分类：钥匙命名规范（key-names.js）：存储层 class 字段值保留 'owner'/'lock'
   不迁移；概念名用 AccountKey/LockKey。应用凭证已删除（旧 class=app 记录不再被任何接口读取）。 */
export const PK_CLASS_ACCOUNT = STORE_CLASS_ACCOUNTKEY;
export const PK_CLASS_LOCK = STORE_CLASS_LOCKKEY;
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
 * 获取所有通行密钥（新结构：每把一个 key）。
 * 索引补建逻辑见 ensureIndex。
 * 2.10.0：幂等迁移——没有 class 字段的旧凭据视为 lock 并写回（重复执行无副作用）。
 */
async function ensureIndex(kv) {
  try {
    let idx = await kv.get(PASSKEY_INDEX_KEY, 'json');
    if (Array.isArray(idx)) return idx;
  } catch (e) {}
  /* 索引不存在：一次性补建 */
  const idx = [];
  try {
    const list = await kv.list({ prefix: PASSKEY_KEY_PREFIX });
    for (const k of list.keys || []) {
      try {
        const v = await kv.get(k.name, 'json');
        if (v && v.credId && !idx.includes(v.credId)) idx.push(v.credId);
      } catch (e2) {}
    }
    await kv.put(PASSKEY_INDEX_KEY, JSON.stringify(idx));
  } catch (e3) {}
  return idx;
}

/** 按索引读取已注册 passkey（不走 kv.list，避开最终一致延迟） */
export async function getPasskeys(kv) {
  try {
    /* 按索引读，不走 kv.list（避开最终一致延迟） */
    const idx = await ensureIndex(kv);
    const keys = [];
    for (const credId of idx) {
      try {
        const keyName = passkeyKey(credId);
        const v = await kv.get(keyName, 'json');
        if (v && v.credId === credId) {
          /* 2.10.0 幂等迁移：无 class 的旧凭据 → lock，写回（重复执行无副作用） */
          if (!v.class) {
            v.class = PK_CLASS_LOCK;
            try { await kv.put(keyName, JSON.stringify(v)); } catch (e2) {}
          }
          keys.push(v);
        }
      } catch (e) {}
    }
    /* 一次性迁移：旧数组结构 → 新结构（含索引补建） */
    if (keys.length === 0) {
      try {
        const old = await kv.get(LEGACY_PASSKEY_ARRAY_KEY, 'json');
        if (Array.isArray(old) && old.length > 0) {
          const newIdx = [];
          for (const item of old) {
            if (item && item.credId) {
              const migrated = {
                name: item.name || '通行密钥',
                provider: item.provider || '',
                aaguid: item.aaguid || '',
                createdAt: item.createdAt || Date.now(),
                lastUsedAt: item.lastUsedAt || 0,
                credId: item.credId,
                publicKey: item.publicKey,
                signCount: item.signCount || 0,
                uv: item.uv ? 1 : 0,
                class: PK_CLASS_LOCK,
              };
              const keyName = passkeyKey(item.credId);
              await kv.put(keyName, JSON.stringify(migrated), {
                metadata: { name: migrated.name, provider: migrated.provider, createdAt: migrated.createdAt },
              });
              keys.push(migrated);
              newIdx.push(item.credId);
            }
          }
          await kv.put(PASSKEY_INDEX_KEY, JSON.stringify(newIdx));
          await kv.delete(LEGACY_PASSKEY_ARRAY_KEY);
        }
      } catch (e) {}
    }
    return keys;
  } catch (e) {
    return [];
  }
}

/**
 * 保存单把通行密钥。
 * 账号 / 锁屏两种 class 原样保存；其他值拒绝（抛错），绝不默认归锁屏。
 * @param {any} kv
 * @param {any} item
 */
export async function savePasskey(kv, item) {
  const keyName = passkeyKey(item.credId);
  /* P0-15：class 必须原样保存，账号通行密钥绝不能被改成锁屏通行密钥 */
  const cls = item.class;
  if (cls !== PK_CLASS_ACCOUNT && cls !== PK_CLASS_LOCK) {
    throw new Error('invalid-class');
  }
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
    class: cls,
  };
  await kv.put(keyName, JSON.stringify(ordered), {
    metadata: { name: ordered.name, provider: ordered.provider, createdAt: ordered.createdAt },
  });
  /* 同步更新索引（避开 kv.list 的最终一致延迟） */
  try {
    let idx = await kv.get(PASSKEY_INDEX_KEY, 'json');
    if (!Array.isArray(idx)) idx = [];
    if (!idx.includes(item.credId)) {
      idx.push(item.credId);
      await kv.put(PASSKEY_INDEX_KEY, JSON.stringify(idx));
    }
  } catch (e) {}
  return ordered;
}

/**
 * 删除单把通行密钥。
 * @param {any} kv
 * @param {string} credId
 * @returns {Promise<any|null>} 被删除的记录
 */
export async function deletePasskey(kv, credId) {
  const keyName = passkeyKey(credId);
  let rec = null;
  try { rec = await kv.get(keyName, 'json'); } catch (e) {}
  await kv.delete(keyName);
  /* 同步更新索引 */
  try {
    let idx = await kv.get(PASSKEY_INDEX_KEY, 'json');
    if (Array.isArray(idx)) {
      idx = idx.filter(id => id !== credId);
      await kv.put(PASSKEY_INDEX_KEY, JSON.stringify(idx));
    }
  } catch (e) {}
  return rec;
}

/**
 * 获取或创建固定用户 ID（32 字节随机，存 KV）。
 * 锁屏、账号两域各用一个 handle（LOCK_USER_HANDLE_KEY / ACCOUNT_USER_HANDLE_KEY，存储键名见 key-names.js），
 * 不共用，防止 Samsung Pass 把 AccountKey 覆盖到 LockKey 上。
 * @param {any} kv
 * @param {string} pkClass 凭据类别：PK_CLASS_ACCOUNT | PK_CLASS_LOCK
 */
export async function getUserHandle(kv, pkClass) {
  const key = pkClass === PK_CLASS_ACCOUNT ? ACCOUNT_USER_HANDLE_KEY : LOCK_USER_HANDLE_KEY;
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
