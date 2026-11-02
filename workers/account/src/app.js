/**
 * @fileoverview styrigx-account 的默认 handler（src/index.js 的 default）。
 *
 * 本 Worker 没有任何公开路由（wrangler.toml 无 [[routes]]、workers_dev = false、preview_urls = false），
 * 请求只经网关的服务绑定进命名入口（rpc/account-service.js、rpc/account-verifier.js）。
 * 默认 fetch 一律 404（方案第 3 节第二道保险：即使线上残留公开路由，伪造的头也碰不到任何接口）。
 *
 * 每个响应打 X-SGX-Runtime: account（不含敏感信息）：网关转发时保留，部署后冒烟据此确认路径真的进了本 Worker。
 */
import { apiError } from './lib/http.js';
import { applyMainSiteHeaders } from './lib/security-headers.js';

export const RUNTIME = 'account';

/** @param {Response} res */
export function tagRuntime(res) {
  /* 安全响应头和网关主站同值（本 Worker 自己的 lib/security-headers.js，gen-csp 与网关那份一起生成，单测核对同值）；Referrer-Policy 已设过的不覆盖 */
  const out = applyMainSiteHeaders(res);
  out.headers.set('X-SGX-Runtime', RUNTIME);
  return out;
}

/**
 * 默认 fetch：一律 404（方案第 3 节第二道保险）。本 Worker 只经命名入口 AccountService（网关的服务绑定 ACCOUNT）处理请求；
 * 公网（残留路由、*.workers.dev 等）进来的请求碰不到任何接口，也不读任何 x-styrigx-* 头。
 */
export default {
  /** @param {Request} _request */
  async fetch(_request) {
    return tagRuntime(apiError(404, 'not-found'));
  },
};
