/**
 * @fileoverview 服务绑定 RPC 入口 SpaceVerifier（进站 v3 Q17 改名）。
 * 只能通过服务绑定调用（其他 Worker 的 wrangler.toml 写 binding = "SPACE"、service = "styrigx-space-core"、
 * entrypoint = "SpaceVerifier"），公网路由进不来。
 * 调用方：styrigx-curio-core、styrigx-daymark-core（workers/curio-core、workers/daymark-core 两个接口 Worker）：
 * - admit() / auditRoot()：v6 会话的放行结论与 root 特权操作留痕，原样转给账号 Worker ACCOUNT_VERIFIER，判断不在这里。
 * - conclusion()：v6 P4（定稿 v5.2 §十三）起进站会话删除，一律回 denied（core/conclusion.js conclusionFor）；
 *   调用方的旧路径因此不成立、走 admit()。方法留着：调用方的代码不在本 PR 改（RPC 签名不变）。
 * v6 P4：session()（进站会话检查）随进站签发删除。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { conclusionFor } from '../core/conclusion.js';
import { askAdmit, auditRoot } from '../core/identity-admit.js';

export class SpaceVerifier extends WorkerEntrypoint {
  /**
   * 结论：v6 P4 起一律 { space: { ok:false, reason:'no-session' }, account: { ok:false, reason:'no-space' } }（denied）。
   * 参数留着（RPC 签名不变），不读。
   */
  async conclusion() {
    return conclusionFor();
  }

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
