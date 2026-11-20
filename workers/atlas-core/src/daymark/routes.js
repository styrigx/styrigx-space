/**
 * @fileoverview 接口路由表：/api/<路径> → src/api/<路径>.js。
 * src/api/ 新增或删除接口文件时这里要同步，tests/workers/core/worker.test.mjs 会检查两边一致。
 * 下划线开头的文件不是接口（_auth、_lib、_quotes、_write）。
 * 同一文件里的 ROUTE_ACCESS 是本 Worker 唯一的访问表（谁能调哪个接口）。
 */
import * as collections from './api/collections.js';
import * as days from './api/days.js';
import * as quotes from './api/quotes.js';
import * as today from './api/today.js';

/** @type {Map<string, Record<string, Function>>} */
export const API_ROUTES = new Map([
  ['/api/collections', collections],
  ['/api/days', days],
  ['/api/quotes', quotes],
  ['/api/today', today],
]);

/**
 * 访问档（v5 S3，一档一个守卫，见 api/_auth.js GUARDS；index.js handle 是唯一套用它们的地方）：
 * - public：谁都能调（publicRead：不拒绝、不问网关；要私密行 / canManage 的 handler 调公用 visibility()，common/visibility.js）
 * - entry：按账号 Worker 路由表的档问 v6（requireEntry：没有身份 401 unauthorized，档不够 403 forbidden）；写在 handler 里另要同源
 * 精确匹配「方法 + 路由表路径」（结尾一个 / 当同一条）；表里没有的方法 / 路径一律 entry（fail closed）。
 * product（组权限 v1.1 §八）：这一行归哪个产品（同账号 Worker 路由表行上的 product）；公用 visibility(context) 从命中的这一行取。
 * 改这张表 = 改谁能调接口：tests/workers/atlas-core/daymark.test.mjs 对整张表做快照。
 * @type {ReadonlyArray<Readonly<{method: string, path: string, access: 'public'|'entry', product: 'daymark'}>>}
 */
export const ROUTE_ACCESS = Object.freeze([
  { method: 'GET', path: '/api/today', access: 'public', product: 'daymark' },
  { method: 'HEAD', path: '/api/today', access: 'public', product: 'daymark' },
  { method: 'OPTIONS', path: '/api/today', access: 'public', product: 'daymark' },
  { method: 'PUT', path: '/api/today', access: 'entry', product: 'daymark' },
  { method: 'GET', path: '/api/quotes', access: 'public', product: 'daymark' },
  { method: 'POST', path: '/api/quotes', access: 'entry', product: 'daymark' },
  { method: 'PUT', path: '/api/quotes', access: 'entry', product: 'daymark' },
  { method: 'DELETE', path: '/api/quotes', access: 'entry', product: 'daymark' },
  { method: 'GET', path: '/api/collections', access: 'public', product: 'daymark' },
  { method: 'POST', path: '/api/collections', access: 'entry', product: 'daymark' },
  { method: 'PUT', path: '/api/collections', access: 'entry', product: 'daymark' },
  { method: 'DELETE', path: '/api/collections', access: 'entry', product: 'daymark' },
  { method: 'GET', path: '/api/days', access: 'public', product: 'daymark' },
].map((r) => Object.freeze(r)));

const ROUTE_KEYS = new Map(ROUTE_ACCESS.map((r) => [r.method + ' ' + r.path, r]));

/**
 * 命中的表行（不在表里 → null）。path = 去掉 /daymark 前缀后的路径。
 * @param {string} method @param {string} path
 */
export function routeOf(method, path) {
  const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return ROUTE_KEYS.get(String(method || 'GET').toUpperCase() + ' ' + p) || null;
}

/**
 * 这个请求是哪一档（不在表里 → entry）。path = 去掉 /daymark 前缀后的路径。
 * @param {string} method @param {string} path
 * @returns {'public'|'entry'}
 */
export function accessOf(method, path) {
  const r = routeOf(method, path);
  return r ? r.access : 'entry';
}
