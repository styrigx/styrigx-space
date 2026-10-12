/**
 * @fileoverview 管理凭证弹层按钮决策（纯函数，无 DOM 依赖，可单元测试）。
 *
 * 与 /api/owner-status 返回的 {password, passkey} 对应：
 * - 都没设置 → 只显示「根凭证」
 * - 仅通行密钥 → 「通行密钥验证」
 * - 仅密码 → 「密码验证」
 * - 两个都设了 → 两个都显示，不显示根凭证
 */

/**
 * @param {boolean} hasPw - 站长密码已设置
 * @param {boolean} hasPk - class=owner 通行密钥已设置
 * @returns {string[]} 按钮标识数组：'root' | 'passkey' | 'password'
 */
export function mgmtButtons(hasPw, hasPk) {
  if (!hasPw && !hasPk) return ['root'];
  const out = [];
  if (hasPk) out.push('passkey');
  if (hasPw) out.push('password');
  return out;
}
