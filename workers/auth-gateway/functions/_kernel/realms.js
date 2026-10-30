/**
 * 锁屏凭证域（realm='lock'）与三张锁屏票的配置：用哪把签名钥匙、发什么 cookie、数据在 D1 的哪一行（realm 列）。
 *
 * 账号拆分 PR3（方案第 2、6.2、8 节）：网关只管锁屏。账号凭证（AccountKey）、账号三张票、Account 纪元、账号根密钥
 * 全在账号 Worker styrigx-account（workers/account/src/identity/realm.js）；网关不读账号的表、不持账号钥匙。
 * 原来的根域 REALM_ROOT 和 BY_ACCOUNT 删除：锁屏根密钥并入 REALM_LOCK（rootKey = 'SGX_ADMIN_KEY'，rootIssues = 两张锁屏短票）。
 *
 * 钥匙概念名：
 * - RootKey：根密钥（网关这一把是锁屏根密钥 SGX_ADMIN_KEY）：只用来比对，验过后签 LockReauthTicket / LockResetTicket，不拥有会话
 * - LockKey：「安全与隐私 → 锁屏凭证」里存放的钥匙（解锁密码、锁屏通行密钥）
 *
 * 存储：D1 styrigx-auth-gateway，只经 D1_LOCK_AUTH 读写 realm='lock' 的行和恢复开关表 lock_reset_switch
 * （方案 9.4 由 recovery_switch 改名；网关代码不再读写旧表 recovery_switch。生产顺序：先跑 scripts/migrate-account-auth.mjs --lock-reset-switch（拷行），再部署本代码，再跑 --verify；--cleanup --confirm（DROP recovery_switch）属于 PR4，在这之后执行）。
 * 表见 migrations/0005_lock_account_state.sql、0006_auth_state.sql、0008_lock_reset_switch.sql（读写入口 d1-state.js 与各 _kernel 模块）。
 * 锁屏根密钥的限速（attempt_limit kind='rootkey'）和审计（audit）也是 realm='lock' 的行。
 * 库里遗留的 realm='account' / realm='root' 行由 PR4 scripts/migrate-account-auth.mjs --cleanup 删除，网关代码不读。
 *
 * 三张票（见 TICKETS），SGX_LOCK_* 签名，共用 Lock 纪元：
 * - LockSessionTicket（锁屏解锁后的 admin / visitor 会话）
 * - LockResetTicket（重置锁屏，by ∈ root / password / passkey）
 * - LockReauthTicket（进「安全与隐私 → 锁屏凭证」前再验一次，by ∈ password / passkey / root）
 *
 * 本文件几乎是叶子模块：只 import lib/ 里同为叶子的 http.js（错误响应）、cookies.js（COOKIE_EXPIRED），避免循环依赖。
 */
import { apiError } from './lib/http.js';
import { COOKIE_EXPIRED } from './lib/cookies.js';

/* 钥匙概念名 */
export const KEY_ROOT = 'RootKey';
export const KEY_LOCK = 'LockKey';

/* 锁屏会话 cookie 的作用域：主站与子站（blog/daymark/curio）共享（子站要读） */
const SHARED_SESSION_ATTRS = 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax';
/* 两张 reset / reauth 短票：只发主站、HttpOnly、Strict、3 分钟、不续期 */
const SHORT_TICKET_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Strict';
/* 清除 cookie 时追加的过期时间（值在 workers/auth-gateway/functions/_kernel/lib/cookies.js，共享短票 tickets.js 也用它） */
export { COOKIE_EXPIRED };

/* lock-epoch：Lock 纪元（锁屏会话、LockReset、LockReauth 三张票共用）；D1 epoch 表 realm='lock' 那一行 */
export const LOCK_EPOCH = 'lock-epoch';

/* ---------- 三张票：cookie 名 ---------- */
export const LOCK_SESSION_COOKIE = 'sgx-lock-session';
export const LOCK_RESET_COOKIE = 'sgx-lock-reset';
export const LOCK_REAUTH_COOKIE = 'sgx-lock-reauth';

/* ---------- 票里的 by（本次用什么验的） ---------- */
export const BY_PASSWORD = 'password';
export const BY_PASSKEY = 'passkey';
export const BY_TEMPKEY = 'tempkey';
export const BY_ROOT = 'root';

/* ---------- 锁屏会话的 role ---------- */
export const ROLE_ADMIN = 'admin';
export const ROLE_VISITOR = 'visitor';

/* ---------- 票名（代码类型名） ---------- */
export const LOCK_SESSION_TICKET = 'LockSessionTicket';
export const LOCK_RESET_TICKET = 'LockResetTicket';
export const LOCK_REAUTH_TICKET = 'LockReauthTicket';

/** reset / reauth 短票时长（秒）：3 分钟，不续期 */
export const SHORT_TICKET_MAX_AGE = 180;

/**
 * 三张锁屏票总表：票名 → cookie → 私钥 → 公钥 → 时长 → cookie 属性 → 允许的 by → 纪元归哪个域（realm：lock）。
 *
 * 票内容都是点分，最后一段是签名；签名串 = "<cookie 名>|<票内容>"，同一把私钥签的票互相冒充不了。
 * - LockSessionTicket     by.role.epoch.exp.tempkeyId（lock-session.js；admin 的 tempkeyId 段为空串）
 * - 两张 reset / reauth   by.epoch.iat.exp（tickets.js 按本表通用签发 / 验证）
 * 私钥、公钥是 Secrets Store 密钥名（不改名）。纪元按域存在 D1（d1-state.js readEpoch / bumpEpoch，每次验票都读主库，不缓存）。
 */
export const TICKETS = Object.freeze({
  [LOCK_SESSION_TICKET]: Object.freeze({
    cookie: LOCK_SESSION_COOKIE,
    privateKey: 'SGX_LOCK_PRIVATE',
    publicKey: 'SGX_LOCK_PUBLIC',
    maxAge: 43200, /* admin 12 小时；visitor 按临时钥匙剩余时间，上限同为 12 小时（lock-tempkey.js TEMPKEY_SESSION_MAX） */
    cookieAttrs: SHARED_SESSION_ATTRS,
    bys: Object.freeze([BY_PASSWORD, BY_PASSKEY, BY_TEMPKEY]),
    realm: 'lock',
  }),
  [LOCK_RESET_TICKET]: Object.freeze({
    cookie: LOCK_RESET_COOKIE,
    privateKey: 'SGX_LOCK_PRIVATE',
    publicKey: 'SGX_LOCK_PUBLIC',
    maxAge: SHORT_TICKET_MAX_AGE,
    cookieAttrs: SHORT_TICKET_ATTRS,
    bys: Object.freeze([BY_ROOT, BY_PASSWORD, BY_PASSKEY]),
    realm: 'lock',
  }),
  [LOCK_REAUTH_TICKET]: Object.freeze({
    cookie: LOCK_REAUTH_COOKIE,
    privateKey: 'SGX_LOCK_PRIVATE',
    publicKey: 'SGX_LOCK_PUBLIC',
    maxAge: SHORT_TICKET_MAX_AGE,
    cookieAttrs: SHORT_TICKET_ATTRS,
    bys: Object.freeze([BY_PASSWORD, BY_PASSKEY, BY_ROOT]),
    realm: 'lock',
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
  pepper: 'SGX_PW_PEPPER', /* 锁屏密码 + 临时钥匙码哈希；与账号 Worker 绑同一个密值（方案 6.2，Secrets Store 密钥名不改） */
  d1Binding: 'D1_LOCK_AUTH', /* lock 的行 + 恢复开关 lock_reset_switch */
  epoch: LOCK_EPOCH, /* 纪元名（票里的纪元归属；D1 epoch 表按 realm 存一行） */
  /* challenge 表的 purpose（锁屏通行密钥注册 / 解锁，重置锁屏时验锁屏通行密钥）；5 分钟 */
  challenge: Object.freeze({ register: 'register', auth: 'auth', reset: 'reset', ttl: 300 }),
  /* 锁屏根密钥（方案 6.2）：Secrets Store 名 SGX_ADMIN_KEY（后台新建一份，值等于原 SGX_ROOT_KEY；Secrets Store 不能直接改名，SGX_ROOT_KEY 不再被绑定、PR4 删）；只比对、不签会话 */
  rootKey: 'SGX_ADMIN_KEY',
  /* 锁屏根密钥验过后能签的票（by=root） */
  rootIssues: Object.freeze([LOCK_REAUTH_TICKET, LOCK_RESET_TICKET]),
});

/** 全部凭证域（按 id 索引，供测试与通用代码遍历） */
export const REALMS = Object.freeze({
  lock: REALM_LOCK,
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
  return apiError(503, 'config', { message: 'SGX_RP_ID / SGX_ORIGIN 未配置' });
}
