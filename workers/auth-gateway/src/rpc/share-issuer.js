/**
 * @fileoverview 服务绑定 RPC 入口 ShareIssuer（2026-10-24）：分享短链 Worker styrigx-share（workers/share）专用的单独入口——
 * 签 / 作废短链钥匙、点开时换进站会话。逻辑在 core/link-keys.js（node 单测直接测它）。
 * 只有 styrigx-share 的 wrangler.toml 绑定它（entrypoint = "ShareIssuer"），拿 AuthVerifier 的 Worker 调不到；公网路由进不来。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { resolveSecrets } from '../secrets.js';
import { createLinkKey, revokeLinkKey, openLinkSession, checkLinkReauth } from '../core/link-keys.js';

export class ShareIssuer extends WorkerEntrypoint {
  /**
   * 签一把短链钥匙（要进门，不要 reauth：进站 v3 Q3 定稿；没进门 → { ok:false, error:'session' }）。
   * @param {string} cookieHeader
   * @param {{hours?:number, days?:number, name?:string}} p
   */
  async createLinkKey(cookieHeader, p) {
    return createLinkKey(cookieHeader, p, await resolveSecrets(this.env));
  }

  /**
   * 作废短链钥匙（要进门 + 锁侧复验）。
   * @param {string} cookieHeader
   * @param {string} id
   */
  async revokeLinkKey(cookieHeader, id) {
    return revokeLinkKey(cookieHeader, id, await resolveSecrets(this.env));
  }

  /**
   * 只判断「进门 + 锁侧复验」（分享链接管理：list / revoke 前用）：{ ok } / { ok:false, error:'session'|'reauth'|'config' }。
   * @param {string} cookieHeader
   */
  async checkReauth(cookieHeader) {
    return checkLinkReauth(cookieHeader, await resolveSecrets(this.env));
  }

  /**
   * 点开带会话的短链：签进站会话（by=tempkey），只回 Set-Cookie 值。
   * @param {string} id
   * @param {number} sessionSec
   */
  async openLinkSession(id, sessionSec) {
    return openLinkSession(id, sessionSec, await resolveSecrets(this.env));
  }
}
