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
 * - public：谁都能调（publicRead：不拒绝、不问网关；要私密行 / canWrite 的 handler 自己 readAccess）
 * - entry：按账号 Worker 路由表的档问 v6（requireEntry：没有身份 401 unauthorized，档不够 403 forbidden）；写在 handler 里另要同源
 * 精确匹配「方法 + 路由表路径」（结尾一个 / 当同一条）；表里没有的方法 / 路径一律 entry（fail closed）。
 * 改这张表 = 改谁能调接口：tests/workers/daymark-core/core.test.mjs 对整张表做快照。
 * @type {ReadonlyArray<Readonly<{method: string, path: string, access: 'public'|'entry'}>>}
 */
export const ROUTE_ACCESS = Object.freeze([
  { method: 'GET', path: '/api/today', access: 'public' },
  { method: 'HEAD', path: '/api/today', access: 'public' },
  { method: 'OPTIONS', path: '/api/today', access: 'public' },
  { method: 'PUT', path: '/api/today', access: 'entry' },
  { method: 'GET', path: '/api/quotes', access: 'public' },
  { method: 'POST', path: '/api/quotes', access: 'entry' },
  { method: 'PUT', path: '/api/quotes', access: 'entry' },
  { method: 'DELETE', path: '/api/quotes', access: 'entry' },
  { method: 'GET', path: '/api/collections', access: 'public' },
  { method: 'POST', path: '/api/collections', access: 'entry' },
  { method: 'PUT', path: '/api/collections', access: 'entry' },
  { method: 'DELETE', path: '/api/collections', access: 'entry' },
  { method: 'GET', path: '/api/days', access: 'public' },
].map((r) => Object.freeze(r)));

const ACCESS_KEYS = new Map(ROUTE_ACCESS.map((r) => [r.method + ' ' + r.path, r.access]));

/**
 * 这个请求是哪一档（不在表里 → entry）。path = 去掉 /daymark 前缀后的路径。
 * @param {string} method @param {string} path
 * @returns {'public'|'entry'}
 */
export function accessOf(method, path) {
  const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return ACCESS_KEYS.get(String(method || 'GET').toUpperCase() + ' ' + p) || 'entry';
}
