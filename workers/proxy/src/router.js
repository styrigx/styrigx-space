/**
 * 路径 → handler 的登记表和分发。
 *
 * 顺序（和搬家前的单文件版一致，不能换）：
 *   1. `/`、`/healthz` 任意方法 → 200（styrigx-status 每分钟测 /healthz）
 *   2. 非 GET / HEAD → 405
 *   3. 订阅下载 /s/<令牌>/<来源名> → api/sub.js（代理订阅，设计稿 v1.7）
 *   4. 规则集路径（core/sources.js 里登记的来源白名单）→ api/rules.js
 *   5. 其他 → 404
 *
 * 公网没有任何管理 / 刷新路径：管理只经服务绑定调命名入口 ProxyAdmin（rpc/proxy-admin.js），刷新还有 scheduled。
 * 加新接口：在 api/ 加一个文件、在这里登记；业务放 core/，通用件放 lib/。不要往 rules 的白名单里塞。
 */
import { healthz } from './api/healthz.js';
import { rules } from './api/rules.js';
import { sub } from './api/sub.js';
import { matchSource } from './core/sources.js';
import { text } from './lib/http.js';

/** 精确路径 → handler（不看方法） */
export const ROUTES = new Map([
  ['/', healthz],
  ['/healthz', healthz],
]);

/**
 * @param {Request} request
 * @param {unknown} env
 * @param {{ waitUntil(p: Promise<unknown>): void }} ctx
 */
export async function route(request, env, ctx) {
  const url = new URL(request.url);

  const exact = ROUTES.get(url.pathname);
  if (exact) return exact(request, env, ctx);

  if (request.method !== 'GET' && request.method !== 'HEAD') return text('Method Not Allowed', 405, { allow: 'GET, HEAD' });

  if (url.pathname.startsWith('/s/')) return sub(request, env, url);

  const match = matchSource(url.pathname);
  if (match) return rules(request, ctx, url, match);

  return text('Not Found', 404);
}
