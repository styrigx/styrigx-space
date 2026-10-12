/**
 * 2.10.1：密钥对自检（只读诊断）。
 *
 * 背景：怀疑 STEPUP 密钥对不匹配导致「签发成功、验签失败」的循环。
 *
 * GET /api/diag-keys
 * - 仅 owner 会话可访问（未登录 → 401）
 * - 对 STEPUP、LOCK、APP 三对密钥：各自用私钥签一段随机串、用公钥验签
 * - 只返回 { stepup: true/false/"missing", lock: ..., app: ... }
 *   - "missing"：私钥或公钥缺失
 *   - true：配对（签名验签通过）
 *   - false：不匹配（签名验签失败）
 * - 不返回、不记录任何密钥内容或签名值
 *
 * 只接受 GET；不改 Cloudflare 配置。
 */
import { verifySessionDetailed } from '../_middleware.js';
import { ROLE_OWNER } from '../_kernel/session.js';
import { ed25519Sign, ed25519Verify, b64urlEnc } from '../_kernel/crypto.js';

/**
 * 自检一对密钥：私钥签名 → 公钥验签。
 * @param {string} privPem 私钥（PKCS8 PEM）
 * @param {string} pubPem 公钥（SPKI PEM）
 * @returns {Promise<boolean>} 配对返回 true
 */
async function checkPair(privPem, pubPem) {
  // 随机串（不记录、不返回）
  const rand = new Uint8Array(32);
  crypto.getRandomValues(rand);
  const payload = 'diag:' + b64urlEnc(rand);
  const sig = await ed25519Sign(privPem, payload);
  return await ed25519Verify(pubPem, payload, sig);
}

/** @param {any} context */
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') {
    return Response.json({ ok: false, error: 'method' }, { status: 405 });
  }
  // 仅 owner 会话
  let sess;
  try {
    sess = await verifySessionDetailed(request, env);
  } catch (e) {
    return Response.json({ ok: false, error: 'server' }, { status: 500 });
  }
  if (!sess.ok || sess.role !== ROLE_OWNER) {
    return Response.json({ ok: false, error: 'auth' }, { status: 401 });
  }

  const pairs = [
    ['stepup', env && env.SGX_STEPUP_PRIVATE, env && env.SGX_STEPUP_PUBLIC],
    ['lock', env && env.SGX_LOCK_PRIVATE, env && env.SGX_LOCK_PUBLIC],
    ['app', env && env.SGX_APP_PRIVATE, env && env.SGX_APP_PUBLIC],
  ];
  const out = {};
  for (const [name, priv, pub] of pairs) {
    if (!priv || !pub) {
      out[name] = 'missing';
      continue;
    }
    try {
      out[name] = await checkPair(priv, pub);
    } catch (e) {
      // 签名/验签抛错 → 视为不匹配（不泄露原因细节）
      out[name] = false;
    }
  }
  return Response.json(out, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
