/**
 * 页面清单：tests/url-map.json 里博客的每个地址，在 Hugo 构建（web/blog/public/，拼进主站单树的 /blog/ 下）里都在，
 * RSS / 站点地图地址和条目一致，文章里的标题锚点（目录、外链用的 #id）一个不少，没有多出清单外的页面。
 * 网址都在 https://styrigx.com/blog/ 下（canonical、站点地图、RSS；合并 PR2 起 baseURL 从 atlas.styrigx.com 改到主域名）。旧的 blog.styrigx.com 地址和 /about/、/archives/ 跳转页都删了，不留兼容。
 * 跑法：npm run build 之后 node --test tests/urls.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUB = path.join(ROOT, 'web/blog/public');
const map = JSON.parse(readFileSync(path.join(ROOT, 'tests/blog/url-map.json'), 'utf8'));
const SITE = 'https://styrigx.com/blog';

const fileFor = (url) => path.join(PUB, url.endsWith('/') ? url + 'index.html' : url);
const read = (url) => readFileSync(fileFor(url), 'utf8');
const isAlias = (html) => /http-equiv="refresh"/.test(html);

test('构建产物存在', () => {
  assert.ok(existsSync(PUB), 'web/blog/public/ 不存在：先跑 npm run build');
});

test('留言板撤了（2026-10-24）：/guestbook/、/en/guestbook/ 不再构建，旧地址走 404', () => {
  for (const url of ['/guestbook/', '/en/guestbook/']) assert.equal(existsSync(fileFor(url)), false, url + ' 还在');
});

test('清单里每个页面都在（不是跳转页）', () => {
  const missing = [];
  for (const url of map.pages) {
    if (!existsSync(fileFor(url))) missing.push(url);
    else if (isAlias(read(url))) missing.push(url + '（变成了跳转页）');
  }
  assert.deepEqual(missing, [], '缺少：' + missing.join(', '));
});

test('没有跳转页（旧的 /about/、/archives/ 删了，不留兼容）', () => {
  for (const url of ['/about/', '/archives/', '/en/about/', '/en/archives/']) assert.equal(existsSync(fileFor(url)), false, url + ' 还在');
});

test('RSS 和站点地图都在', () => {
  for (const f of map.feeds) assert.ok(existsSync(fileFor(f)), f + ' 不存在');
  assert.match(read('/sitemap-index.xml'), /<loc>https:\/\/styrigx\.com\/blog\/sitemap-0\.xml<\/loc>/);
});

test('站点地图条目和清单一致', () => {
  const now = [...read('/sitemap-0.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decodeURI(m[1])).sort();
  const old = map.sitemap.map((u) => decodeURI(u)).sort();
  assert.deepEqual(now, old);
});

test('RSS 条目（顺序、链接）和清单一致', () => {
  for (const [feed, links] of Object.entries(map.rss)) {
    const xml = read(feed);
    const now = [...xml.matchAll(/<item><title>[\s\S]*?<\/title><link>([^<]+)<\/link>/g)].map((m) => m[1]);
    assert.deepEqual(now, links, feed);
    assert.match(xml, /<content:encoded>/, feed + ' 应是全文');
    assert.match(xml, /<pubDate>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} 00:00:00 GMT<\/pubDate>/, feed);
  }
});

test('文章标题锚点一个不少（目录、外部链接里的 #id）', () => {
  const lost = [];
  for (const [url, ids] of Object.entries(map.anchors)) {
    const html = read(url);
    const now = new Set([...html.matchAll(/<h[2-6][^>]* id="([^"]+)"/g)].map((m) => m[1]));
    for (const id of ids) if (!now.has(id)) lost.push(url + '#' + id);
  }
  assert.deepEqual(lost, []);
});

test('canonical 在 styrigx.com/blog/ 下', () => {
  for (const url of map.pages.filter((u) => u.endsWith('/'))) {
    assert.match(read(url), new RegExp(`<link rel="canonical" href="${(SITE + encodeURI(url)).replace(/[/.]/g, '\\$&')}"`), url);
  }
});

test('没有多出清单外的页面（除了英文 404）', () => {
  const now = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const full = path.join(d, f);
      if (statSync(full).isDirectory()) walk(full);
      else if (f.endsWith('.html')) now.push('/' + path.relative(PUB, full).split(path.sep).join('/').replace(/index\.html$/, ''));
    }
  };
  walk(PUB);
  const known = new Set([...map.pages, '/en/404.html']);
  assert.deepEqual(now.filter((p) => !known.has(p)).sort(), []);
});
