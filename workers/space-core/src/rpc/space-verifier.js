/**
 * @fileoverview 服务绑定 RPC 入口 SpaceVerifier（进站 v3 Q17 改名；方法 session()、conclusion()）。
 * 授权骨架 P2-1：conclusion(cookieHeader, clientContext, opts)（方案 2.3.2，逻辑在 core/conclusion.js conclusionFor）：
 * 先验进站会话，进了门再经 ACCOUNT_VERIFIER 问账号 Worker，回 { space, account } 结论。
 * 账号会话不在这里回答——由账号 Worker 回答（命名 v2 起只问 AccountVerifier.authorize()）。
 *
 * 只能通过服务绑定调用（其他 Worker 的 wrangler.toml 写 binding = "SPACE"、service = "styrigx-space-core"、
 * entrypoint = "SpaceVerifier"），公网路由进不来。逻辑在 core/lock-session.js checkLockSession（node 单测直接测它）。
 * 调用方：styrigx-curio-core、styrigx-daymark-core（workers/curio-core、workers/daymark-core 两个接口 Worker，只用 conclusion()）。
 * 分享链接 L2 起并入本 Worker，直接调 checkLockSession，不再经 RPC。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { resolveSecrets } from '../secrets.js';
import { checkLockSession } from '../core/lock-session.js';
import { conclusionFor } from '../core/conclusion.js';

export class SpaceVerifier extends WorkerEntrypoint {
  /**
   * 进站会话（进门二值，方案 3.4 R11）：{ ok:true, reason:'ok' } / { ok:false, reason }，不回任何等级。
   * @param {string} cookieHeader
   */
  async session(cookieHeader) {
    return checkLockSession(cookieHeader, await resolveSecrets(this.env));
  }

  /**
   * 结论：{ space: { ok, by, linkId, reason }, account: { ok, deviceId, scopes, reauth, reason } }。
   * space.ok=false 时不问账号（account.reason = 'no-space'）；账号绑定没配 / RPC 出错 / 回了看不懂的东西 → account.ok=false。
   * @param {string} cookieHeader 浏览器发来的 Cookie 头
   * @param {{ua?:string, country?:string, city?:string}} [clientContext]
   * @param {{reauth?:boolean}} [opts] 只有需要账号复验结论的接口才传 reauth: true
   */
  async conclusion(cookieHeader, clientContext, opts) {
    return conclusionFor(await resolveSecrets(this.env), cookieHeader, clientContext, opts);
  }
}
