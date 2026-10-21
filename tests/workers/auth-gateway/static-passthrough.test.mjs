import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMainStaticPassthrough } from '../../../workers/auth-gateway/src/index.js';

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
  for (const p of ['/og.png/x', '/x/og.png', '/sitemap.xml', '/files-index.json', '/en/files-index.json', '/', '/settings/', '/robots.txt/x', '/x/robots.txt']) {
    assert.equal(isMainStaticPassthrough(u(p)), false, p);
  }
  assert.equal(isMainStaticPassthrough(u('/robots.txt', 'blog.styrigx.com')), false);
});
