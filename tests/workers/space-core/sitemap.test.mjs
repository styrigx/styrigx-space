/**
 * 站点地图（/sitemap.xml）
 *
 * v5 S3 起整站公开，网关不再有「公开页」清单（gate.js 访问表只管接口）；站点地图只列 data/public-pages.yaml 里想收录的页，
 * 模板只从这份数据取，不遍历全部页面（其余主站页模板自带 noindex，子站各有自己的站点地图）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('public-pages.yaml 只列首页两种语言（其余主站页 noindex）', () => {
  const yaml = readFileSync(join(root, 'space/web/data', 'public-pages.yaml'), 'utf8');
  const paths = yaml.split('\n').filter((l) => l.trim().startsWith('- /')).map((l) => l.trim().slice(2).trim());
  assert.deepEqual(paths.sort(), ['/', '/zh/']);
});

test('网关不再有公开页清单：gate.js 不导出 PUBLIC_PAGE_PATHS / isPublicPage', async () => {
  const gate = await import('../../../workers/space-core/src/gate.js');
  assert.equal(gate.PUBLIC_PAGE_PATHS, undefined);
  assert.equal(gate.isPublicPage, undefined);
});

test('sitemap.xml 模板只从 public-pages.yaml 取页', () => {
  const tpl = readFileSync(join(root, 'space/web/layouts', 'index.sitemappublic.xml'), 'utf8');
  assert.match(tpl, /index \.Site\.Data "public-pages"/, 'sitemap.xml 应从 data/public-pages.yaml 读取');
  assert.doesNotMatch(tpl, /\.Data\.Pages/, 'sitemap.xml 不应直接遍历所有页面');
});
