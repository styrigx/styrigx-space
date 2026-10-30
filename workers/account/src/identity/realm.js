/**
 * 账号凭证域（REALM_ACCOUNT）与三张账号票的配置（账号拆分 PR2：从网关 functions/_kernel/realms.js 原样搬来账号那一半）。
 *
 * 线上格式一个字都不变：cookie 名、属性、时长、私钥 / 公钥的 Secrets Store 名、允许的 by、纪元名都和网关现有配置逐字段相同
 * （tests/workers/account/account-realm.test.mjs 拿网关 realms.js 逐字段核对），切换时现有账号票继续有效。
 *
 * 和网关域对象的区别只有两项（方案第 6.2 节）：
 * - rootKey：账号根密钥的 Secrets Store 名 SGX_ACCOUNT_ROOT_KEY（新建，值与锁屏根密钥不同）。只用来比对，永远不签会话。
 * - rootIssues：账号根密钥验过后能签的票（AccountReauthTicket、AccountResetTicket，by=root）。
 * 根密钥的限速 / 审计行就在本域：attempt_limit realm='account' kind='rootkey'、audit realm='account'。
 *
 * 存储：D1 styrigx-account（绑定 D1_ACCOUNT_AUTH），表见 migrations/0003_account_auth.sql，每张表 realm 列 = 'account'。
 * 签名串 = "<cookie 名>|<票内容>"，见 workers/account/src/lib/tickets.js。
 *
 * 叶子模块：只 import 共享模块 workers/account/src/lib/ 里同为叶子的 http.js、cookies.js。
 */
import { apiError } from '../lib/http.js';
import { COOKIE_EXPIRED } from '../lib/cookies.js';

export { COOKIE_EXPIRED };

/* 钥匙概念名 */
export const KEY_ACCOUNT = 'AccountKey';

/* 账号会话 cookie：只发主站，SameSite=Strict（同网关 ACCOUNT_SESSION_ATTRS） */
const ACCOUNT_SESSION_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Strict';
/* reset / reauth 短票：只发主站、HttpOnly、Strict、3 分钟、不续期（同网关 SHORT_TICKET_ATTRS） */
const SHORT_TICKET_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Strict';

/* account-epoch：Account 纪元（账号会话、AccountReset、AccountReauth 三张票共用）；D1 epoch 表 realm='account' 那一行 */
export const ACCOUNT_EPOCH = 'account-epoch';

/* ---------- cookie 名 ---------- */
export const ACCOUNT_SESSION_COOKIE = 'sgx-account-session';
export const ACCOUNT_RESET_COOKIE = 'sgx-account-reset';
export const ACCOUNT_REAUTH_COOKIE = 'sgx-account-reauth';

/* ---------- 票里的 by ---------- */
export const BY_PASSWORD = 'password';
export const BY_PASSKEY = 'passkey';
export const BY_ROOT = 'root';

/* ---------- 票名 ---------- */
export const ACCOUNT_SESSION_TICKET = 'AccountSessionTicket';
export const ACCOUNT_RESET_TICKET = 'AccountResetTicket';
export const ACCOUNT_REAUTH_TICKET = 'AccountReauthTicket';

/** reset / reauth 短票时长（秒）：3 分钟，不续期 */
export const SHORT_TICKET_MAX_AGE = 180;

/**
 * 三张账号票：票名 → cookie → 私钥 → 公钥 → 时长 → cookie 属性 → 允许的 by → 纪元归哪个域。
 * - AccountSessionTicket  by.epoch.authAt.exp.deviceId
 * - AccountReauthTicket / AccountResetTicket  by.epoch.iat.exp（workers/account/src/lib/tickets.js 按本表通用签发 / 验证）
 */
export const TICKETS = Object.freeze({
  [ACCOUNT_SESSION_TICKET]: Object.freeze({
    cookie: ACCOUNT_SESSION_COOKIE,
    privateKey: 'SGX_ACCOUNT_PRIVATE',
    publicKey: 'SGX_ACCOUNT_PUBLIC',
    /* 400 天（浏览器 Max-Age 上限）：不点退出就一直登录；进账号页仍要先有 admin 锁屏会话 */
    maxAge: 34560000,
    cookieAttrs: ACCOUNT_SESSION_ATTRS,
    bys: Object.freeze([BY_PASSWORD, BY_PASSKEY]),
    realm: 'account',
  }),
  [ACCOUNT_RESET_TICKET]: Object.freeze({
    cookie: ACCOUNT_RESET_COOKIE,
    privateKey: 'SGX_ACCOUNT_PRIVATE',
    publicKey: 'SGX_ACCOUNT_PUBLIC',
    maxAge: SHORT_TICKET_MAX_AGE,
    cookieAttrs: SHORT_TICKET_ATTRS,
    bys: Object.freeze([BY_ROOT]),
    realm: 'account',
  }),
  [ACCOUNT_REAUTH_TICKET]: Object.freeze({
    cookie: ACCOUNT_REAUTH_COOKIE,
    privateKey: 'SGX_ACCOUNT_PRIVATE',
    publicKey: 'SGX_ACCOUNT_PUBLIC',
    maxAge: SHORT_TICKET_MAX_AGE,
    cookieAttrs: SHORT_TICKET_ATTRS,
    bys: Object.freeze([BY_PASSWORD, BY_PASSKEY, BY_ROOT]),
    realm: 'account',
  }),
});

/**
 * 账号凭证域。前面各字段与网关 REALM_ACCOUNT 逐字段相同；rootKey / rootIssues 是本 Worker 新增（见文件头）。
 * d1Binding = D1_ACCOUNT_AUTH：本 Worker 里指向账号库 styrigx-account（网关 PR3 起不再有这个绑定，网关库里的账号旧行 PR4 已删）。
 */
export const REALM_ACCOUNT = Object.freeze({
  id: 'account',
  keyName: KEY_ACCOUNT,
  privateKey: 'SGX_ACCOUNT_PRIVATE',
  publicKey: 'SGX_ACCOUNT_PUBLIC',
  cookie: ACCOUNT_SESSION_COOKIE,
  cookieAttrs: ACCOUNT_SESSION_ATTRS,
  maxAge: TICKETS[ACCOUNT_SESSION_TICKET].maxAge,
  pepper: 'SGX_PW_PEPPER', /* 与网关同一个密值（锁屏密码 / 临时钥匙码在网关，账号密码在这里） */
  bys: TICKETS[ACCOUNT_SESSION_TICKET].bys,
  d1Binding: 'D1_ACCOUNT_AUTH',
  epoch: ACCOUNT_EPOCH,
  /* challenge 表的 purpose（账号通行密钥登录 / 注册）；5 分钟 */
  challenge: Object.freeze({ login: 'login', register: 'register', ttl: 300 }),
  rootKey: 'SGX_ACCOUNT_ROOT_KEY',
  rootIssues: Object.freeze([ACCOUNT_REAUTH_TICKET, ACCOUNT_RESET_TICKET]),
});

/** 读签名私钥；缺失返回 ''（调用方 fail closed）。@param {any} env @param {{privateKey:string}} realm */
export function realmPrivateKey(env, realm) {
  return (env && env[realm.privateKey]) || '';
}

/** 读验签公钥；缺失返回 ''（调用方 fail closed）。@param {any} env @param {{publicKey:string}} realm */
export function realmPublicKey(env, realm) {
  return (env && env[realm.publicKey]) || '';
}

/**
 * Set-Cookie 值：<cookie>=<value>; <attrs>; Max-Age=<maxAge>（同网关）
 * @param {{cookie:string, cookieAttrs:string, maxAge:number}} realm @param {string} value @param {number} [maxAge]
 */
export function realmCookie(realm, value, maxAge) {
  return realm.cookie + '=' + value + '; ' + realm.cookieAttrs + '; Max-Age=' + (maxAge || realm.maxAge);
}

/** 清除 cookie 的 Set-Cookie 值（同网关）。@param {{cookie:string, cookieAttrs:string}} realm */
export function realmClearCookie(realm) {
  return realm.cookie + '=; ' + realm.cookieAttrs + '; ' + COOKIE_EXPIRED;
}

/**
 * WebAuthn 依赖方配置（SGX_RP_ID / SGX_ORIGIN），必须设置、不回落；缺失返回 null（同网关）。
 * @param {any} env @returns {{rpId:string, origin:string}|null}
 */
export function rpConfig(env) {
  const rpId = env && env.SGX_RP_ID;
  const origin = env && env.SGX_ORIGIN;
  if (!rpId || !origin) return null;
  return { rpId: rpId, origin: origin };
}

/** SGX_RP_ID / SGX_ORIGIN 缺失时的统一响应（503 config，同网关） */
export function rpConfigMissing() {
  return apiError(503, 'config', { message: 'SGX_RP_ID / SGX_ORIGIN 未配置' });
}
