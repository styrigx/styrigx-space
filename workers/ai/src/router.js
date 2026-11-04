/**
 * @fileoverview styrigx-ai 的路由表：只有两个端点（方案 5.2）。没有 /search（搜索只作 /ask 的内部召回，定案第 2 条）。
 *   POST /ask      → api/ask.js
 *   GET  /healthz  → api/healthz.js
 * 别的路径 404 not-found；方法不对 405 method。
 */
import * as ask from './api/ask.js';
import * as healthz from './api/healthz.js';
import { apiError } from './lib/http.js';

/** @type {ReadonlyMap<string, Record<string, Function>>} */
export const ROUTES = new Map([
  ['/ask', { POST: ask.onRequestPost }],
  ['/healthz', { GET: healthz.onRequestGet }],
]);

/** @param {Request} request @param {any} env */
export function route(request, env) {
  const path = new URL(request.url).pathname;
  const r = ROUTES.get(path);
  if (!r) return apiError(404, 'not-found');
  const h = r[request.method];
  if (!h) return apiError(405, 'method');
  return h(request, env);
}
