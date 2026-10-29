/**
 * 账号根密钥（SGX_ACCOUNT_ROOT_KEY）与账号审计（账号拆分 PR2b，方案第 5.1、6.2、7.3 节）。
 *
 * POST /api/account 里的三个 action 由 account.js 交到这里（身份头已确认 admin、同源、账号库已绑）：
 * - root-reauth { key } → AccountReauthTicket（by=root）。要有效账号会话（没有 → 401 account）。
 * - root-reset  { key } → AccountResetTicket（by=root）。不要账号会话；不签会话（拿票设好新凭证后正常登录）。
 * - audit-list          → { items:[{ ts, ipPrefix, ok, event }] }，最近 50 条，新的在前（根密钥使用 + 安全事件）。
 *
 * 从网关 functions/api/root-auth.js 的 account-reauth / account-reset 两条真路径复制改写，差别：
 * - 比对的是账号自己的根密钥 SGX_ACCOUNT_ROOT_KEY（REALM_ACCOUNT.rootKey），不是锁屏根密钥；没有恢复开关。
 * - 限速行在本库 attempt_limit realm='account' kind='rootkey'；审计行在本库 audit realm='account'，
 *   path = root-reauth / root-reset（网关原来写 realm='root'、path = account-reauth / account-reset）。
 * - 没有访客 / 无会话假入口：非 admin 身份在 account.js 就 401 session（网关的门本来也不放非 admin 进账号接口）。
 * 规则不变（共享 root-check / root-limit / root-audit 同一份实现）：单 IP 连错 5 次锁 15 分钟（429 cooldown）；
 * 全局每小时满 20 次后每次先等 3 秒；成功清计数；失败统一 401 auth，返回前对齐到 200 毫秒；
 * 缺根密钥或账号库 → 500 config；缺该票的签名钥匙 → 503 config（先于比对）；限速 / 计数 D1 出错 → 503 server；
 * 每次真比对写审计（7 天），成功时写不进审计就不签票（503 server，fail closed）。
 *
 * 共享 root-check 读 realm.secret 作密值名（网关 REALM_ROOT 的字段）；REALM_ACCOUNT 用的是 rootKey。
 * 这里在调用处转接（ROOT_REALM.secret = REALM_ACCOUNT.rootKey），不改共享模块。
 *
 * 安全事件（方案 6.2）：password-change、passkey-register、passkey-delete、passkey-rename、device-revoke、device-revoke-all、
 * login-password-cooldown 各写一行 audit（path = 事件名，保留 30 天）。尽力而为：写不进去不挡操作。
 *
 * 只 import workers/account/src/lib/ 和本目录。
 */
import { rootChecker } from '../lib/root-check.js';
import { rootAuditor, ipPrefix } from '../lib/root-audit.js';
import { onAuthDb, sweepExpired } from '../lib/d1-state.js';
import { json, apiError } from '../lib/http.js';
import { REALM_ACCOUNT, TICKETS, BY_ROOT, ACCOUNT_REAUTH_TICKET, ACCOUNT_RESET_TICKET } from './realm.js';
import { ACCOUNT_DB_REALM } from './account-store.js';
import { verifyAccountSession, issueTicket } from './account-session.js';

/** 共享 root-* 用的根域：账号库 + 密值名 SGX_ACCOUNT_ROOT_KEY（转接 realm.secret） */
export const ROOT_REALM = Object.freeze(Object.assign({}, ACCOUNT_DB_REALM, { secret: REALM_ACCOUNT.rootKey }));

const { checkRootCredential } = rootChecker(ROOT_REALM);
const { writeRootAudit } = rootAuditor(ROOT_REALM);

/** action → 签哪张票（审计 path 就是 action 名） */
export const ROOT_ACTIONS = Object.freeze({
  'root-reauth': ACCOUNT_REAUTH_TICKET,
  'root-reset': ACCOUNT_RESET_TICKET,
});

/** 安全事件名（审计 path），保留 30 天 */
export const SECURITY_EVENTS = Object.freeze([
  'password-change',
  'passkey-register',
  'passkey-delete',
  'passkey-rename',
  'device-revoke',
  'device-revoke-all',
  'login-password-cooldown',
]);
export const SECURITY_EVENT_TTL_MS = 30 * 24 * 3600 * 1000;

/** audit-list 条数 */
export const AUDIT_SHOW = 50;

/* 失败返回前对齐的最短耗时（同网关 root-auth.js MIN_DELAY_MS） */
export const MIN_DELAY_MS = 200;

/** @param {number} t0 */
async function padTo(t0) {
  const wait = t0 + MIN_DELAY_MS - Date.now();
  if (wait > 0) await new Promise(function (r) { setTimeout(r, wait); });
}

/**
 * root-reauth / root-reset。
 * @param {{request:any, env:any, ip:string, action:string, body:any}} o
 * @returns {Promise<Response>}
 */
export async function handleRootAction(o) {
  const { request, env, ip, action, body } = o;
  const t0 = Date.now();
  const ticket = ROOT_ACTIONS[action];
  if (!ticket) return apiError(400, 'action');
  const conf = TICKETS[ticket];
  /* 该票的签名钥匙缺失 → 503 config（先于比对，不浪费限速次数） */
  if (!(env && env[conf.privateKey]) || !(env && env[conf.publicKey])) return apiError(503, 'config');
  if (!(env && env[ROOT_REALM.secret]) || !(env && env[ROOT_REALM.d1Binding])) return apiError(500, 'config');
  if (ticket === ACCOUNT_REAUTH_TICKET) {
    const acc = await verifyAccountSession(request, env);
    if (!acc.ok) return apiError(401, 'account', { reason: acc.reason });
  }
  const rc = await checkRootCredential({
    env: env,
    ip: ip,
    key: (body && typeof body.key === 'string' && body.key) || '',
    auditPath: action,
    padTo: function () { return padTo(t0); },
  });
  if (!rc.ok) return rc.response;
  const headers = new Headers();
  const tErr = await issueTicket(env, headers, ticket, BY_ROOT);
  if (tErr) {
    await writeRootAudit(env, ip, false, { path: action });
    return json(tErr.status, tErr.body);
  }
  /* 审计写入失败则不签发（fail closed）：不带 Set-Cookie 返回 */
  if (!(await writeRootAudit(env, ip, true, { path: action }))) return apiError(503, 'server');
  return json(200, { ok: true }, headers);
}

/**
 * 写一条安全事件（只追加，30 天）。尽力而为：返回是否写进去，从不抛错。
 * @param {any} env @param {string} ip @param {string} event SECURITY_EVENTS 之一 @param {boolean} [ok] 默认 true
 * @returns {Promise<boolean>}
 */
export async function writeSecurityEvent(env, ip, event, ok) {
  if (SECURITY_EVENTS.indexOf(event) === -1) return false;
  try {
    const now = Date.now();
    const id = now + ':' + Math.random().toString(36).slice(2, 10);
    await onAuthDb(env, ACCOUNT_DB_REALM, async function (db, r) {
      await db.prepare('INSERT INTO audit (realm, id, ts, ip_prefix, ok, decoy, via, path, expires_at) VALUES (?, ?, ?, ?, ?, 0, \'\', ?, ?)')
        .bind(r.id, id, now, ipPrefix(ip), ok === false ? 0 : 1, event, now + SECURITY_EVENT_TTL_MS).run();
      await sweepExpired(db, 'audit', r.id, now);
    });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 最近 limit 条审计（根密钥使用 + 安全事件；新的在前；过期的不认）。只给时间、IP 前缀、结果、事件名。出错抛错。
 * @param {any} env @param {number} [limit]
 * @returns {Promise<Array<{ts:number, ipPrefix:string, ok:boolean, event:string}>>}
 */
export async function listAudit(env, limit) {
  const n = Math.max(1, Math.min(AUDIT_SHOW, Math.floor(Number(limit)) || AUDIT_SHOW));
  const res = await onAuthDb(env, ACCOUNT_DB_REALM, (db, r) => db.prepare(
    'SELECT ts, ip_prefix, ok, path FROM audit WHERE realm = ? AND expires_at > ? ORDER BY ts DESC, id DESC LIMIT ?'
  ).bind(r.id, Date.now(), n).all());
  return ((res && res.results) || []).map(function (v) {
    return { ts: Number(v.ts), ipPrefix: String(v.ip_prefix), ok: !!v.ok, event: String(v.path || '') };
  });
}

/** audit-list action @param {any} env @returns {Promise<Response>} */
export async function handleAuditList(env) {
  try {
    return json(200, { ok: true, items: await listAudit(env, AUDIT_SHOW) });
  } catch (e) {
    return apiError(503, 'server');
  }
}
