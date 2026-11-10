/**
 * @fileoverview styrigx-ai 的路由表（方案 5.2；P4-2 加 /models；v5 S4 加 /find）。没有 /search（P4-2 退役的旧名不复用）。
 *   POST /ask      → api/ask.js
 *   GET  /find     → api/find.js（关键词搜索，不调模型、只回公开条目；网关 GET /api/find 转进来）
 *   GET  /models   → api/models.js（可选模型列表，账号页用）
 *   GET  /healthz  → api/healthz.js
 * 别的路径 404 not-found；方法不对 405 method。
 */
import * as ask from './api/ask.js';
import * as find from './api/find.js';
import * as healthz from './api/healthz.js';
import * as models from './api/models.js';
import { apiError } from './lib/http.js';

/** @type {ReadonlyMap<string, Record<string, Function>>} */
export const ROUTES = new Map([
  ['/ask', { POST: ask.onRequestPost }],
  ['/find', { GET: find.onRequestGet }],
  ['/models', { GET: models.onRequestGet }],
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
