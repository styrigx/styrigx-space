/**
 * @fileoverview 管理凭证弹层按钮决策（纯函数，无 DOM 依赖，可单元测试）。
 *
 * 与 GET /api/owner-status 返回的 {password, passkey} 语义一一对应
 * （站长层：owner-pw 是否设置、class=owner 通行密钥是否存在）：
 * - 都没设置 → 只显示「根凭证」
 * - 仅通行密钥 → 「通行密钥验证」
 * - 仅密码 → 「密码验证」
 * - 两个都设了 → 两个都显示，不显示根凭证
 *
 * 调用方：assets/js/apps/security.js「管理凭证」入口，每次打开弹层时读
 * /api/owner-status 后把 (j.password, j.passkey) 传入本函数。
 * 注意：不要与 /api/lock-status 混用（那是锁屏层 lock-pw + class=lock，
 * 口径不同）；分工总表见 functions/api/STATUS-APIS.md。
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
