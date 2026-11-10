/**
 * @fileoverview 接口路由表：/api/<路径> → src/api/<路径>.js。
 * src/api/ 新增或删除接口文件时这里要同步，tests/workers/core.test.mjs 会检查两边一致。
 * 下划线开头的文件不是接口（_auth、_lib、_write、_store、_netscape、_preview、_items、_image、_movies、_music）。
 * 同一文件里的 ROUTE_ACCESS 是本 Worker 唯一的访问表（谁能调哪个接口）。
 */
import * as exportApi from './api/export.js';
import * as icon from './api/icon.js';
import * as importApi from './api/import.js';
import * as items from './api/items.js';
import * as links from './api/links.js';
import * as movies from './api/movies.js';
import * as music from './api/music.js';
import * as musicCover from './api/music-cover.js';
import * as musicPlay from './api/music-play.js';
import * as musicStream from './api/music-stream.js';
import * as musicUpload from './api/music-upload.js';
import * as photo from './api/photo.js';
import * as preview from './api/preview.js';

/** @type {Map<string, Record<string, Function>>} */
export const API_ROUTES = new Map([
  ['/api/export', exportApi],
  ['/api/icon', icon],
  ['/api/import', importApi],
  ['/api/items', items],
  ['/api/links', links],
  ['/api/movies', movies],
  ['/api/music', music],
  ['/api/music-cover', musicCover],
  ['/api/music-play', musicPlay],
  ['/api/music-stream', musicStream],
  ['/api/music-upload', musicUpload],
  ['/api/photo', photo],
  ['/api/preview', preview],
]);

/**
 * 访问档（v5 S3，一档一个守卫，见 api/_auth.js GUARDS；app.js handle 是唯一套用它们的地方）：
 * - public：谁都能调（publicRead：照样问一次网关结论，只用来决定给不给私密行 / canWrite，从不拒绝）
 * - entry：要进站会话（requireEntry：password / passkey / link 任一种进门；没进门 401 unauthorized）；写接口在 handler 里另要账号 + 作用域 + 同源
 * - music：要进站 + 账号会话 + curio.write（requireMusic：音乐的上传 / 管理，与其他写接口同一套作用域）
 * 精确匹配「方法 + 路由表路径」（结尾一个 / 当同一条）；表里没有的方法 / 路径一律 entry（fail closed）。
 * 改这张表 = 改谁能调接口：tests/workers/curio-core/core.test.mjs 对整张表做快照。
 * @type {ReadonlyArray<Readonly<{method: string, path: string, access: 'public'|'entry'|'music'}>>}
 */
export const ROUTE_ACCESS = Object.freeze([
  { method: 'GET', path: '/api/items', access: 'public' },
  { method: 'POST', path: '/api/items', access: 'entry' },
  { method: 'GET', path: '/api/links', access: 'public' },
  { method: 'POST', path: '/api/links', access: 'entry' },
  { method: 'GET', path: '/api/movies', access: 'public' },
  { method: 'POST', path: '/api/movies', access: 'entry' },
  { method: 'GET', path: '/api/photo', access: 'public' },
  { method: 'POST', path: '/api/photo', access: 'entry' },
  { method: 'DELETE', path: '/api/photo', access: 'entry' },
  { method: 'GET', path: '/api/icon', access: 'public' },
  { method: 'GET', path: '/api/preview', access: 'entry' },
  { method: 'GET', path: '/api/export', access: 'entry' },
  { method: 'POST', path: '/api/import', access: 'entry' },
  /* 音乐三层：歌单 / 封面公开（不含任何音频地址）；听 = 进站（签播放令牌、取音频）；上传 / 管理 = 账号 + curio.write */
  { method: 'GET', path: '/api/music', access: 'public' },
  { method: 'POST', path: '/api/music', access: 'music' },
  { method: 'GET', path: '/api/music-cover', access: 'public' },
  { method: 'POST', path: '/api/music-play', access: 'entry' },
  { method: 'GET', path: '/api/music-stream', access: 'entry' },
  { method: 'HEAD', path: '/api/music-stream', access: 'entry' },
  { method: 'POST', path: '/api/music-upload', access: 'music' },
].map((r) => Object.freeze(r)));

const ACCESS_KEYS = new Map(ROUTE_ACCESS.map((r) => [r.method + ' ' + r.path, r.access]));

/**
 * 这个请求是哪一档（不在表里 → entry）。path = 去掉 /curio 前缀后的路径。
 * @param {string} method @param {string} path
 * @returns {'public'|'entry'|'music'}
 */
export function accessOf(method, path) {
  const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return ACCESS_KEYS.get(String(method || 'GET').toUpperCase() + ' ' + p) || 'entry';
}
