/**
 * @fileoverview 服务绑定 RPC 入口 AuthVerifier（lockSession()）。ShareIssuer 在 rpc/share-issuer.js。
 * 账号拆分 PR3：AuthVerifier 去掉 accountSession()（方案 10.3）——账号会话由账号 Worker 的 AccountVerifier 回答。
 *
 * 只能通过服务绑定调用（其他 Worker 的 wrangler.toml 写 service = "styrigx-auth-gateway"、
 * entrypoint = "AuthVerifier"），公网路由进不来。逻辑在 core/lock-session.js checkLockSession（node 单测直接测它）。
 * 调用方：styrigx-daymark-core、styrigx-curio-core（styrigx-atlas 仓库的两个接口 Worker）、styrigx-share（workers/share，只用 lockSession）。
 * 应用通行证（appPass / appEpoch）已随应用凭证删除；后台上传等服务操作以后由账号体系管控。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { resolveSecrets } from '../secrets.js';
import { checkLockSession } from '../core/lock-session.js';

export class AuthVerifier extends WorkerEntrypoint {
  /**
   * 锁屏会话：{ ok, role } / { ok:false, reason }。子站接口 Worker、短链 Worker 用。
   * @param {string} cookieHeader
   */
  async lockSession(cookieHeader) {
    return checkLockSession(cookieHeader, await resolveSecrets(this.env));
  }
}
