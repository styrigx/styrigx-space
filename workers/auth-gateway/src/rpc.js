/**
 * @fileoverview 服务绑定 RPC 入口：SessionVerifier。
 *
 * 只能通过服务绑定调用（其他 Worker 的 wrangler.toml 写 service = "styrigx-auth-gateway"、
 * entrypoint = "SessionVerifier"），公网路由进不来。逻辑在 verifier.js（node 单测直接测它）。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { resolveSecrets } from './secrets.js';
import { checkSession, checkAppPass, currentAppEpoch } from './verifier.js';

export class SessionVerifier extends WorkerEntrypoint {
  /** @param {string} cookieHeader */
  async session(cookieHeader) {
    return checkSession(cookieHeader, await resolveSecrets(this.env));
  }

  /** @param {string} cookieHeader @param {string} aud @param {string} scope */
  async appPass(cookieHeader, aud, scope) {
    return checkAppPass(cookieHeader, await resolveSecrets(this.env), aud, scope);
  }

  /** @param {string} aud */
  async appEpoch(aud) {
    return currentAppEpoch(this.env, aud);
  }
}
