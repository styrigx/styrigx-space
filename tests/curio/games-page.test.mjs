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
