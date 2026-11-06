import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMainStaticPassthrough } from '../../../workers/auth-gateway/src/app.js';

const u = (p, h = 'styrigx.com') => new URL(`https://${h}${p}`);

test('根目录公开文件原样回源（整站路由后 robots.txt 不能带 worker 标记）', () => {
  assert.equal(isMainStaticPassthrough(u('/robots.txt')), true);
  assert.equal(isMainStaticPassthrough(u('/favicon.ico')), true);
  /* 2026-10-21：SVG 图标、分享卡片图（社交爬虫没有会话） */
  assert.equal(isMainStaticPassthrough(u('/favicon.svg')), true);
  assert.equal(isMainStaticPassthrough(u('/og.png')), true);
  assert.equal(isMainStaticPassthrough(u('/css/main.css')), true);
});

test('列出页面地址的文件和页面仍走网关', () => {
  for (const p of ['/og.png/x', '/x/og.png', '/sitemap.xml', '/files-index.json', '/en/files-index.json', '/', '/display/', '/robots.txt/x', '/x/robots.txt']) {
    assert.equal(isMainStaticPassthrough(u(p)), false, p);
  }
  assert.equal(isMainStaticPassthrough(u('/robots.txt', 'other.example')), false);
});

test('合并 PR3：带编码 / 反斜杠 / 多斜杠的路径不直通（交给关口照常验；. / .. 段 URL 解析时已经消掉），大写的指纹文件名照常直通', () => {
  for (const p of ['/css/..%2Fdisplay/', '/css/%2e%2e/blog/rss.xml', '/js/..%2F..%2Fblog/rss.xml', '/css//main.css', '/css%2Fmain.css', '/fonts/a%20b.woff2']) {
    assert.equal(isMainStaticPassthrough(u(p)), false, p);
  }
  assert.equal(isMainStaticPassthrough(u('/js/sgx/chunk-2GU7LU6A.js')), true);
  assert.equal(isMainStaticPassthrough(u('/css/main.css', 'other.example')), false);
});
