/**
 * 凭证域（realm）配置：每个凭证域用哪把签名钥匙、发什么 cookie、存在 KV 的哪些键。
 *
 * 各接口从这里取值，不在接口里手写 cookie 名、KV 键名、环境变量名。
 * 钥匙命名规范 v1.0：SGX_<PURPOSE>_PRIVATE / SGX_<PURPOSE>_PUBLIC（见 key-names.js、
 * src/secrets.js 的 SECRET_NAMES、wrangler.toml 的 secrets_store_secrets）。
 *
 * 现有凭证域（签名钥匙只有两套：SGX_LOCK_*、SGX_ACCOUNT_*）：
 * - lock    锁屏会话：锁屏解锁后签发的站长 / 访客会话，SGX_LOCK_* 签名；
 *           锁屏凭证的门票、重置锁屏门票（door=lock / lockreset）也用这把钥匙签（_kernel/tickets.js）
 * - account 账号会话：账号登录（账号通行密钥 / 账号密码）成功后签发，SGX_ACCOUNT_* 签名；
 *           账号凭证（AccountKey：账号密码 + 账号通行密钥）只在账号页管理；
 *           账号 → 账号安全的门票（door=account）也用这把钥匙签
 * - root    根凭证（RootKey：SGX_ROOT_KEY）：本身不签票，验过后签发
 *           锁屏门票(by=root)、账号会话(by=root) 或账号门票(by=root)
 *
 * 本文件是叶子模块：只 import key-names.js（同为叶子），不 import 任何接口或 lock-session.js，
 * 避免循环依赖。
 */
import {
  KEY_ROOT,
  KEY_ACCOUNT,
  KEY_LOCK,
  STORE_CLASS_ACCOUNTKEY,
  STORE_CLASS_LOCKKEY,
  PASSKEY_KEY_PREFIX,
} from './key-names.js';

/* 所有凭证 cookie 共用的作用域：主站与子站（blog/daymark）共享 */
const COOKIE_SCOPE = 'Domain=.styrigx.com; Path=/; HttpOnly; Secure';
/* 清除 cookie 时追加的过期时间 */
export const COOKIE_EXPIRED = 'Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';

/* session-epoch：lock 会话与锁屏门票共用的吊销纪元 */
export const SESSION_EPOCH_KEY = 'session-epoch';

/** 会话（锁屏解锁） */
export const REALM_LOCK = Object.freeze({
  id: 'lock',
  keyName: KEY_LOCK,
  privateKey: 'SGX_LOCK_PRIVATE',
  publicKey: 'SGX_LOCK_PUBLIC',
  cookie: 'sgx-verified',
  cookieAttrs: COOKIE_SCOPE + '; SameSite=Lax',
  maxAge: 43200, /* 12 小时（站长会话）；访客会话时长见 lock-session.js */
  pepper: 'SGX_PW_PEPPER', /* 锁屏密码与账号密码共用一个 pepper */
  storeClass: STORE_CLASS_LOCKKEY,
  kv: Object.freeze({
    password: 'lock-pw',
    passwordFailPrefix: 'pw-fail:', /* 锁屏密码输错计数（按 IP） */
    passwordCooldownPrefix: 'pw-lock:', /* 锁屏密码冷却到期时刻（按 IP） */
    passkeyChallengePrefix: 'pk-challenge:', /* 锁屏通行密钥注册与登录 challenge（/api/lock-passkey） */
    resetChallengePrefix: 'lockreset-challenge:', /* 重置锁屏时验账号通行密钥的 challenge（/api/lock-reset） */
    epoch: SESSION_EPOCH_KEY,
  }),
});

/**
 * 账号：账号登录成功后签发独立的账号会话。
 *
 * 票据：by.epoch.authAt.exp[.sid].Ed25519(SGX_ACCOUNT_PRIVATE)，见 _kernel/account-session.js。
 * - by：passkey | password | root
 * - authAt：本次登录验证的时刻（毫秒）
 * - epoch：account-epoch（改账号密码 / 删账号通行密钥时 +1，其他设备的账号会话失效）
 * 与锁屏会话完全独立：锁屏会话从不被当作账号认证。
 *
 * cookie 不带 Domain（只发给 styrigx.com 主站，子站用不到）、SameSite=Strict。
 * 账号页下面的「账号安全」是安全操作：每次进都要再验一次账号凭证，换 3 分钟门票（_kernel/tickets.js）。
 */
export const REALM_ACCOUNT = Object.freeze({
  id: 'account',
  keyName: KEY_ACCOUNT,
  privateKey: 'SGX_ACCOUNT_PRIVATE',
  publicKey: 'SGX_ACCOUNT_PUBLIC',
  cookie: 'sgx-account',
  cookieAttrs: 'Path=/; HttpOnly; Secure; SameSite=Strict',
  /* 400 天（浏览器 Max-Age 上限）：像手机上的账号，不点退出就一直登录；
     进账号页仍要先解锁锁屏（站长锁屏会话是前置条件） */
  maxAge: 34560000,
  pepper: 'SGX_PW_PEPPER',
  storeClass: STORE_CLASS_ACCOUNTKEY,
  bys: Object.freeze(['passkey', 'password', 'root']),
  kv: Object.freeze({
    password: 'owner-pw',
    passkeyPrefix: PASSKEY_KEY_PREFIX, /* 与锁屏通行密钥混存，class 区分 */
    challengePrefix: 'account-challenge:', /* 账号登录/注册 challenge（与锁屏 challenge 隔离） */
    challengeTtl: 300, /* 5 分钟 */
    epoch: 'account-epoch',
    devicePrefix: 'account-dev:', /* 已登录设备记录（每次登录一条，sid 为键；设备页列出、可单独退出） */
    revokedPrefix: 'account-revoked:', /* 被单独退出的会话 sid（黑名单，TTL 同账号会话） */
  }),
});

/** 根凭证（RootKey）：验过后签发门票（锁屏 / 账号，by=root）或账号会话(by=root) */
export const REALM_ROOT = Object.freeze({
  id: 'root',
  keyName: KEY_ROOT,
  secret: 'SGX_ROOT_KEY',
  issues: 'door',
});

/** 全部凭证域（按 id 索引，供测试与通用代码遍历） */
export const REALMS = Object.freeze({
  lock: REALM_LOCK,
  account: REALM_ACCOUNT,
  root: REALM_ROOT,
});

/**
 * 读凭证域的签名私钥；缺失返回 ''（调用方 fail closed）。
 * @param {any} env
 * @param {{privateKey:string}} realm
 * @returns {string}
 */
export function realmPrivateKey(env, realm) {
  return (env && env[realm.privateKey]) || '';
}

/**
 * 读凭证域的验签公钥；缺失返回 ''（调用方 fail closed）。
 * @param {any} env
 * @param {{publicKey:string}} realm
 * @returns {string}
 */
export function realmPublicKey(env, realm) {
  return (env && env[realm.publicKey]) || '';
}

/**
 * Set-Cookie 值：<cookie>=<value>; <attrs>; Max-Age=<maxAge>
 * @param {{cookie:string, cookieAttrs:string, maxAge:number}} realm
 * @param {string} value
 * @param {number} [maxAge] 默认 realm.maxAge
 */
export function realmCookie(realm, value, maxAge) {
  return realm.cookie + '=' + value + '; ' + realm.cookieAttrs + '; Max-Age=' + (maxAge || realm.maxAge);
}

/**
 * 清除 cookie 的 Set-Cookie 值：<cookie>=; <attrs>; Max-Age=0; Expires=1970
 * @param {{cookie:string, cookieAttrs:string}} realm
 */
export function realmClearCookie(realm) {
  return realm.cookie + '=; ' + realm.cookieAttrs + '; ' + COOKIE_EXPIRED;
}

/**
 * WebAuthn 依赖方配置（SGX_RP_ID / SGX_ORIGIN）。必须设置环境变量，不回落。
 * 缺失时返回 null，调用方返回统一的 503 config（见 rpConfigMissing）。
 * @param {any} env
 * @returns {{rpId:string, origin:string}|null}
 */
export function rpConfig(env) {
  const rpId = env && env.SGX_RP_ID;
  const origin = env && env.SGX_ORIGIN;
  if (!rpId || !origin) return null;
  return { rpId: rpId, origin: origin };
}

/** SGX_RP_ID / SGX_ORIGIN 缺失时的统一响应（503，前端据此禁用通行密钥入口） */
export function rpConfigMissing() {
  return Response.json(
    { ok: false, error: 'config', message: 'SGX_RP_ID / SGX_ORIGIN 未配置' },
    { status: 503 }
  );
}
