/**
 * @fileoverview 音乐的接口路由表（公开地址 styrigx.com/music/api/*；music 搬家设计稿 v1.1）：/api/<路径> → src/music/api/<路径>.js。
 * 接口文件在 src/music/api/ 下（2026-11-23 从 src/curio/api/ 挪来，只换位置不改逻辑）；由 src/curio/app.js 按前缀 /music 选用本表。
 * 搬家第 2 步起 /music/api/* 与旧 /curio/api/music* 两边都挂；第 4 步删掉旧路径（不留别名），音乐只剩本表。
 * 同一文件里的 ROUTE_ACCESS 是音乐接口在本 Worker 的访问表（谁能调哪个接口；组名在账号 Worker 路由表按 product 推）。
 */
import * as music from './api/music.js';
import * as musicCover from './api/music-cover.js';
import * as musicPlay from './api/music-play.js';
import * as musicStream from './api/music-stream.js';
import * as musicUpload from './api/music-upload.js';

/** @type {Map<string, Record<string, Function>>} */
export const API_ROUTES = new Map([
  ['/api/music', music],
  ['/api/music-cover', musicCover],
  ['/api/music-play', musicPlay],
  ['/api/music-stream', musicStream],
  ['/api/music-upload', musicUpload],
]);

/**
 * 访问档（同 src/curio/routes.js：一档一个守卫，见 curio/api/_auth.js GUARDS）：
 * 歌单 / 封面公开（不含任何音频地址）；听 = entry（music-use：签播放令牌、取音频）；上传 / 管理 = music（music-manage）。
 * 精确匹配「方法 + 路由表路径」（结尾一个 / 当同一条）；表里没有的方法 / 路径一律 entry（fail closed）。
 * product 都是 'music'（同账号 Worker 路由表 /music/api/* 行上的 product）；公用 visibility(context) 从命中的这一行取。
 * 改这张表 = 改谁能调接口：tests/workers/atlas-core/curio.test.mjs 对整张表做快照。
 * @type {ReadonlyArray<Readonly<{method: string, path: string, access: 'public'|'entry'|'music', product: 'music'}>>}
 */
export const ROUTE_ACCESS = Object.freeze([
  { method: 'GET', path: '/api/music', access: 'public', product: 'music' },
  { method: 'POST', path: '/api/music', access: 'music', product: 'music' },
  { method: 'GET', path: '/api/music-cover', access: 'public', product: 'music' },
  { method: 'POST', path: '/api/music-play', access: 'entry', product: 'music' },
  { method: 'GET', path: '/api/music-stream', access: 'entry', product: 'music' },
  { method: 'HEAD', path: '/api/music-stream', access: 'entry', product: 'music' },
  { method: 'POST', path: '/api/music-upload', access: 'music', product: 'music' },
].map((r) => Object.freeze(r)));

const ROUTE_KEYS = new Map(ROUTE_ACCESS.map((r) => [r.method + ' ' + r.path, r]));

/**
 * 命中的表行（不在表里 → null）。path = 去掉 /music 前缀后的路径。
 * @param {string} method @param {string} path
 */
export function routeOf(method, path) {
  const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return ROUTE_KEYS.get(String(method || 'GET').toUpperCase() + ' ' + p) || null;
}

/**
 * 这个请求是哪一档（不在表里 → entry）。path = 去掉 /music 前缀后的路径。
 * @param {string} method @param {string} path
 * @returns {'public'|'entry'|'music'}
 */
export function accessOf(method, path) {
  const r = routeOf(method, path);
  return r ? r.access : 'entry';
}
