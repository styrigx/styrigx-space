/**
 * @fileoverview 游戏的接口路由表（公开地址 styrigx.com/games/api/*；奇趣重组设计稿 v1.0 第三节 PR 1，照 music 搬家第 2 步的做法）：
 * /api/<路径> → src/games/api/<路径>.js。handler 只是薄壳：数据层、写操作、照片规则复用 src/curio/api/（_items.js、_items-post.js、_photo.js），
 * 和奇趣「游戏」栏同一张表、同一份 R2 封面。由 src/curio/app.js 按前缀 /games 选用本表。
 * PR 1 只加不改：旧 /curio/api/items、/curio/api/photo 照常（PR 3 才删）。
 * 同一文件里的 ROUTE_ACCESS 是游戏接口在本 Worker 的访问表（谁能调哪个接口；组名在账号 Worker 路由表按 product 推：games-use / games-manage）。
 */
import * as games from './api/games.js';
import * as cover from './api/cover.js';

/** @type {Map<string, Record<string, Function>>} */
export const API_ROUTES = new Map([
  ['/api/games', games],
  ['/api/cover', cover],
]);

/**
 * 访问档（同 src/curio/routes.js：一档一个守卫，见 curio/api/_auth.js GUARDS）：
 * 列表 / 封面公开（私密行与私密封面按 visibility / privateNotFound 问 games-use）；写 = entry（按账号 Worker 路由表的档：games-manage）。
 * 精确匹配「方法 + 路由表路径」（结尾一个 / 当同一条）；表里没有的方法 / 路径一律 entry（fail closed）。
 * product 都是 'games'（同账号 Worker 路由表 /games/api/* 行上的 product）；公用 visibility(context) 从命中的这一行取。
 * 改这张表 = 改谁能调接口：tests/workers/atlas-core/games.test.mjs 对整张表做快照。
 * @type {ReadonlyArray<Readonly<{method: string, path: string, access: 'public'|'entry', product: 'games'}>>}
 */
export const ROUTE_ACCESS = Object.freeze([
  { method: 'GET', path: '/api/games', access: 'public', product: 'games' },
  { method: 'POST', path: '/api/games', access: 'entry', product: 'games' },
  { method: 'GET', path: '/api/cover', access: 'public', product: 'games' },
  { method: 'POST', path: '/api/cover', access: 'entry', product: 'games' },
  { method: 'DELETE', path: '/api/cover', access: 'entry', product: 'games' },
].map((r) => Object.freeze(r)));

const ROUTE_KEYS = new Map(ROUTE_ACCESS.map((r) => [r.method + ' ' + r.path, r]));

/**
 * 命中的表行（不在表里 → null）。path = 去掉 /games 前缀后的路径。
 * @param {string} method @param {string} path
 */
export function routeOf(method, path) {
  const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return ROUTE_KEYS.get(String(method || 'GET').toUpperCase() + ' ' + p) || null;
}

/**
 * 这个请求是哪一档（不在表里 → entry）。path = 去掉 /games 前缀后的路径。
 * @param {string} method @param {string} path
 * @returns {'public'|'entry'}
 */
export function accessOf(method, path) {
  const r = routeOf(method, path);
  return r ? r.access : 'entry';
}
