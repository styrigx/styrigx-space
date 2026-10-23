/**
 * @fileoverview 服务绑定 RPC 入口：SessionVerifier。
 *
 * 只能通过服务绑定调用（其他 Worker 的 wrangler.toml 写 service = "styrigx-auth-gateway"、
 * entrypoint = "SessionVerifier"），公网路由进不来。逻辑在 verifier.js（node 单测直接测它）。
 * 调用方：styrigx-daymark-core（daymark 仓库）、styrigx-account（workers/account：头像 / 云同步 / 数字健康）。
 * 应用通行证（appPass / appEpoch）已随应用凭证删除；后台上传等服务操作以后由账号体系管控。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { resolveSecrets } from './secrets.js';
import { checkSession, checkAccount } from './verifier.js';

export class SessionVerifier extends WorkerEntrypoint {
  /** @param {string} cookieHeader */
  async session(cookieHeader) {
    return checkSession(cookieHeader, await resolveSecrets(this.env));
  }

  /**
   * 账号会话（sgx-account）。账号 Worker styrigx-account 的 /api/prefs 用。
   * @param {string} cookieHeader
   * @param {{ua?:string, country?:string, city?:string}} [meta]
   */
  async account(cookieHeader, meta) {
    return checkAccount(cookieHeader, await resolveSecrets(this.env), meta);
  }
}
