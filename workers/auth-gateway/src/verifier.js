/**
 * @fileoverview 给其他 Worker 用的验票函数（通过服务绑定 RPC 调用，入口见 rpc.js）。
 *
 * 其他 Worker（如 book 仓库的 styrigx-book-api）不持任何钥匙，把浏览器带来的 Cookie 头原样交给网关，
 * 网关用自己 Secrets Store 里的公钥验签、用 KV 里的 epoch 核对，只回答结论，不回任何密钥或 cookie 内容。
 * 与网关自己验页面、验接口用的是同一套代码（verifySessionDetailed）。
 */
import { verifySessionDetailed } from '../functions/_middleware.js';

const MAX_COOKIE_HEADER = 8192;

function cookieRequest(cookieHeader) {
  const h = typeof cookieHeader === 'string' ? cookieHeader.slice(0, MAX_COOKIE_HEADER) : '';
  return new Request('https://internal.invalid/', { headers: h ? { Cookie: h } : {} });
}

/**
 * 会话：{ ok: true, role: 'owner'|'visitor' } 或 { ok: false, reason }（reason 只是原因代号）。
 * @param {string} cookieHeader 浏览器发来的 Cookie 头
 * @param {Record<string, any>} env 已换好密钥字符串的 env
 */
export async function checkSession(cookieHeader, env) {
  const s = await verifySessionDetailed(cookieRequest(cookieHeader), env);
  return s.ok ? { ok: true, role: s.role } : { ok: false, reason: s.reason };
}
