/**
 * 凭证域（realm）与六张票的配置：每个凭证域用哪把签名钥匙、发什么 cookie、存在 KV 的哪些键。
 *
 * 各接口从这里取值，不在接口里手写 cookie 名、KV 键名、环境变量名。
 * 钥匙命名规范 v1.0：SGX_<PURPOSE>_PRIVATE / SGX_<PURPOSE>_PUBLIC（见 key-names.js、
 * src/secrets.js 的 SECRET_NAMES、wrangler.toml 的 secrets_store_secrets）。
 *
 * 现有凭证域（签名钥匙只有两套：SGX_LOCK_*、SGX_ACCOUNT_*），每域三张票（见下方 TICKETS 总表）：
 * - lock    LockSessionTicket（锁屏解锁后的 admin / visitor 会话）、LockResetTicket（重置锁屏）、
 *           LockReauthTicket（进「安全与隐私 → 锁屏凭证」前再验一次），SGX_LOCK_* 签名，共用 Lock 纪元
 * - account AccountSessionTicket（账号登录）、AccountResetTicket（重置账号登录方式）、
 *           AccountReauthTicket（进「账号 → 账号安全」前再验一次），SGX_ACCOUNT_* 签名，共用 Account 纪元
 * - root    根凭证（RootKey：SGX_ROOT_KEY）：只用来比对，不签名、不拥有会话；
 *           验过后只签四张 reset / reauth 票（by=root）
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

/* 锁屏会话 cookie 的作用域：主站与子站（blog/daymark/curio）共享（子站要读） */
const SHARED_SESSION_ATTRS = 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax';
/* 账号会话 cookie：只发主站，SameSite=Strict */
const ACCOUNT_SESSION_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Strict';
/* 四张 reset / reauth 短票：只发主站、HttpOnly、Strict、3 分钟、不续期 */
const SHORT_TICKET_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Strict';
/* 清除 cookie 时追加的过期时间 */
export const COOKIE_EXPIRED = 'Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';

/* session-epoch：Lock 纪元（锁屏会话、LockReset、LockReauth 三张票共用）。KV 键名第 5 层才改。 */
export const SESSION_EPOCH_KEY = 'session-epoch';
/* account-epoch：Account 纪元（账号会话、AccountReset、AccountReauth 三张票共用） */
export const ACCOUNT_EPOCH_KEY = 'account-epoch';

/* ---------- 六张票：cookie 名 ---------- */
export const LOCK_SESSION_COOKIE = 'sgx-lock-session';
export const LOCK_RESET_COOKIE = 'sgx-lock-reset';
export const LOCK_REAUTH_COOKIE = 'sgx-lock-reauth';
export const ACCOUNT_SESSION_COOKIE = 'sgx-account-session';
export const ACCOUNT_RESET_COOKIE = 'sgx-account-reset';
export const ACCOUNT_REAUTH_COOKIE = 'sgx-account-reauth';

/* ---------- 票里的 by（本次用什么验的） ---------- */
export const BY_PASSWORD = 'password';
export const BY_PASSKEY = 'passkey';
export const BY_TEMPKEY = 'tempkey';
export const BY_ROOT = 'root';
/* LockResetTicket 专用：AccountKey + RootKey 双验（/api/lock-reset 先比对 RootKey，开关无效时再验 AccountKey），
   by 只记 account（RootKey 是这条路的前置条件，不另写进 by） */
export const BY_ACCOUNT = 'account';

/* ---------- 锁屏会话的 role ---------- */
export const ROLE_ADMIN = 'admin';
export const ROLE_VISITOR = 'visitor';

/* ---------- 票名（代码类型名） ---------- */
export const LOCK_SESSION_TICKET = 'LockSessionTicket';
export const LOCK_RESET_TICKET = 'LockResetTicket';
export const LOCK_REAUTH_TICKET = 'LockReauthTicket';
export const ACCOUNT_SESSION_TICKET = 'AccountSessionTicket';
export const ACCOUNT_RESET_TICKET = 'AccountResetTicket';
export const ACCOUNT_REAUTH_TICKET = 'AccountReauthTicket';

/** reset / reauth 短票时长（秒）：3 分钟，不续期 */
export const SHORT_TICKET_MAX_AGE = 180;

/**
 * 六张票总表：票名 → cookie → 私钥 → 公钥 → 时长 → cookie 属性 → 允许的 by → 纪元键（及其 KV 绑定）。
 *
 * 票内容都是点分，最后一段是签名；签名串 = "<cookie 名>|<票内容>"，同一把私钥签的票互相冒充不了。
 * - LockSessionTicket     by.role.epoch.exp.tempkeyId（lock-session.js；admin 的 tempkeyId 段为空串）
 * - AccountSessionTicket  by.epoch.authAt.exp.deviceId（account-session.js）
 * - 四张 reset / reauth   by.epoch.iat.exp（tickets.js 按本表通用签发 / 验证）
 * 私钥、公钥是 Secrets Store 密钥名（不改名）；纪元键所在的 KV 绑定名同样不改。
 */
export const TICKETS = Object.freeze({
  [LOCK_SESSION_TICKET]: Object.freeze({
    cookie: LOCK_SESSION_COOKIE,
    privateKey: 'SGX_LOCK_PRIVATE',
    publicKey: 'SGX_LOCK_PUBLIC',
    maxAge: 43200, /* admin 12 小时；visitor 按临时钥匙剩余时间，上限同为 12 小时（lock-tempkey.js TEMPKEY_SESSION_MAX） */
    cookieAttrs: SHARED_SESSION_ATTRS,
    bys: Object.freeze([BY_PASSWORD, BY_PASSKEY, BY_TEMPKEY]),
    epochKey: SESSION_EPOCH_KEY,
    kvBinding: 'KV_LOCK_DOOR',
  }),
  [LOCK_RESET_TICKET]: Object.freeze({
    cookie: LOCK_RESET_COOKIE,
    privateKey: 'SGX_LOCK_PRIVATE',
    publicKey: 'SGX_LOCK_PUBLIC',
    maxAge: SHORT_TICKET_MAX_AGE,
    cookieAttrs: SHORT_TICKET_ATTRS,
    bys: Object.freeze([BY_ROOT, BY_ACCOUNT]),
    epochKey: SESSION_EPOCH_KEY,
    kvBinding: 'KV_LOCK_DOOR',
  }),
  [LOCK_REAUTH_TICKET]: Object.freeze({
    cookie: LOCK_REAUTH_COOKIE,
    privateKey: 'SGX_LOCK_PRIVATE',
    publicKey: 'SGX_LOCK_PUBLIC',
    maxAge: SHORT_TICKET_MAX_AGE,
    cookieAttrs: SHORT_TICKET_ATTRS,
    bys: Object.freeze([BY_PASSWORD, BY_PASSKEY, BY_ROOT]),
    epochKey: SESSION_EPOCH_KEY,
    kvBinding: 'KV_LOCK_DOOR',
  }),
  [ACCOUNT_SESSION_TICKET]: Object.freeze({
    cookie: ACCOUNT_SESSION_COOKIE,
    privateKey: 'SGX_ACCOUNT_PRIVATE',
    publicKey: 'SGX_ACCOUNT_PUBLIC',
    /* 400 天（浏览器 Max-Age 上限）：像手机上的账号，不点退出就一直登录；
       进账号页仍要先解锁锁屏（admin 锁屏会话是前置条件） */
    maxAge: 34560000,
    cookieAttrs: ACCOUNT_SESSION_ATTRS,
    bys: Object.freeze([BY_PASSWORD, BY_PASSKEY]),
    epochKey: ACCOUNT_EPOCH_KEY,
    kvBinding: 'KV_ACCOUNT_LOGIN',
  }),
  [ACCOUNT_RESET_TICKET]: Object.freeze({
    cookie: ACCOUNT_RESET_COOKIE,
    privateKey: 'SGX_ACCOUNT_PRIVATE',
    publicKey: 'SGX_ACCOUNT_PUBLIC',
    maxAge: SHORT_TICKET_MAX_AGE,
    cookieAttrs: SHORT_TICKET_ATTRS,
    bys: Object.freeze([BY_ROOT]),
    epochKey: ACCOUNT_EPOCH_KEY,
    kvBinding: 'KV_ACCOUNT_LOGIN',
  }),
  [ACCOUNT_REAUTH_TICKET]: Object.freeze({
    cookie: ACCOUNT_REAUTH_COOKIE,
    privateKey: 'SGX_ACCOUNT_PRIVATE',
    publicKey: 'SGX_ACCOUNT_PUBLIC',
    maxAge: SHORT_TICKET_MAX_AGE,
    cookieAttrs: SHORT_TICKET_ATTRS,
    bys: Object.freeze([BY_PASSWORD, BY_PASSKEY, BY_ROOT]),
    epochKey: ACCOUNT_EPOCH_KEY,
    kvBinding: 'KV_ACCOUNT_LOGIN',
  }),
});

/** 会话（锁屏解锁） */
export const REALM_LOCK = Object.freeze({
  id: 'lock',
  keyName: KEY_LOCK,
  privateKey: 'SGX_LOCK_PRIVATE',
  publicKey: 'SGX_LOCK_PUBLIC',
  cookie: LOCK_SESSION_COOKIE,
  cookieAttrs: SHARED_SESSION_ATTRS,
  maxAge: TICKETS[LOCK_SESSION_TICKET].maxAge, /* admin 12 小时；visitor 会话时长见 lock-session.js */
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
 * 票据：AccountSessionTicket（by.epoch.authAt.exp.deviceId），见 _kernel/account-session.js。
 * - by：passkey | password
 * - authAt：本次登录验证的时刻（毫秒）
 * - epoch：account-epoch（改账号密码 / 删账号通行密钥时 +1，其他设备的账号会话失效）
 * 与锁屏会话完全独立：锁屏会话从不被当作账号认证。
 *
 * cookie 不带 Domain（只发给 styrigx.com 主站，子站用不到）、SameSite=Strict。
 * 账号页下面的「账号安全」是安全操作：每次进都要再验一次账号凭证，换 3 分钟 AccountReauthTicket（_kernel/tickets.js）。
 */
export const REALM_ACCOUNT = Object.freeze({
  id: 'account',
  keyName: KEY_ACCOUNT,
  privateKey: 'SGX_ACCOUNT_PRIVATE',
  publicKey: 'SGX_ACCOUNT_PUBLIC',
  cookie: ACCOUNT_SESSION_COOKIE,
  cookieAttrs: ACCOUNT_SESSION_ATTRS,
  maxAge: TICKETS[ACCOUNT_SESSION_TICKET].maxAge,
  pepper: 'SGX_PW_PEPPER',
  storeClass: STORE_CLASS_ACCOUNTKEY,
  bys: TICKETS[ACCOUNT_SESSION_TICKET].bys,
  kv: Object.freeze({
    password: 'owner-pw',
    passkeyPrefix: PASSKEY_KEY_PREFIX, /* 与锁屏通行密钥混存，class 区分 */
    challengePrefix: 'account-challenge:', /* 账号登录/注册 challenge（与锁屏 challenge 隔离） */
    challengeTtl: 300, /* 5 分钟 */
    epoch: ACCOUNT_EPOCH_KEY,
    devicePrefix: 'account-dev:', /* 已登录设备记录（每次登录一条，sid 为键；设备页列出、可单独退出） */
    revokedPrefix: 'account-revoked:', /* 被单独退出的会话 sid（黑名单，TTL 同账号会话） */
  }),
});

/** 根凭证（RootKey）：只用来比对（root-check.js），不签名、不拥有会话；验过后签发四张 reset / reauth 票（by=root） */
export const REALM_ROOT = Object.freeze({
  id: 'root',
  keyName: KEY_ROOT,
  secret: 'SGX_ROOT_KEY',
  issues: Object.freeze([LOCK_REAUTH_TICKET, LOCK_RESET_TICKET, ACCOUNT_REAUTH_TICKET, ACCOUNT_RESET_TICKET]),
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
