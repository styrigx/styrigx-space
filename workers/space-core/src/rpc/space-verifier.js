/**
 * @fileoverview 服务绑定 RPC 入口 SpaceVerifier（进站 v3 Q17 改名）。
 * 只能通过服务绑定调用（其他 Worker 的 wrangler.toml 写 binding = "SPACE"、service = "styrigx-space-core"、
 * entrypoint = "SpaceVerifier"），公网路由进不来。
 * 调用方：styrigx-curio-core、styrigx-daymark-core（workers/curio-core、workers/daymark-core 两个接口 Worker）：
 * - admit() / auditRoot()：v6 会话的放行结论与 root 特权操作留痕，原样转给账号 Worker ACCOUNT_VERIFIER，判断不在这里。
 * - conclusion()（旧进站 / 账号结论）随应用授权删除（定稿 v5.3 §十二）；调用方只走 admit()。
 * v6 P4：session()（进站会话检查）随进站签发删除。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { askAdmit, auditRoot } from '../core/identity-admit.js';

export class SpaceVerifier extends WorkerEntrypoint {
  /**
   * v6 新会话的放行结论（割接）：转给账号 Worker AccountVerifier.admit（路由表 + permits 只在那里）。
   * 回 { allowed, uid, root, rescue, action, … }；没 sgx-session / 绑定没配 / 出错 → { allowed:false }。
   * @param {string} cookieHeader @param {string} method @param {string} pathname 公开地址的路径（/curio/api/… 、/daymark/api/…）
   * @param {{action?: string}} [opts]
   */
  async admit(cookieHeader, method, pathname, opts) {
    const action = opts && typeof opts === 'object' && typeof opts.action === 'string' ? opts.action : undefined;
    const r = await askAdmit(this.env, cookieHeader, method, pathname, action);
    if (!r || typeof r !== 'object') return { allowed: false, reason: 'no-v6', uid: null, root: false, rescue: false, action: action || '' };
    return { allowed: r.allowed === true, reason: String(r.reason || ''), uid: Number.isInteger(r.uid) ? r.uid : null, root: r.root === true,
      rescue: r.rescue === true, action: typeof r.action === 'string' ? r.action : '' };
  }

  /**
   * root 的特权内容操作留痕（割接）：转给账号 Worker AccountVerifier.auditRoot（会话在那边重新判，只认真 root）。
   * @param {string} cookieHeader @param {string} command @param {string} address 客户端 IP
   */
  async auditRoot(cookieHeader, command, address) {
    return auditRoot(this.env, cookieHeader, command, address);
  }
}
