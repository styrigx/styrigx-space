/**
 * v6 身份统一（P1）：新路径的放行结论——「这个新会话能不能走这条路由」。
 * 路由要哪一档查 core/route-access.js；当前身份由 core/identity-session.js 一次 D1 查询判定；够不够由 core/groups.js permits 判断。
 * 只读、不签发、不写库（续期只回 renew 标志）。永不抛错，出错 fail closed（allowed:false）。
 *
 * 调用方：rpc/account-verifier.js AccountVerifier.admit（网关 core/identity-admit.js 只在请求带新会话 cookie、旧进站会话又不成立时问）。
 * 旧会话（进站会话 / 账号会话）的判定不经这里，原样不动。
 *
 * 只 import core/。
 */
import { levelOf, ruleOf, rescueOf } from './route-access.js';
import { permits, precedence, ACCESS, ROOT_UID } from './groups.js';
import { admitRequest } from './identity-session.js';

/**
 * @typedef {{ allowed: boolean, reason: string, level: string|null, uid: number|null, name: string, groups: string[],
 *   root: boolean, rescue: boolean, via: string, renew: boolean, sessionId?: string }} AdmitConclusion
 */

/** @param {Partial<AdmitConclusion>} o @returns {AdmitConclusion} */
function conclusion(o) {
  return Object.assign({ allowed: false, reason: 'denied', level: null, uid: null, name: '', groups: [], root: false, rescue: false, via: '', renew: false }, o);
}

/**
 * 新会话能不能走这条路由（opts.action 给了 → 按那个 action 的档和救援白名单；网关只传路由，按路由这一档）。
 * 判断只经 groups.js：root 快速放行 = precedence（救援 → root，和 permits 同一个函数），其余 permits 按档。
 * @param {any} env @param {Request} request 只读 Cookie 头 @param {string} method @param {string} pathname @param {number} [now]
 * @param {{action?: string}} [opts]
 * @returns {Promise<AdmitConclusion>}
 */
export async function admitRoute(env, request, method, pathname, now, opts) {
  try {
    const q = opts && typeof opts.action === 'string' ? { action: opts.action } : undefined;
    const rule = ruleOf(method, pathname);
    const level = levelOf(method, pathname, q);
    if (!rule || !level) return conclusion({ reason: 'not-listed' });
    const adm = await admitRequest(env, request, now);
    const identity = adm.ok ? adm.identity : null;
    const ropts = { rescue: rescueOf(method, pathname, q) };
    /* root 快速放行：和 permits 共用 groups.js precedence（救援先判，root 后放），不另写判断 */
    const pre = precedence(identity, ropts);
    const allowed = pre !== null ? pre : permits(identity, level, ropts);
    if (!adm.ok) return conclusion({ allowed, level, reason: allowed ? 'ok' : adm.reason });
    return conclusion({
      allowed, level, reason: allowed ? 'ok' : (level === ACCESS.ROOT ? 'need-root' : 'need-' + level),
      uid: adm.identity.uid, name: adm.identity.name, groups: adm.identity.groups.slice(), root: adm.identity.uid === ROOT_UID,
      rescue: adm.identity.rescue, via: adm.via ? adm.via.name : '', renew: adm.renew, sessionId: adm.sessionId,
    });
  } catch (e) {
    return conclusion({ reason: 'error' });
  }
}
