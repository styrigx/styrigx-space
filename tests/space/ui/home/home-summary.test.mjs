/**
 * 2026-11 对齐 PR-B（设计稿 tb4.html）：主页的纯函数（[04] 旷野小卡 2026-11-12 删除，statusSummary 只给首屏状态胶囊用）。
 * （lib/wb-view.js 的 fmtShort / charBar / termRows / renderWbTerm 用例 v6 P4 随数字健康整套删除，定稿 v5.5 §四）
 * - apps/index.js：musicLatest（[03] 音乐 最新 4 张专辑，2026-11-21）、curioLatest（[04] 奇趣 最新 4 条收藏；奇趣重组 PR 2 前是三个目录卡的 curioSummary）、
 *   gamesLatest（[05] 游戏 最新 4 个，奇趣重组 PR 2）、statusSummary（外壳六格状态的摘要：up/n、平均延迟、检查时间；首屏胶囊用 up/n）
 * 运行：node --test tests/space/ui/home/home-summary.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installI18nDom } from '../../../fixtures/i18n-dom.mjs';

installI18nDom('zh');
const { curioLatest, CURIO_LATEST_N, gamesLatest, GAMES_LATEST_N, statusSummary, musicLatest, MUSIC_LATEST_N } = await import('../../../../space/web/assets/common/js/frame/apps/index.js');

test('curioLatest：所有分类的收藏按 id 从新到旧取前 4 条；名字 / 分类名按语言取（缺了回退另一种，收藏名再缺用域名）；链接 = 奇趣首页这个分类 #c/<分类 id>', () => {
  assert.equal(CURIO_LATEST_N, 4);
  const links = { ok: true, cats: [
    { id: 1, name: { zh: '工具', en: 'Tools' }, links: [{ id: 3, name: { zh: '三', en: 'Three' }, url: 'https://a.com' }, { id: 9, name: { en: 'Nine' }, url: 'https://b.com' }] },
    { id: 2, name: { zh: '', en: 'Reading' }, links: [{ id: 5, name: '', url: 'https://c.example.org/x' }, null, { id: 1, name: { zh: '一' }, url: 'https://d.com' }] },
    { id: 4, name: { zh: '空' }, links: [] },
    null,
    { id: 6, name: { zh: '新', en: 'New' }, links: [{ id: 12, name: { zh: '十二', en: 'Twelve' }, url: 'not a url' }] },
  ] };
  const zh = curioLatest(links, '/curio/zh/', 'zh');
  assert.deepEqual(zh.map((x) => x.id), [12, 9, 5, 3], '最旧的 1 挤掉');
  assert.deepEqual(zh[0], { id: 12, name: '十二', cat: '新', href: '/curio/zh/#c/6' });
  assert.deepEqual(zh[1], { id: 9, name: 'Nine', cat: '工具', href: '/curio/zh/#c/1' }, '缺中文名回退英文');
  assert.deepEqual(zh[2], { id: 5, name: 'c.example.org', cat: 'Reading', href: '/curio/zh/#c/2' }, '没名字用域名；分类缺中文回退英文');
  const en = curioLatest(links, '/curio/', 'en', 2);
  assert.deepEqual(en, [{ id: 12, name: 'Twelve', cat: 'New', href: '/curio/#c/6' }, { id: 9, name: 'Nine', cat: 'Tools', href: '/curio/#c/1' }]);
  assert.equal(curioLatest({ ok: true, cats: [{ id: 1, name: {}, links: [{ id: 1, url: 'not a url' }] }] }, '/curio/', 'en')[0].name, '', '没名字、网址也坏 → 空名（页面写「—」）');
});

test('curioLatest：取不到 / ok:false / 没有分类表 → null；空 → []', () => {
  assert.equal(curioLatest(null, '/curio/', 'zh'), null);
  assert.equal(curioLatest({ ok: false }, '/curio/', 'zh'), null);
  assert.equal(curioLatest({ ok: true }, '/curio/', 'zh'), null);
  assert.deepEqual(curioLatest({ ok: true, cats: [] }, '/curio/', 'en'), []);
  assert.deepEqual(curioLatest({ ok: true, cats: [{ id: 1, links: [] }] }, '/curio/', 'en'), []);
});

test('gamesLatest：不分状态、按 id 从新到旧取前 4 个；有封面才给 /games/api/cover?id=；链接 = 游戏页直达 ?game=<id>；状态只认四种', () => {
  assert.equal(GAMES_LATEST_N, 4);
  const j = { ok: true, games: [
    { id: 1, title: 'Zelda', status: 'done', cover: true },
    { id: 8, title: 'Hades II', status: 'playing', cover: true },
    { id: 4, title: 'Balatro', status: 'shelved', cover: false },
    { id: 6, title: '', status: 'weird', cover: false },
    { id: 2, title: 'Celeste', status: 'want', cover: false },
    null,
    { id: 0, title: 'bad', status: 'want' },
  ] };
  const r = gamesLatest(j, '/games/zh/');
  assert.deepEqual(r.map((x) => x.id), [8, 6, 4, 2], '最旧的 1 挤掉；id 0 不进');
  assert.deepEqual(r[0], { id: 8, title: 'Hades II', status: 'playing', cover: '/games/api/cover?id=8', href: '/games/zh/?game=8' });
  assert.deepEqual(r[1], { id: 6, title: '', status: '', cover: '', href: '/games/zh/?game=6' }, '不认识的状态给空串');
  assert.deepEqual(gamesLatest(j, '/games/', 2).map((x) => x.href), ['/games/?game=8', '/games/?game=6']);
});

test('gamesLatest：取不到 / ok:false / 没有列表 → null；空列表 → []', () => {
  assert.equal(gamesLatest(null, '/games/'), null);
  assert.equal(gamesLatest({ ok: false }, '/games/'), null);
  assert.equal(gamesLatest({ ok: true }, '/games/'), null);
  assert.deepEqual(gamesLatest({ ok: true, games: [] }, '/games/'), []);
});

test('statusSummary：up / n、有数格子的平均延迟（四舍五入）、检查时间按北京时间 HH:MM', () => {
  const t = Date.parse('2026-11-08T04:05:00Z'); /* 北京 12:05 */
  const v = { t, cells: { space: { up: true, ms: 100 }, blog: { up: true, ms: 101 }, ai: { up: false, ms: null }, auth: { up: true, ms: 50 } } };
  assert.deepEqual(statusSummary(v), { up: 3, n: 4, avg: 84, at: '12:05' });
  const late = Date.parse('2026-11-08T16:30:00Z'); /* 北京次日 00:30 */
  assert.equal(statusSummary({ t: late, cells: {} }).at, '00:30');
  assert.deepEqual(statusSummary({ t: 0, cells: { a: { up: false, ms: null } } }), { up: 0, n: 1, avg: null, at: '' });
  assert.deepEqual(statusSummary(/** @type {any} */ (null)), { up: 0, n: 0, avg: null, at: '' });
});

test('musicLatest：只要专辑（单曲不进）、按 id 从新到旧取前 4 张；有封面才给封面地址；链接 = 音乐页直达专辑 ?album=<专辑 id>（有没有歌手都一样）', () => {
  assert.equal(MUSIC_LATEST_N, 4);
  const j = { ok: true, albums: [
    { id: 1, kind: 'album', title: 'Blue', artist: 'Joni Mitchell', artist_id: 2, cover: true },
    { id: 7, kind: 'album', title: 'Court and Spark', artist: 'Joni Mitchell', artist_id: 2, cover: false },
    { id: 3, kind: 'album', title: 'Ammonia Avenue', artist: 'APP', artist_id: 4, cover: true },
    { id: 41, kind: 'single', title: 'River', artist: 'Joni Mitchell', artist_id: 2, cover: true },
    { id: 5, kind: 'album', title: '无名', artist: '', artist_id: 0, cover: false },
    { id: 2, kind: 'album', title: 'Old', artist: 'X', artist_id: 9, cover: false },
    null,
  ] };
  const r = musicLatest(j, '/music/zh/');
  assert.deepEqual(r.map((x) => x.id), [7, 5, 3, 2], '单曲 41 不进；最旧的 1 挤掉');
  assert.deepEqual(r[0], { id: 7, title: 'Court and Spark', artist: 'Joni Mitchell', cover: '', href: '/music/zh/?album=7' });
  assert.deepEqual(r[1], { id: 5, title: '无名', artist: '', cover: '', href: '/music/zh/?album=5' }, '没歌手也直达专辑');
  assert.equal(r[2].cover, '/music/api/music-cover?album=3');
  assert.deepEqual(musicLatest(j, '/music/', 2).map((x) => x.href), ['/music/?album=7', '/music/?album=5']);
});

test('musicLatest：取不到 / ok:false / 没有列表 → null；空列表 → []', () => {
  assert.equal(musicLatest(null, '/music/'), null);
  assert.equal(musicLatest({ ok: false }, '/music/'), null);
  assert.equal(musicLatest({ ok: true }, '/music/'), null);
  assert.deepEqual(musicLatest({ ok: true, albums: [] }, '/music/'), []);
  assert.deepEqual(musicLatest({ ok: true, albums: [{ id: 1, kind: 'single', title: 'S' }] }, '/music/'), [], '只有单曲 = 空');
});
