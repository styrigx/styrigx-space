/**
 * @fileoverview 服务绑定 RPC 入口 AuthVerifier（lockSession()、conclusion()）。ShareIssuer 在 rpc/share-issuer.js。
 * 授权骨架 P2-1：加 conclusion(cookieHeader, clientContext, opts)（方案 2.3.2，逻辑在 core/conclusion.js conclusionFor）：
 * 网关验门，进了门再经 ACCOUNT_VERIFIER 问账号 Worker，回 { lock, account } 结论。只新增，P2-2 起子站接口 Worker 才调用。
 * 账号拆分 PR3：AuthVerifier 不回答账号 session——由账号 Worker 的 AccountVerifier.session() 回答。
 *
 * 只能通过服务绑定调用（其他 Worker 的 wrangler.toml 写 service = "styrigx-auth-gateway"、
 * entrypoint = "AuthVerifier"），公网路由进不来。逻辑在 core/lock-session.js checkLockSession（node 单测直接测它）。
 * 调用方：styrigx-daymark-core、styrigx-curio-core（workers/daymark-core、workers/curio-core 两个接口 Worker）、styrigx-share（workers/share，只用 lockSession）。
 * 应用通行证（appPass / appEpoch）已随应用凭证删除；后台上传等服务操作以后由账号体系管控。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { resolveSecrets } from '../secrets.js';
import { checkLockSession } from '../core/lock-session.js';
import { conclusionFor } from '../core/conclusion.js';

export class AuthVerifier extends WorkerEntrypoint {
  /**
   * 进站会话（进门二值，方案 3.4 R11）：{ ok:true, reason:'ok' } / { ok:false, reason }，不回任何等级。短链 Worker 用。
   * @param {string} cookieHeader
   */
  async lockSession(cookieHeader) {
    return checkLockSession(cookieHeader, await resolveSecrets(this.env));
  }

  /**
   * 网关结论：{ lock: { ok, by, tempkeyId, reason }, account: { ok, deviceId, scopes, reauth, reason } }。
   * lock.ok=false 时不问账号（account.reason = 'no-lock'）；账号绑定没配 / RPC 出错 / 回了看不懂的东西 → account.ok=false。
   * @param {string} cookieHeader 浏览器发来的 Cookie 头
   * @param {{ua?:string, country?:string, city?:string}} [clientContext]
   * @param {{reauth?:boolean}} [opts] 只有需要账号复验结论的接口才传 reauth: true
   */
  async conclusion(cookieHeader, clientContext, opts) {
    return conclusionFor(await resolveSecrets(this.env), cookieHeader, clientContext, opts);
  }
}
