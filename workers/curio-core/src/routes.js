/**
 * @fileoverview 接口路由表：/api/<路径> → src/api/<路径>.js。
 * src/api/ 新增或删除接口文件时这里要同步，tests/workers/core.test.mjs 会检查两边一致。
 * 下划线开头的文件不是接口（_auth、_lib、_write、_store、_netscape、_preview、_items、_image、_movies、_music）。
 */
import * as access from './api/access.js';
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
  ['/api/access', access],
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
