/**
 * @fileoverview 服务绑定 RPC 入口：AuthVerifier（lockSession()）、ShareIssuer。
 * 账号拆分 PR3：AuthVerifier 去掉 accountSession()（方案 10.3）——账号会话由账号 Worker 的 AccountVerifier 回答。
 *
 * 只能通过服务绑定调用（其他 Worker 的 wrangler.toml 写 service = "styrigx-auth-gateway"、
 * entrypoint = "AuthVerifier"），公网路由进不来。逻辑在 verifier.js（node 单测直接测它）。
 * 调用方：styrigx-daymark-core（daymark 仓库）、styrigx-curio-core（curio 仓库）、styrigx-share（workers/share，只用 lockSession）。
 * ShareIssuer（2026-10-24）：分享短链 Worker styrigx-share（workers/share）专用的单独入口——签 / 作废短链钥匙、点开时换访客会话。
 *   逻辑在 share-issuer.js；只有 styrigx-share 的 wrangler.toml 绑定它（entrypoint = "ShareIssuer"），拿 AuthVerifier 的 Worker 调不到。
 * 应用通行证（appPass / appEpoch）已随应用凭证删除；后台上传等服务操作以后由账号体系管控。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { resolveSecrets } from './secrets.js';
import { checkLockSession } from './verifier.js';
import { createLinkKey, revokeLinkKey, openLinkSession } from './share-issuer.js';

export class AuthVerifier extends WorkerEntrypoint {
  /**
   * 锁屏会话：{ ok, role } / { ok:false, reason }。子站接口 Worker、短链 Worker 用。
   * @param {string} cookieHeader
   */
  async lockSession(cookieHeader) {
    return checkLockSession(cookieHeader, await resolveSecrets(this.env));
  }
}

export class ShareIssuer extends WorkerEntrypoint {
  /**
   * 签一把短链钥匙（要管理员 + 账号会话）。
   * @param {string} cookieHeader
   * @param {{hours?:number, days?:number, name?:string, meta?:any}} p
   */
  async createLinkKey(cookieHeader, p) {
    return createLinkKey(cookieHeader, p, await resolveSecrets(this.env));
  }

  /**
   * 作废短链钥匙（要管理员 + 账号会话）。
   * @param {string} cookieHeader
   * @param {string} id
   * @param {any} [meta]
   */
  async revokeLinkKey(cookieHeader, id, meta) {
    return revokeLinkKey(cookieHeader, id, await resolveSecrets(this.env), meta);
  }

  /**
   * 访客点开带会话的短链：签 visitor 会话 + 钥匙票，只回 Set-Cookie 值。
   * @param {string} id
   * @param {number} sessionSec
   */
  async openLinkSession(id, sessionSec) {
    return openLinkSession(id, sessionSec, await resolveSecrets(this.env));
  }
}
