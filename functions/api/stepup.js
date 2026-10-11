/**
 * Stepup 二次验证（2.8.0 后）。
 *
 * POST /api/stepup
 * - 需要已有的 owner 会话（sgx-verified cookie，role=owner）
 * - Body: { credential }（passkey 断言，只能通行密钥，密码不允许）
 * - 验证通过：签发 sgx-stepup cookie
 *   - Ed25519 签名，含 owner、epoch、签发时间
 *   - 10 分钟有效
 *   - Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Strict
 * - epoch+1 使 stepup 失效（cookie 中的 epoch 与当前 epoch 比对）
 *
 * 只接受 POST；校验 Origin。
 */
import {
  signStepupCookie,
  setStepupCookie,
  getSessionEpoch,
  ROLE_OWNER,
} from '../_kernel/session.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  /* 只接受 POST */
  if (request.method !== 'POST') {
    return Response.json({ ok: false, error: 'method' }, { status: 405 });
  }

  /* 校验 Origin（防 CSRF） */
  try {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    if (origin && new URL(origin).host !== url.host) {
      return Response.json({ ok: false, error: 'origin' }, { status: 403 });
    }
  } catch (e) {}

  /* 必须已有 owner 会话 */
  // TODO: 验证 sgx-verified cookie 的 role=owner
  // TODO: 验证 passkey credential（只能通行密钥，密码不允许）
  // TODO: 签发 sgx-stepup cookie

  return Response.json({ ok: false, error: 'not-implemented' }, { status: 501 });
}
