/**
 * 凭证域（realm）配置：每个凭证域用哪把签名钥匙、发什么 cookie、存在 KV 的哪些键。
 *
 * 纯重构抽出（行为不变）：这里的每个值都和原来散在各接口里的字面量逐字相同，
 * 线上格式（cookie 名/属性/有效期、KV 键名、环境变量名、状态码）一个都没改。
 * 各接口改为从这里取值，将来加新的凭证域只需在下面加一项配置。
 *
 * 钥匙命名规范 v1.0：SGX_<PURPOSE>_PRIVATE / SGX_<PURPOSE>_PUBLIC（见 key-names.js、
 * src/secrets.js 的 SECRET_NAMES、wrangler.toml 的 secrets_store_secrets）。
 *
 * 现有凭证域：
 * - lock   会话（sgx-verified）：锁屏解锁后签发的站长/访客会话，SGX_LOCK_* 签名
 * - stepup 二次验证票据（sgx-stepup）：进「门」后的短时票据，SGX_STEPUP_* 签名
 * - app    应用通行证（sgx-app）：给子站（如 book）的短时通行证，SGX_APP_* 签名
 * - owner  站长凭证（ownerkey：站长密码 owner-pw + class=owner 通行密钥）：
 *          本身不签票，验过后签发 stepup(by=owner, scope=keys)
 * - root   根凭证（rootkey：SGX_ROOT_KEY）：本身不签票，验过后签发
 *          stepup(by=root, scope=root) 或 lock 会话(by=root)
 *
 * 本文件是叶子模块：只 import key-names.js（同为叶子），不 import 任何接口或 session.js，
 * 避免循环依赖。Pages 上没有 functions/（全部后端只在鉴权网关 Worker 里打包），只有一份构建。
 */
import {
  KEY_ROOT,
  KEY_OWNER,
  KEY_LOCK,
  STORE_CLASS_OWNERKEY,
  STORE_CLASS_LOCKKEY,
  STORE_CLASS_APPKEY,
  OWNER_PASSKEY_PREFIX,
} from './key-names.js';

/* 所有凭证 cookie 共用的作用域：主站与子站（blog/book）共享 */
const COOKIE_SCOPE = 'Domain=.styrigx.com; Path=/; HttpOnly; Secure';
/* 清除 cookie 时追加的过期时间 */
export const COOKIE_EXPIRED = 'Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';

/* session-epoch：lock 会话、stepup 票据、app 通行证共用的吊销纪元 */
export const SESSION_EPOCH_KEY = 'session-epoch';

/** 会话（锁屏解锁） */
export const REALM_LOCK = Object.freeze({
  id: 'lock',
  keyName: KEY_LOCK,
  privateKey: 'SGX_LOCK_PRIVATE',
  publicKey: 'SGX_LOCK_PUBLIC',
  cookie: 'sgx-verified',
  cookieAttrs: COOKIE_SCOPE + '; SameSite=Lax',
  maxAge: 43200, /* 12 小时（owner 会话）；visitor 会话 1 小时见 session.js */
  pepper: 'SGX_PW_PEPPER', /* 锁屏密码与站长密码共用一个 pepper */
  storeClass: STORE_CLASS_LOCKKEY,
  kv: Object.freeze({
    password: 'lock-pw',
    epoch: SESSION_EPOCH_KEY,
  }),
});

/** 二次验证票据（进门） */
export const REALM_STEPUP = Object.freeze({
  id: 'stepup',
  privateKey: 'SGX_STEPUP_PRIVATE',
  publicKey: 'SGX_STEPUP_PUBLIC',
  cookie: 'sgx-stepup',
  cookieAttrs: COOKIE_SCOPE + '; SameSite=Strict',
  maxAge: 180, /* A-1：3 分钟（v1.5 #11） */
  scopes: Object.freeze(['root', 'keys', 'lockreset']),
  kv: Object.freeze({
    challengePrefix: 'stepup-challenge:', /* 与登录的 pk-challenge: 隔离 */
    challengeTtl: 300, /* 5 分钟 */
    lockresetChallengePrefix: 'lockreset-challenge:', /* 重置锁屏（/api/lockreset）的站长通行密钥 challenge */
    epoch: SESSION_EPOCH_KEY,
  }),
});

/** 应用通行证（子站） */
export const REALM_APP = Object.freeze({
  id: 'app',
  privateKey: 'SGX_APP_PRIVATE',
  publicKey: 'SGX_APP_PUBLIC',
  cookie: 'sgx-app',
  cookieAttrs: COOKIE_SCOPE + '; SameSite=Lax',
  maxAge: 600, /* 10 分钟 */
  storeClass: STORE_CLASS_APPKEY,
  kv: Object.freeze({
    epochPrefix: 'app-epoch:',
    epoch: SESSION_EPOCH_KEY,
  }),
});

/** 站长凭证（ownerkey）：验过后签发 stepup(by=owner, scope=keys) */
export const REALM_OWNER = Object.freeze({
  id: 'owner',
  keyName: KEY_OWNER,
  pepper: 'SGX_PW_PEPPER',
  issues: 'stepup',
  storeClass: STORE_CLASS_OWNERKEY,
  kv: Object.freeze({
    password: 'owner-pw',
    passkeyPrefix: OWNER_PASSKEY_PREFIX,
    challengePrefix: 'pk-challenge:', /* 通行密钥注册/登录 challenge（owner-passkey 接口） */
  }),
});

/** 根凭证（rootkey）：验过后签发 stepup(by=root, scope=root) 或 lock 会话(by=root) */
export const REALM_ROOT = Object.freeze({
  id: 'root',
  keyName: KEY_ROOT,
  secret: 'SGX_ROOT_KEY',
  issues: 'stepup',
});

/*
 * 将来的「账户」登录在这里加一项（本次重构不加，仅示意位置）：
 *
 * export const REALM_ACCOUNT = Object.freeze({
 *   id: 'account',
 *   privateKey: 'SGX_ACCOUNT_PRIVATE',
 *   publicKey: 'SGX_ACCOUNT_PUBLIC',
 *   cookie: '<独立的会话 cookie 名>',
 *   cookieAttrs: COOKIE_SCOPE + '; SameSite=Lax',
 *   maxAge: <秒>,
 *   kv: Object.freeze({ password: '<账户密码 KV 键>', passkeyPrefix: '<账户通行密钥前缀>' }),
 * });
 *
 * 并同步：src/secrets.js 的 SECRET_NAMES、wrangler.toml 的 secrets_store_secrets、
 * tests/workers/auth-gateway/realms.test.mjs。
 */

/** 全部凭证域（按 id 索引，供测试与通用代码遍历） */
export const REALMS = Object.freeze({
  lock: REALM_LOCK,
  stepup: REALM_STEPUP,
  app: REALM_APP,
  owner: REALM_OWNER,
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
