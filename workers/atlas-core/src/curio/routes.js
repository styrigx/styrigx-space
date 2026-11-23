/**
 * @fileoverview 接口路由表：/api/<路径> → src/api/<路径>.js。
 * src/api/ 新增或删除接口文件时这里要同步，tests/workers/core.test.mjs 会检查两边一致。
 * 下划线开头的文件不是接口（_auth、_lib、_write、_store、_netscape、_preview、_items、_items-post、_photo、_image、_music）。
 * 游戏接口（/games/api/*，奇趣重组 PR 1）的表在 src/games/routes.js，handler 在 src/games/api/，复用这里的 _items.js、_items-post.js、_photo.js。
 * 奇趣重组 PR 3 删掉了 /api/items（设备 + 游戏）、/api/movies、/api/photo（设备照片 / 游戏封面 / 电影海报）：游戏全走 /games/api/*，
 * 设备、电影整块删了；旧地址落在 /curio/api/* 这条 CF 路由上，查不到表 = 表外路径（entry 档 → 账号 Worker 表里也没有这几行 → 一律 401，同第 4 步后的旧 /curio/api/music*）。
 * 音乐的 5 个接口文件（api/music*.js）也在 src/curio/api/ 下，但不挂在这里：挂在 src/music/routes.js（公开地址 /music/api/*；
 * music 搬家第 4 步删掉了旧路径 /curio/api/music*，不留别名）。tests/workers/atlas-core/curio.test.mjs 核对两张表合起来 = api/ 下的接口文件。
 * 同一文件里的 ROUTE_ACCESS 是本 Worker 唯一的访问表（谁能调哪个接口）。
 */
import * as exportApi from './api/export.js';
import * as icon from './api/icon.js';
import * as importApi from './api/import.js';
import * as links from './api/links.js';
import * as preview from './api/preview.js';

/** @type {Map<string, Record<string, Function>>} */
export const API_ROUTES = new Map([
  ['/api/export', exportApi],
  ['/api/icon', icon],
  ['/api/import', importApi],
  ['/api/links', links],
  ['/api/preview', preview],
]);

/**
 * 访问档（v5 S3，一档一个守卫，见 api/_auth.js GUARDS；app.js handle 是唯一套用它们的地方）：
 * - public：谁都能调（publicRead：不拒绝；要私密行 / canManage 的 handler 调公用 visibility()，common/visibility.js）
 * - entry：按账号 Worker 路由表的档问 v6（requireEntry：没有身份 401 unauthorized，档不够 403 forbidden）；写接口在 handler 里另要同源
 * 精确匹配「方法 + 路由表路径」（结尾一个 / 当同一条）；表里没有的方法 / 路径一律 entry（fail closed）。
 * product（组权限 v1.1 §八）：这一行归哪个产品（同账号 Worker 路由表行上的 product）；公用 visibility(context) 从命中的这一行取，
 * 不另传。本表只有 product 'curio' 的行；音乐的行在 src/music/routes.js（product 'music'）。
 * 改这张表 = 改谁能调接口：tests/workers/atlas-core/curio.test.mjs 对整张表做快照。
 * @type {ReadonlyArray<Readonly<{method: string, path: string, access: 'public'|'entry', product: 'curio'}>>}
 */
export const ROUTE_ACCESS = Object.freeze([
  { method: 'GET', path: '/api/links', access: 'public', product: 'curio' },
  { method: 'POST', path: '/api/links', access: 'entry', product: 'curio' },
  { method: 'GET', path: '/api/icon', access: 'public', product: 'curio' },
  { method: 'GET', path: '/api/preview', access: 'entry', product: 'curio' },
  { method: 'GET', path: '/api/export', access: 'entry', product: 'curio' },
  { method: 'POST', path: '/api/import', access: 'entry', product: 'curio' },
].map((r) => Object.freeze(r)));

const ROUTE_KEYS = new Map(ROUTE_ACCESS.map((r) => [r.method + ' ' + r.path, r]));

/**
 * 命中的表行（不在表里 → null）。path = 去掉 /curio 前缀后的路径。
 * @param {string} method @param {string} path
 */
export function routeOf(method, path) {
  const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return ROUTE_KEYS.get(String(method || 'GET').toUpperCase() + ' ' + p) || null;
}

/**
 * 这个请求是哪一档（不在表里 → entry）。path = 去掉 /curio 前缀后的路径。
 * @param {string} method @param {string} path
 * @returns {'public'|'entry'}
 */
export function accessOf(method, path) {
  const r = routeOf(method, path);
  return r ? r.access : 'entry';
}
