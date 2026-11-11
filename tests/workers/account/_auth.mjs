/**
 * 测试用：账号 Worker 接口的 v6 会话测试台（v6 P4，定稿 v5.2 §十三起只认 v6 会话 sgx-session）。
 * 旧的「网关验进站 cookie → 写身份头」这一跳和账号三张票（session / reauth / reset）随进站签发、旧账号会话删除。
 *
 * - V6_TOKEN / V6_COOKIE：一个固定的 v6 会话令牌（seedV6 在库里登记它的哈希）
 * - seedV6(db, o?)：给账号库（makeAccountD1）写一个用户（默认 styrigx uid 1000，默认七组）+ V6_TOKEN 的会话行；返回 db
 *   o.uid / o.name / o.groups / o.token 可改；同一个库可以 seed 多个用户（各用各的 token）
 * - wrap(handler)：给账号处理函数配上 context.auth（gate.js headerAuth）
 * - serviceCall(request, env)：账号 Worker 的 AccountService（serviceFetch）
 */
import './_cf-workers.mjs';
import { STYRIGX_DEFAULT_GROUPS } from '../../../workers/account/src/core/groups.js';
import { sessionIdOf } from '../../../workers/account/src/core/identity-session.js';

/* rpc/*.js 静态 import 了 cloudflare:workers：替身（_cf-workers.mjs）注册好之后再动态 import */
const { headerAuth } = await import('../../../workers/account/src/gate.js');
const { serviceFetch } = await import('../../../workers/account/src/rpc/account-service.js');

export const V6_TOKEN = 'v6testtokenv6testtokenv6testtokenv6testtoke';
export const V6_COOKIE = 'sgx-session=' + V6_TOKEN;
/** 第二个令牌（普通用户 alice，uid 1001，只有 listen） */
export const V6_TOKEN_ALICE = 'v6alicetokenv6alicetokenv6alicetokenv6alice';
export const V6_COOKIE_ALICE = 'sgx-session=' + V6_TOKEN_ALICE;

const IDS = new Map([[V6_TOKEN, await sessionIdOf(V6_TOKEN)], [V6_TOKEN_ALICE, await sessionIdOf(V6_TOKEN_ALICE)]]);

/**
 * @param {any} db makeAccountD1() 的库 @param {{uid?:number, name?:string, groups?:string[], token?:string}} [o]
 */
export function seedV6(db, o = {}) {
  const uid = o.uid ?? 1000;
  const name = o.name || (uid === 1000 ? 'styrigx' : 'user' + uid);
  const groups = o.groups || (uid === 1000 ? [...STYRIGX_DEFAULT_GROUPS] : []);
  const token = o.token || V6_TOKEN;
  const raw = db.raw;
  raw.prepare("INSERT OR IGNORE INTO account_users (uid, name, avatar, expires_at, epoch, disabled, created_at) VALUES (?, ?, '', 0, 0, 0, 1)").run(uid, name);
  for (const g of groups) raw.prepare('INSERT OR IGNORE INTO account_user_groups (uid, grp, added_at) VALUES (?, ?, 1)').run(uid, g);
  const id = IDS.get(token);
  if (!id) throw new Error('seedV6: unknown token');
  const now = Date.now();
  raw.prepare('INSERT OR IGNORE INTO account_sessions (id, uid, epoch, rescue, created_at, expires_at, renewed_at) VALUES (?, ?, 0, 0, ?, ?, ?)').run(id, uid, now, now + 30 * 86400e3, now);
  return db;
}

/** @param {Function} handler onRequestGet / onRequestPost … */
export function wrap(handler) {
  return async (ctx) => handler({ ...ctx, auth: headerAuth(ctx.request, ctx.env) });
}

/** @param {Request} request @param {any} env @param {any} [ctx] */
export async function serviceCall(request, env, ctx) {
  return serviceFetch(request, env, ctx || { waitUntil() {} });
}
