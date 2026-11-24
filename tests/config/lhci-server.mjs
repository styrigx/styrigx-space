/**
 * Lighthouse CI 的本地服务（tests/config/lighthouserc.json 的 startServerCommand；2026-11-24 报告修复第 7 项，Gray 定）。
 * 代替 `http-server space/web/public -p 8931 -g`：静态文件照旧（有 .gz 且请求接受 gzip 就回 .gz，模拟线上 Cloudflare 压缩），
 * 另外三条接口回假数据，免得静态构建里没有 Worker、音乐 / 游戏页 404 进控制台（errors-in-console）：
 *   GET /api/status            → tests/fixtures/status-summary.cjs normal()
 *   GET /music/api/music       → tests/fixtures/lhci-api.cjs music()
 *   GET /games/api/games       → tests/fixtures/lhci-api.cjs games()
 *   封面 /music/api/music-cover、/games/api/cover → 站内头像 avatar/192.webp（只为不 404）
 * 只在测试里用，不进生产；阈值不因此改动。接口本身的正确性靠单测和 e2e。
 * 用法：node tests/config/lhci-server.mjs [根目录=space/web/public] [端口=8931]
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const require = createRequire(import.meta.url);
const status = require('../fixtures/status-summary.cjs');
const api = require('../fixtures/lhci-api.cjs');

const ROOT = resolve(process.argv[2] || 'space/web/public');
const PORT = Number(process.argv[3] || 8931);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.webmanifest': 'application/manifest+json',
};

const JSON_ROUTES = {
  '/api/status': () => status.normal(),
  '/music/api/music': () => api.music(),
  '/games/api/games': () => api.games(),
};
const IMAGE_ROUTES = ['/music/api/music-cover', '/games/api/cover'];

/** @param {import('node:http').ServerResponse} res */
function json(res, body) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** URL 路径 → 根目录里的文件（目录给 index.html）；越出根目录给 null */
function fileFor(pathname) {
  let p = normalize(join(ROOT, decodeURIComponent(pathname)));
  if (p !== ROOT && !p.startsWith(ROOT + sep)) return null;
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  return existsSync(p) && statSync(p).isFile() ? p : null;
}

/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
function sendFile(req, res, file, code = 200) {
  const headers = { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream' };
  const gz = file + '.gz';
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) && existsSync(gz)) {
    Object.assign(headers, { 'content-encoding': 'gzip', vary: 'Accept-Encoding' });
    res.writeHead(code, headers);
    res.end(req.method === 'HEAD' ? undefined : readFileSync(gz));
    return;
  }
  res.writeHead(code, headers);
  res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url || '/', 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  const route = JSON_ROUTES[pathname];
  if (route) { json(res, route()); return; }
  if (IMAGE_ROUTES.includes(pathname)) { sendFile(req, res, join(ROOT, 'avatar', '192.webp')); return; }
  const file = fileFor(pathname);
  if (file) { sendFile(req, res, file); return; }
  const notFound = join(ROOT, '404.html');
  if (existsSync(notFound)) { sendFile(req, res, notFound, 404); return; }
  res.writeHead(404); res.end();
});

server.listen(PORT, () => {
  /* lighthouserc.json 的 startServerReadyPattern 认这句 */
  console.log(`lhci-server: Available on http://localhost:${PORT} (root ${ROOT})`);
});
