// 游戏子站（/games/，奇趣重组设计稿 v1.0 PR 2；原奇趣 › 游戏）页面脚本的纯函数：space/web/assets/games/js/games-page.js、games-ui.js。
// 从 tests/curio/curio.test.mjs 搬来的游戏部分（筛选、平台联想、状态、封面 3:4 裁剪）+ 条目页地址 ?game=<id>。
// 运行：node --test tests/curio/games-page.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { strings } from '../fixtures/strings.mjs';

const require = createRequire(import.meta.url);
const GP = require('../../space/web/assets/games/js/games-page.js');
const GU = require('../../space/web/assets/games/js/games-ui.js');

test('筛选、平台联想、状态（同 /games/ 的 chips）', () => {
  const Gs = [{ status: 'done', platform: 'Switch' }, { status: 'want', platform: ' PC ' }, { status: 'done', platform: 'Switch' }, { status: 'want', platform: '' }];
  assert.equal(GP.filterGames(Gs, 'done').length, 2);
  assert.equal(GP.filterGames(Gs, 'all').length, 4);
  assert.deepEqual(GP.platformsOf(Gs), ['Switch', 'PC']);
  assert.deepEqual(GP.STATUS, ['want', 'playing', 'done', 'shelved']);
  /* 状态文案：游戏页的 js.gamesPage.status_*，主页 [05] 用同样的话（data/common/i18n js.space.game*） */
  for (const l of ['en', 'zh']) {
    const gp = strings('games', l).js.gamesPage, sp = strings('space', l).js.space;
    for (const st of GP.STATUS) assert.equal(sp['game' + st[0].toUpperCase() + st.slice(1)], gp['status_' + st], l + ' ' + st);
  }
});

test('封面：3:4 取景框、长边 1200；封面地址 /games/api/cover?id=（换过带 &v=）', () => {
  assert.equal(GP.COVER_RATIO, 3 / 4);
  assert.deepEqual(GP.cropFrame(412, 915, 3 / 4), { w: 364, h: 485 });
  assert.deepEqual(GP.cropFrame(1280, 600, 3 / 4), { w: 285, h: 380 });
  assert.deepEqual(GP.cropOut(750.6, 1000, 3 / 4, 1200), { w: 750, h: 1000 });
  assert.deepEqual(GP.cropOut(300, 400, 3 / 4, 1200), { w: 300, h: 400 });
  assert.equal(GP.coverUrl(5), '/games/api/cover?id=5');
  assert.equal(GP.coverUrl(5, 3), '/games/api/cover?id=5&v=3');
});

test('条目页地址：?game=<id>（旧 ?id= 也认）；0 = 列表；主页 [05] 和搜索索引都链这个', () => {
  assert.equal(GU.gameIdOf('?game=12'), 12);
  assert.equal(GU.gameIdOf('?x=1&game=7'), 7);
  assert.equal(GU.gameIdOf('?id=3'), 3);
  assert.equal(GU.gameIdOf('?game=abc'), 0);
  assert.equal(GU.gameIdOf(''), 0);
  assert.equal(GU.itemUrl('/games/zh/', 7), '/games/zh/?game=7');
  assert.equal(GU.itemUrl('/games/', 0, '#x'), '/games/#x');
});

test('裁剪几何（原 curio.test.mjs 设备照片 4:3 那条，奇趣重组 PR 3 删了设备后按游戏封面 3:4 测）：照片始终盖满、框住的原图区域、重新调整摆回原位', () => {
  const f = { l: 24, t: 215, w: 360, h: 480 };
  /* 横图 4000×3000 放进 3:4 框：按高盖满，左右居中 */
  const c = GP.centerView(4000, 3000, f);
  assert.equal(c.k, 480 / 3000);
  const s = GP.cropSource(c, 4000, 3000, f);
  assert.ok(Math.abs(s.sy) < 1e-9 && Math.abs(s.sh - 3000) < 1e-9);
  assert.ok(Math.abs(s.sx + s.sw / 2 - 2000) < 1e-6, '左右各裁一半');
  /* 夹住：缩小不到盖满，放大最多 8 倍，拖不出空白 */
  assert.equal(GP.clampView({ tx: 0, ty: 0, k: 0.01 }, 4000, 3000, f, 8).k, c.k);
  assert.equal(GP.clampView({ tx: 0, ty: 0, k: 99 }, 4000, 3000, f, 8).k, c.k * 8);
  const far = GP.clampView({ tx: 500, ty: 900, k: c.k }, 4000, 3000, f, 8);
  assert.deepEqual([far.tx, far.ty], [24, 215], '左上角不能进框');
  const away = GP.clampView({ tx: -9999, ty: -9999, k: c.k }, 4000, 3000, f, 8);
  assert.ok(Math.abs(away.tx + 4000 * c.k - (24 + 360)) < 1e-9 && Math.abs(away.ty + 3000 * c.k - (215 + 480)) < 1e-9, '右下角不能进框');
  /* 放大 2 倍拖到右下：原图区域在图内、比例 3:4 */
  const z = GP.clampView({ tx: -9999, ty: -9999, k: c.k * 2 }, 4000, 3000, f, 8);
  const zs = GP.cropSource(z, 4000, 3000, f);
  assert.ok(Math.abs(zs.sx + zs.sw - 4000) < 1e-6 && Math.abs(zs.sy + zs.sh - 3000) < 1e-6);
  assert.ok(Math.abs(zs.sw / zs.sh - 3 / 4) < 1e-9);
  /* 重新调整 / 转屏：换个框，照原图区域摆回去还是同一块 */
  const f2 = { l: 10, t: 50, w: 285, h: 380 };
  const back = GP.cropSource(GP.viewFromSource(zs, f2), 4000, 3000, f2);
  for (const key of ['sx', 'sy', 'sw', 'sh']) assert.ok(Math.abs(back[key] - zs[key]) < 1e-6, key);
  /* 输出：严格按封面比例，长边 1200，小图不放大 */
  assert.deepEqual(GP.cropOut(zs.sw, zs.sh, 3 / 4, 1200), { w: 900, h: 1200 });
  assert.deepEqual(GP.cropOut(300, 400, 3 / 4, 1200), { w: 300, h: 400 });
});

test('条目页（原 curio.test.mjs 设备那条，奇趣重组 PR 3 搬来按游戏测）：相关文章按名字找（整名在标题 > 词在标题 > 词在标签；同分取新的；没有 null）；前后条目', () => {
  const posts = [
    { t: '把 Galaxy 当主力：一年记', u: '/blog/post/a/', g: ['三星'] },
    { t: 'Galaxy S25 Ultra 上手', u: '/blog/post/b/', g: [] },
    { t: '王国之泪通关', u: '/blog/post/c/', g: ['塞尔达传说'] },
    { t: '随便写写', u: '/blog/post/d/', g: ['Hades'] },
  ];
  assert.equal(GP.relatedPost('Galaxy S25 Ultra', posts).u, '/blog/post/b/');
  assert.equal(GP.relatedPost('Galaxy Tab S9', posts).u, '/blog/post/a/');
  assert.equal(GP.relatedPost('塞尔达传说 王国之泪', posts).u, '/blog/post/c/');
  assert.equal(GP.relatedPost('Hades II', posts).u, '/blog/post/d/');
  assert.equal(GP.relatedPost('Pixel 9', posts), null);
  assert.equal(GP.relatedPost('', posts), null);
  assert.equal(GP.relatedPost('Galaxy', []), null);
  const list = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(GP.neighbors(list, 1), { prev: null, next: { id: 2 } });
  assert.deepEqual(GP.neighbors(list, 2), { prev: { id: 1 }, next: { id: 3 } });
  assert.deepEqual(GP.neighbors(list, 3), { prev: { id: 2 }, next: null });
  assert.deepEqual(GP.neighbors(list, 9), { prev: null, next: null });
});

test('相关文章：拉丁词按整词比（pro 不算 project），中文按子串', () => {
  const posts = [{ t: 'Project notes', u: '/a/', g: [] }, { t: '用 iPad Pro 写字', u: '/b/', g: [] }];
  assert.equal(GP.relatedPost('MacBook Pro', posts).u, '/b/');
  assert.equal(GP.relatedPost('Prodigy', posts), null);
});
