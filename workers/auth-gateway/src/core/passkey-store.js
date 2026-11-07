/**
 * 通行密钥存储（锁屏、账号两域共用的读写层）。
 *
 * 锁屏通行密钥接口（api/lock-passkey.js）、重置锁屏（api/lock-reset.js）、
 * 锁屏凭证状态等都从这里读写。
 *
 * 存储（2026-10-27 起）：D1 styrigx-auth-gateway 的 passkey 表（d1-state.js；只经 D1_LOCK_AUTH 读写 realm='lock' 的行），
 * 每把一行 (realm, credential_id, record)，record 字段顺序固定、不写 class。D1 强一致：注册 / 删除后下一个请求就能读到，
 * 不再有 KV 索引的「读-改-写丢钥匙」和「刚注册锁屏找不到」。上线前 KV 里的记录由 space/scripts/migrate-kv-to-d1.mjs 导入。
 * 用户 handle 在 D1 user_handle 表（每个 realm 一行，第一次注册时生成；以前的 KV lock-user-id / account-user-id 由导入脚本搬来）。
 * 每个函数第一个业务参数是域：只有 PASSKEY_LOCK（LockKey；账号通行密钥 2026-10-30 起只在账号 Worker）。
 *
 * 叶子模块：只 import lib/crypto 和 core/realms、core/d1-state。
 */
import { b64urlEnc } from '../lib/crypto.js';
import { REALM_LOCK } from './realms.js';
import {
  listPasskeyRecords,
  hasPasskeyRecord,
  getPasskeyRecord,
  putPasskeyRecord,
  updatePasskeyRecord,
  deletePasskeyRecord,
  userHandleRecord,
} from './d1-state.js';

/* 通行密钥所属的域（= 凭证域 id）：网关只有锁屏通行密钥（LockKey）；账号通行密钥在账号 Worker */
export const PASSKEY_LOCK = REALM_LOCK.id;

/** @param {string} domain 只认锁屏域 */
function checkDomain(domain) {
  if (domain === PASSKEY_LOCK) return domain;
  throw new Error('passkey-store: bad domain ' + JSON.stringify(domain));
}
/* 通行密钥注册时 WebAuthn user.displayName（写死，用户不填；账号 Worker 用同一个值） */
export const PASSKEY_DISPLAY_NAME = 'Sloan Gray';

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

/* 旧库兼容（读时归一，不迁移）：之前 provider 存的是显示名（含中文），默认名存的是「通行密钥」或 provider 显示名。 */
const LEGACY_PROVIDER_NAMES = {
  'Samsung Pass': 'samsung-pass',
  'Google 密码管理器': 'google-password-manager',
  'Apple 密码': 'apple-passwords',
  'iCloud 钥匙串': 'icloud-keychain',
  'Microsoft 密码管理器': 'microsoft-password-manager',
  'Windows Hello': 'windows-hello',
  '1Password': '1password',
  'Bitwarden': 'bitwarden',
};
const PROVIDER_IDS = new Set(Object.values(AAGUID_PROVIDERS));
/** 旧版写进去的默认名（用户没起名时）：读出来当「没起名」，前端按语言显示默认名 */
const LEGACY_DEFAULT_NAMES = new Set(['通行密钥'].concat(Object.keys(LEGACY_PROVIDER_NAMES)));

/**
 * AAGUID → 密码管理器 id（如 'google-password-manager'；不认识 → ''）。只用于显示。
 * @param {string} aaguid
 */
export function providerOf(aaguid) {
  return (aaguid && AAGUID_PROVIDERS[String(aaguid).toLowerCase()]) || '';
}

/**
 * 存储里的 provider（新：id；旧：显示名）→ id；认不出 → ''。
 * @param {any} v
 */
export function normalizeProvider(v) {
  const s = String(v || '');
  if (PROVIDER_IDS.has(s)) return s;
  return LEGACY_PROVIDER_NAMES[s] || '';
}

/**
 * 存储里的名字 → 用户自起的名字；旧默认名（「通行密钥」、provider 显示名）和空 → ''（前端显示按语言的默认名）。
 * @param {any} v
 */
export function normalizePasskeyName(v) {
  const s = String(v || '');
  return LEGACY_DEFAULT_NAMES.has(s) ? '' : s;
}
/* randB64 / b64urlDec / cborDecode / parseRegAuthData / coseToJwk / derToRaw /
   checkAssertAuthData / verifyAssertion 已抽到 workers/auth-gateway/src/core/passkey-verify.js（解锁、账号登录、重置锁屏共用） */

/**
 * 读某域已注册的通行密钥（按注册顺序）。读失败返回 []（解锁 / 登录 / 列表这些调用方本来就按「没有」处理）。
 * 要区分「没有」和「读不到」的（锁屏入口、真实凭证盘点）用 hasPasskey。
 * @param {any} env @param {string} domain PASSKEY_LOCK | PASSKEY_ACCOUNT
 */
export async function getPasskeys(env, domain) {
  checkDomain(domain);
  try {
    return await listPasskeyRecords(env, domain);
  } catch (e) {
    return [];
  }
}

/**
 * 某域是否至少有一把通行密钥。读失败抛错（调用方按已配置处理，fail closed）。
 * @param {any} env @param {string} domain
 * @returns {Promise<boolean>}
 */
export async function hasPasskey(env, domain) {
  checkDomain(domain);
  return hasPasskeyRecord(env, domain);
}

/**
 * 读某域的单把通行密钥（不存在 / 读失败 → null）。
 * @param {any} env @param {string} domain @param {string} credId
 */
export async function getPasskey(env, domain, credId) {
  checkDomain(domain);
  try {
    return await getPasskeyRecord(env, domain, credId);
  } catch (e) {
    return null;
  }
}

/** 字段顺序固定（name 第一位，方便后台预览），不写 class @param {any} item */
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

/**
 * 保存某域的一把通行密钥（注册：没有就加，同 credId 已有就覆盖）。出错抛错。
 * @param {any} env @param {string} domain @param {any} item
 */
export async function savePasskey(env, domain, item) {
  checkDomain(domain);
  const ordered = orderedRecord(item);
  await putPasskeyRecord(env, domain, ordered);
  return ordered;
}

/**
 * 更新某域已有的一把（解锁 / 登录后的 signCount、lastUsedAt，或改名）。这把已被删掉时什么都不写
 * （不会把刚删的钥匙写回来）。出错抛错。
 * @param {any} env @param {string} domain @param {any} item
 * @returns {Promise<boolean>} 是否真的改到了
 */
export async function updatePasskey(env, domain, item) {
  checkDomain(domain);
  return updatePasskeyRecord(env, domain, orderedRecord(item));
}

/**
 * 删除某域的单把通行密钥。出错抛错。
 * @param {any} env @param {string} domain @param {string} credId
 * @returns {Promise<any|null>} 被删除的记录
 */
export async function deletePasskey(env, domain, credId) {
  checkDomain(domain);
  return deletePasskeyRecord(env, domain, credId);
}

/**
 * 获取或创建固定用户 ID（32 字节随机，D1 user_handle 表）。读写失败返回 null（调用方 503 / 跳过校验，同以前）。
 * 锁屏域自己一个 handle（账号 Worker 另有自己的），不共用，防止 Samsung Pass 把 AccountKey 覆盖到 LockKey 上。
 * @param {any} env
 * @param {string} domain PASSKEY_ACCOUNT | PASSKEY_LOCK
 */
export async function getUserHandle(env, domain) {
  checkDomain(domain);
  try {
    return (await userHandleRecord(env, domain, true, function () { return b64urlEnc(crypto.getRandomValues(new Uint8Array(32))); })) || null;
  } catch (e) {
    return null;
  }
}

/**
 * 只读某域的 user handle（不新建）：没有 / 读失败 → ''。
 * @param {any} env @param {string} domain
 */
export async function peekUserHandle(env, domain) {
  checkDomain(domain);
  try {
    return await userHandleRecord(env, domain, false, function () { return ''; });
  } catch (e) {
    return '';
  }
}
