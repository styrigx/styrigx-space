#!/usr/bin/env node
/**
 * 本地 / CI 用的静态服务器，模拟 Cloudflare Pages 回静态文件的方式：目录回 index.html，不存在的路径回最近一级的 404.html（状态 404）。
 * 用法：node scripts/serve-static.mjs [目录=web/blog/public] [端口=4321]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || 'web/blog/public');
const port = Number(process.argv[3] || 4321);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.xml': 'application/xml; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.webp': 'image/webp',
};
const inside = (p) => p === dir || p.startsWith(dir + path.sep);

http
  .createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = path.join(dir, rel);
    if (!inside(file)) return res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
    }
    for (let d = path.dirname(path.join(dir, rel)); inside(d); d = path.dirname(d)) {
      const nf = path.join(d, '404.html');
      if (fs.existsSync(nf)) {
        res.writeHead(404, { 'content-type': TYPES['.html'] });
        return res.end(fs.readFileSync(nf));
      }
    }
    res.writeHead(404).end('not found');
  })
  .listen(port, () => console.log(`serving ${dir} on http://localhost:${port}`));
