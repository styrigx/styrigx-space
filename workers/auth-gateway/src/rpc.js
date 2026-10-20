/**
 * @fileoverview 服务绑定 RPC 入口：SessionVerifier。
 *
 * 只能通过服务绑定调用（其他 Worker 的 wrangler.toml 写 service = "styrigx-auth-gateway"、
 * entrypoint = "SessionVerifier"），公网路由进不来。逻辑在 verifier.js（node 单测直接测它）。
 * 应用通行证（appPass / appEpoch）已随应用凭证删除；后台上传等服务操作以后由账号体系管控。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { resolveSecrets } from './secrets.js';
import { checkSession } from './verifier.js';

export class SessionVerifier extends WorkerEntrypoint {
  /** @param {string} cookieHeader */
  async session(cookieHeader) {
    return checkSession(cookieHeader, await resolveSecrets(this.env));
  }
}
