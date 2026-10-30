/**
 * 账号鉴权存储层（账号拆分 PR2b）：账号库 D1 的域对象、兜底建表语句、账号通行密钥与 user handle 的读写。
 *
 * 从网关 functions/_kernel/passkey-store.js 复制改写账号那一半：只有一个域（账号），不再有 PASSKEY_LOCK / 跨域查重。
 * 存储：D1 styrigx-account（绑定 D1_ACCOUNT_AUTH），表见 migrations/0003_account_auth.sql，每张表 realm 列 = 'account'。
 *
 * ACCOUNT_DB_REALM = REALM_ACCOUNT（realm.js，与网关逐字段相同）+ schema：
 *   交给共享模块（d1-state / attempt-limit / passkey-verify / password / root-*）的都是这个对象。
 *   共享 onAuthDb 遇到 no such table 时用 realm.schema 建表（= 本库 0003 的语句，user_handle 带 legacy_handle），
 *   不会建出网关形状的表（共享 SCHEMA 是网关 0005 / 0006，没有 legacy_handle、有 tempkey / kv_migration）。
 *   ACCOUNT_AUTH_SCHEMA 与 0003 逐条一致（tests/workers/account/account-identity.test.mjs 核对）。
 *
 * user handle：handle = 账号 handle（第一次注册时生成）；legacy_handle = 拆分前锁屏用的 handle（迁移脚本拷入，'' = 没有）。
 * 账号 Passkey 登录时 userHandle 等于其中任一个都认（网关原来去读锁屏域的 handle，这里读本库的 legacy_handle 列）。
 *
 * 只 import workers/account/src/lib/ 和本目录的 realm.js。
 */
import { b64urlEnc } from '../lib/crypto.js';
import {
  onAuthDb,
  listPasskeyRecords,
  getPasskeyRecord,
  putPasskeyRecord,
  updatePasskeyRecord,
  deletePasskeyRecord,
  userHandleRecord,
} from '../lib/d1-state.js';
import { REALM_ACCOUNT } from './realm.js';

/** 与 migrations/0003_account_auth.sql 相同的建表语句（按文件顺序；全部 IF NOT EXISTS） */
export const ACCOUNT_AUTH_SCHEMA = Object.freeze([
  'CREATE TABLE IF NOT EXISTS epoch (realm TEXT PRIMARY KEY, value INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS password (realm TEXT PRIMARY KEY, record TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS passkey (realm TEXT NOT NULL, credential_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (realm, credential_id))',
  "CREATE TABLE IF NOT EXISTS user_handle (realm TEXT PRIMARY KEY, handle TEXT NOT NULL, legacy_handle TEXT NOT NULL DEFAULT '')",
  'CREATE TABLE IF NOT EXISTS challenge (realm TEXT NOT NULL, id TEXT NOT NULL, purpose TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (realm, id))',
  'CREATE TABLE IF NOT EXISTS attempt_limit (realm TEXT NOT NULL, kind TEXT NOT NULL, bucket TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, strikes INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, PRIMARY KEY (realm, kind, bucket))',
  'CREATE TABLE IF NOT EXISTS device (realm TEXT NOT NULL, device_id TEXT NOT NULL, record TEXT NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, PRIMARY KEY (realm, device_id))',
  "CREATE TABLE IF NOT EXISTS audit (realm TEXT NOT NULL, id TEXT NOT NULL, ts INTEGER NOT NULL, ip_prefix TEXT NOT NULL, ok INTEGER NOT NULL, decoy INTEGER NOT NULL DEFAULT 0, via TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL, PRIMARY KEY (realm, id))",
  'CREATE INDEX IF NOT EXISTS audit_ts ON audit (realm, ts)',
  'CREATE TABLE IF NOT EXISTS data_migration (name TEXT PRIMARY KEY, migrated_at INTEGER NOT NULL)',
]);

/** 交给共享模块的账号域：REALM_ACCOUNT + 本库兜底建表语句 */
export const ACCOUNT_DB_REALM = Object.freeze(Object.assign({}, REALM_ACCOUNT, { schema: ACCOUNT_AUTH_SCHEMA }));

/** 账号库是否绑好（缺 → 500 config） @param {any} env */
export function storeReady(env) {
  return !!(env && env[REALM_ACCOUNT.d1Binding]);
}

/* 通行密钥注册时 WebAuthn user.displayName（写死，同网关） */
export const PASSKEY_DISPLAY_NAME = 'Sloan Gray';

/* AAGUID → 密码管理器（只用于显示，同网关 passkey-store.js） */
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

/** @param {string} aaguid */
export function providerOf(aaguid) {
  return (aaguid && AAGUID_PROVIDERS[String(aaguid).toLowerCase()]) || '';
}

/** 账号通行密钥（按注册顺序）。读失败 → []（同网关 getPasskeys）。 @param {any} env */
export async function getPasskeys(env) {
  try {
    return await listPasskeyRecords(env, ACCOUNT_DB_REALM);
  } catch (e) {
    return [];
  }
}

/** 是否至少有一把（读失败抛错，GET 据此 503）。 @param {any} env */
export async function countPasskeys(env) {
  return (await listPasskeyRecords(env, ACCOUNT_DB_REALM)).length;
}

/** 单把（不存在 / 读失败 → null） @param {any} env @param {string} credId */
export async function getPasskey(env, credId) {
  try {
    return await getPasskeyRecord(env, ACCOUNT_DB_REALM, credId);
  } catch (e) {
    return null;
  }
}

/** 字段顺序固定（同网关 orderedRecord） @param {any} item */
function orderedRecord(item) {
  return {
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
}

/** 保存（没有就加，同 credId 覆盖）。出错抛错。 @param {any} env @param {any} item */
export async function savePasskey(env, item) {
  const ordered = orderedRecord(item);
  await putPasskeyRecord(env, ACCOUNT_DB_REALM, ordered);
  return ordered;
}

/** 更新已有的一把（已删的不写回）。出错抛错。 @param {any} env @param {any} item @returns {Promise<boolean>} */
export async function updatePasskey(env, item) {
  return updatePasskeyRecord(env, ACCOUNT_DB_REALM, orderedRecord(item));
}

/** 删一把。出错抛错。 @param {any} env @param {string} credId */
export async function deletePasskey(env, credId) {
  return deletePasskeyRecord(env, ACCOUNT_DB_REALM, credId);
}

/** 账号 handle（没有就生成 32 字节随机写入）。失败 → null。 @param {any} env */
export async function getUserHandle(env) {
  try {
    return (await userHandleRecord(env, ACCOUNT_DB_REALM, true, function () { return b64urlEnc(crypto.getRandomValues(new Uint8Array(32))); })) || null;
  } catch (e) {
    return null;
  }
}

/** 只读账号 handle（不新建）：没有 / 失败 → ''。 @param {any} env */
export async function peekUserHandle(env) {
  try {
    return await userHandleRecord(env, ACCOUNT_DB_REALM, false, function () { return ''; });
  } catch (e) {
    return '';
  }
}

/** 旧锁屏 handle（legacy_handle 列；没有 / 失败 → ''）。 @param {any} env */
export async function peekLegacyHandle(env) {
  try {
    const row = await onAuthDb(env, ACCOUNT_DB_REALM, (db, r) => db.prepare('SELECT legacy_handle FROM user_handle WHERE realm = ?').bind(r.id).first());
    return row && row.legacy_handle ? String(row.legacy_handle) : '';
  } catch (e) {
    return '';
  }
}
