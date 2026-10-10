/**
 * 2.8.0 搜索收录整理测试
 *
 * 1. data/public-pages.yaml 与 functions/_kernel/public-pages.js 保持同步
 *    （白名单和 L1 middleware 的公开路径用同一个数据源）
 * 2. sitemap 只收录公开页（未登录返回 200 的页面）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PUBLIC_PAGE_PATHS, isPublicPage } from '../../functions/_kernel/public-pages.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('public-pages.yaml 与 public-pages.js 同步', () => {
  const yaml = readFileSync(join(root, 'data', 'public-pages.yaml'), 'utf8');
  const yamlPaths = yaml
    .split('\n')
    .filter(l => l.trim().startsWith('- /'))
    .map(l => l.trim().slice(2).trim());
  assert.deepEqual(
    [...PUBLIC_PAGE_PATHS].sort(),
    [...yamlPaths].sort(),
    'data/public-pages.yaml 与 functions/_kernel/public-pages.js 的公开页清单不一致'
  );
});

test('公开页只包含 / 和 /en/（未登录返回 200）', () => {
  assert.deepEqual(
    [...PUBLIC_PAGE_PATHS].sort(),
    ['/', '/en/'].sort(),
    '公开页应只包含 / 和 /en/'
  );
});

test('isPublicPage 识别公开页（/en 无斜杠也认）', () => {
  assert.equal(isPublicPage('/'), true);
  assert.equal(isPublicPage('/en/'), true);
  assert.equal(isPublicPage('/en'), true);
  assert.equal(isPublicPage('/store/'), false);
  assert.equal(isPublicPage('/settings/'), false);
  assert.equal(isPublicPage('/settings/security/lock/'), false);
  assert.equal(isPublicPage('/browser/'), false);
  assert.equal(isPublicPage('/files/'), false);
});

test('sitemap.xml 模板只从 public-pages.yaml 取页（无锁住页面）', () => {
  const tpl = readFileSync(join(root, 'layouts', 'sitemap.xml'), 'utf8');
  /* 必须引用数据源，不直接遍历 .Data.Pages */
  assert.match(tpl, /index \.Site\.Data "public-pages"/, 'sitemap.xml 应从 data/public-pages.yaml 读取');
  assert.doesNotMatch(tpl, /\.Data\.Pages/, 'sitemap.xml 不应直接遍历所有页面');
});
