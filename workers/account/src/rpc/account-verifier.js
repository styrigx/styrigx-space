/**
 * @fileoverview 账号 Worker 的命名入口 AccountVerifier（WorkerEntrypoint，RPC；只有网关绑定，服务绑定 ACCOUNT_VERIFIER）：
 * - （命名 v2 删掉 session()：唯一的调用方网关首帧提示随旧账号整页一起删了；临时钥匙管理、短链只认进站会话 + 锁侧复验）
 * - （v6 P4，定稿 v5.2 §十三：authorize() 随旧账号会话与作用域授权删除）
 * - admit(cookieHeader, method, pathname, opts?)：v6 新会话的放行结论（P1 新增，逻辑在 core/admit.js；只读，一次 D1 查询）。
 *   网关只在请求带 v6 会话 cookie（sgx-session）时问。
 *   割接（v6 cutover）：opts.action 给了就按那个 action 的档判（levelOf / rescueOf 同一张表），回答里回同一个 action（调用方核对，
 *   旧版本不认 action 时回的是路由档，不能当 action 的结论）；子站接口 Worker 经网关 SpaceVerifier.admit 转来问。
 * - auditRoot(cookieHeader, command, address)：root 在别的 Worker 做了特权内容操作（批量 / 结构删除、导入导出、分享管理），
 *   在账号侧身份审计（account_user_audit）留一行。会话由这里重新判定（只认真 root 层，救援不算），调用方给的身份一概不认。
 * 不签发任何东西。
 * cloudflare:workers 只在 Workers 里有：node 单测用 tests/workers/account/_cf-workers.mjs 的替身。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { MAX_COOKIE_HEADER } from '../lib/cookies.js';
import { CLIENT_CONTEXT_HEADERS } from '../lib/gateway.js';
import { resolveSecrets } from '../secrets.js';
import { admitRoute } from '../core/admit.js';
import { admitRequest } from '../core/identity-session.js';
import { ruleOf } from '../core/route-access.js';
import { ROOT_UID } from '../core/groups.js';
import { writeUserAudit } from '../core/user-audit.js';

const MAX_UA = 512;

/**
 * 把 RPC 参数还原成一个只带 Cookie / User-Agent / 地点头的内部请求（v6 会话判定读 Cookie）。
 * @param {string} cookieHeader
 * @param {{ua?:string, country?:string, city?:string}} [clientContext]
 */
export function verifierRequest(cookieHeader, clientContext) {
  /** @type {Record<string,string>} */
  const headers = {};
  const c = typeof cookieHeader === 'string' ? cookieHeader.slice(0, MAX_COOKIE_HEADER) : '';
  if (c) headers.Cookie = c;
  const m = clientContext && typeof clientContext === 'object' ? clientContext : {};
  if (typeof m.ua === 'string' && m.ua) headers['User-Agent'] = m.ua.slice(0, MAX_UA);
  if (typeof m.country === 'string' && m.country) headers[CLIENT_CONTEXT_HEADERS.country] = m.country;
  if (typeof m.city === 'string' && m.city) headers[CLIENT_CONTEXT_HEADERS.city] = m.city;
  return new Request('https://internal.invalid/', { headers });
}

/** RPC 里 action 的写法（路由表里的 action 名：小写字母、数字、点、连字符） */
const ACTION_RE = /^[a-z0-9.-]{1,32}$/;

/**
 * AccountVerifier.admit 的实现：参数只认字符串（RPC 传来的别的东西当空），永不抛错。
 * opts.action（割接）：路由表里这条路由列了这个 action 才按它判，回答带回 action；没列 / 不合法 → 拒（不退回路由档）。
 * @param {Record<string, any>} env @param {string} cookieHeader @param {string} method @param {string} pathname
 * @param {{action?: string}} [opts]
 */
export async function checkAdmit(env, cookieHeader, method, pathname, opts) {
  const m = typeof method === 'string' ? method.slice(0, 10) : '';
  const p = typeof pathname === 'string' ? pathname.slice(0, 2048) : '';
  const deny = (/** @type {string} */ reason, /** @type {string} */ action) => ({ allowed: false, reason, level: null, uid: null, name: '', groups: [], root: false, rescue: false, via: '', renew: false, action });
  const asked = opts && typeof opts === 'object' && opts.action !== undefined;
  const action = asked && typeof opts.action === 'string' ? opts.action : '';
  if (asked && !ACTION_RE.test(action)) return deny('action', '');
  /* 问 action 的，这条路由必须真列了这个 action（levelOf 对没有 actions 的路由会退回路由档，RPC 这里不许退） */
  if (asked) {
    const r = ruleOf(m, p);
    if (!r || !r.actions || !Object.prototype.hasOwnProperty.call(r.actions, action)) return deny('action', action);
  }
  try {
    const c = await admitRoute(env || {}, verifierRequest(cookieHeader), m, p, undefined, asked ? { action } : undefined);
    delete c.sessionId; /* 会话行 id 不出账号 Worker */
    return Object.assign(c, { action });
  } catch (e) {
    return deny('error', action);
  }
}

/** 别的 Worker 能经 auditRoot 记的命令字（root 的特权内容操作；身份命令只在本 Worker 记） */
export const REMOTE_AUDIT_COMMANDS = Object.freeze(['rm-bulk', 'import', 'export', 'share']);

/**
 * AccountVerifier.auditRoot 的实现：会话的当前身份是 root（非救援）才写；命令字不在 REMOTE_AUDIT_COMMANDS → 不写。永不抛错。
 * @param {Record<string, any>} env @param {string} cookieHeader @param {string} command @param {string} address 客户端 IP（这里只存前缀）
 * @returns {Promise<boolean>} 写进去了没有
 */
export async function checkAuditRoot(env, cookieHeader, command, address) {
  try {
    const cmd = typeof command === 'string' ? command.trim().slice(0, 200) : '';
    if (REMOTE_AUDIT_COMMANDS.indexOf(cmd.split(/\s+/)[0]) === -1) return false;
    const adm = await admitRequest(env || {}, verifierRequest(cookieHeader));
    if (!adm || !adm.ok || adm.identity.uid !== ROOT_UID || adm.identity.rescue === true) return false;
    return await writeUserAudit(env, { uid: ROOT_UID, command: cmd, ok: true, ip: typeof address === 'string' ? address.slice(0, 64) : '' });
  } catch (e) {
    return false;
  }
}

/** 放行结论与 root 留痕（服务绑定 ACCOUNT_VERIFIER：只有网关） */
export class AccountVerifier extends WorkerEntrypoint {
  /**
   * v6 新会话的放行结论（core/admit.js）：{ allowed, reason, level, uid, name, groups, root, rescue, via, renew, action }。
   * @param {string} cookieHeader @param {string} method @param {string} pathname @param {{action?: string}} [opts]
   */
  async admit(cookieHeader, method, pathname, opts) {
    return checkAdmit(this.env, cookieHeader, method, pathname, opts);
  }

  /**
   * root 的特权内容操作留痕（割接：子站 / 网关的 root 操作写进账号侧身份审计）。
   * @param {string} cookieHeader @param {string} command @param {string} address
   */
  async auditRoot(cookieHeader, command, address) {
    return checkAuditRoot(this.env, cookieHeader, command, address);
  }
}
