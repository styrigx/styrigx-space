// 首页逻辑的纯函数（space/web/assets/curio/js/curio.js）：双语取值、首字母、hash、筛选、挪位置、网址补全、导入结果的话。
// 运行：node --test tests/curio/curio.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { strings } from '../fixtures/strings.mjs';

const require = createRequire(import.meta.url);
const C = require('../../space/web/assets/curio/js/curio.js');

const CATS = [
  { id: 1, name: { zh: '开发', en: 'Dev' }, private: false, links: [
    { id: 11, url: 'https://github.com/', name: { zh: 'GitHub', en: '' }, desc: { zh: '代码托管', en: 'Code hosting' } },
    { id: 12, url: 'https://dash.cloudflare.com/', name: { zh: 'Cloudflare', en: '' }, desc: { zh: '域名与 Pages', en: '' } },
  ] },
  { id: 2, name: { zh: '空的', en: '' }, private: true, links: [] },
  { id: 3, name: { zh: '', en: 'Only EN' }, private: false, links: [
    { id: 31, url: 'https://ip.sb/', name: { zh: 'IP.SB', en: '' }, desc: { zh: '', en: '' } },
  ] },
];

/** 页面实际拿到的 js.<表>（英文表 ← 该语言表）配 makeTr，同页面里的 tr */
const trOf = (table, lang) => C.makeTr(strings('curio', lang).js[table], lang);

test('pick：内容（收藏名 / 简介）取页面语言那份，空就先英文、再随便哪份有字的', () => {
  assert.equal(C.pick({ zh: '开发', en: 'Dev' }, 'zh'), '开发');
  assert.equal(C.pick({ zh: '开发', en: 'Dev' }, 'en'), 'Dev');
  assert.equal(C.pick({ zh: '', en: 'Only EN' }, 'zh'), 'Only EN');
  assert.equal(C.pick({ zh: '只有中文', en: '' }, 'en'), '只有中文');
  assert.equal(C.pick({ zh: '开发', en: 'Dev' }, 'fr'), 'Dev', '没有这一列的语言 = 英文');
  assert.equal(C.pick(null, 'zh'), '');
});

test('contentLangs / contentPair：编辑弹层主输入框跟页面语言，没有那列的语言按英文', () => {
  assert.deepEqual(C.contentLangs('zh'), ['zh', 'en']);
  assert.deepEqual(C.contentLangs('en'), ['en', 'zh']);
  assert.deepEqual(C.contentLangs('fr'), ['en', 'zh']);
  assert.deepEqual(C.contentPair('zh', '甲', 'A'), { zh: '甲', en: 'A' });
  assert.deepEqual(C.contentPair('en', 'A', '甲'), { en: 'A', zh: '甲' });
});

test('makeTr：占位替换、复数按 Intl.PluralRules（键_one 只英文有，中文回退键本身）、缺键返回空', () => {
  const en = trOf('curio', 'en'), zh = trOf('curio', 'zh');
  assert.equal(en('count', { n: 1 }), '1 link');
  assert.equal(en('count', { n: 3 }), '3 links');
  assert.equal(zh('count', { n: 1 }), '1 条');
  assert.equal(en('nope'), '');
  /* 没有语言包的语言整份回退英文 */
  assert.equal(C.makeTr(strings('curio', 'fr').js.curio, 'fr')('count', { n: 2 }), '2 links');
});

test('makeTr：页面把带数字的键改挂成函数（T.tracks = function(n){ return tr(\'tracks\', …) }）后，tr 仍读原始文案（四个脚本同一份）', () => {
  for (const f of ['curio.js', 'curio-items.js', 'curio-movies.js', 'curio-music.js']) {
    const M = require('../../space/web/assets/curio/js/' + f);
    const T = { tracks: '{n} 首', chosen: '已选 {n} 个' };
    const tr = M.makeTr(T, 'zh');
    T.tracks = function (n) { return tr('tracks', { n: n }); };
    T.chosen = function (n) { return tr('chosen', { n: n }); };
    assert.equal(T.tracks(2), '2 首', f);
    assert.equal(T.chosen(3), '已选 3 个', f);
  }
});

test('hostOf / initial：去 www、首字大写', () => {
  assert.equal(C.hostOf('https://www.example.com/a'), 'example.com');
  assert.equal(C.initial('github', 'https://github.com'), 'G');
  assert.equal(C.initial('', 'https://www.mdn.dev'), 'M');
  assert.equal(C.initial('奇趣', ''), '奇');
  assert.equal(C.initial('😀 smile', ''), '😀');
});

test('hash：#c/<id> ↔ 分类，其余当全部', () => {
  assert.equal(C.parseHash('#c/12'), 12);
  assert.equal(C.parseHash(''), 0);
  assert.equal(C.parseHash('#c/x'), 0);
  assert.equal(C.catHash(3), '#c/3');
  assert.equal(C.catHash(0), '');
});

test('filterCats：按分类、按多个词（名字 / 简介 / 网址，两种语言，不分大小写）', () => {
  assert.deepEqual(C.filterCats(CATS, '', 0).map((c) => c.id), [1, 2, 3]);
  assert.deepEqual(C.filterCats(CATS, '', 2).map((c) => c.id), [2]);
  assert.deepEqual(C.filterCats(CATS, 'code', 0).map((c) => c.links.map((l) => l.id)), [[11]]);
  assert.deepEqual(C.filterCats(CATS, 'PAGES 域名', 0).map((c) => c.links.map((l) => l.id)), [[12]]);
  assert.deepEqual(C.filterCats(CATS, 'ip.sb', 1), []);
  assert.deepEqual(C.filterCats(CATS, 'zzz', 0), []);
  assert.equal(C.countLinks(CATS), 3);
  assert.equal(CATS[0].links.length, 2, '不改原数组');
});

test('moveId：上移 / 下移，到头返回 null', () => {
  assert.deepEqual(C.moveId([1, 2, 3], 2, -1), [2, 1, 3]);
  assert.deepEqual(C.moveId([1, 2, 3], 2, 1), [1, 3, 2]);
  assert.equal(C.moveId([1, 2, 3], 1, -1), null);
  assert.equal(C.moveId([1, 2, 3], 3, 1), null);
  assert.equal(C.moveId([1, 2, 3], 9, 1), null);
});

test('normalizeUrl：没写协议补 https；只收 http(s)', () => {
  assert.equal(C.normalizeUrl('github.com/styrigx'), 'https://github.com/styrigx');
  assert.equal(C.normalizeUrl(' http://a.com '), 'http://a.com/');
  assert.equal(C.normalizeUrl('javascript:alert(1)'), '');
  assert.equal(C.normalizeUrl(''), '');
});

test('importSummary：文案走字符串表 js.curio.imp*，复数按语言', () => {
  assert.equal(C.importSummary({ added: 12, cats_added: 2, skipped: 3 }, trOf('curio', 'zh')), '新增 12 条、2 个分类，3 条已经有了。');
  assert.equal(C.importSummary({ added: 1, cats_added: 0, skipped: 0 }, trOf('curio', 'en')), 'Added 1 link.');
  assert.equal(C.importSummary({ added: 2, cats_added: 1, skipped: 4 }, trOf('curio', 'en')), 'Added 2 links, 1 new category; 4 already here.');
});

/* ===== 设备 / 游戏（curio-items.js）、首页（curio-home.js）、电影（curio-movies.js）、音乐（curio-music.js） ===== */
test('isLockedReply：写请求只有 401 unauthorized（或没码的 401）才当锁定；401 account / reauth 不刷新（P2-2）', () => {
  assert.equal(C.isLockedReply(401, 'unauthorized'), true);
  assert.equal(C.isLockedReply(401, undefined), true);
  assert.equal(C.isLockedReply(401, 'account'), false);
  assert.equal(C.isLockedReply(401, 'reauth'), false);
  assert.equal(C.isLockedReply(403, 'scope'), false);
  assert.equal(C.isLockedReply(200, ''), false);
});

const IT = require('../../space/web/assets/curio/js/curio-items.js');
const HM = require('../../space/web/assets/curio/js/curio-home.js');
const MV = require('../../space/web/assets/curio/js/curio-movies.js');
const MU = require('../../space/web/assets/curio/js/curio-music.js');

test('usedDays：购买当天算第 1 天，退役了算到退役日；没填 / 倒了返回 null；daysText 满一年带年数', () => {
  assert.equal(IT.usedDays('2026-10-22', '', '2026-10-22'), 1);
  assert.equal(IT.usedDays('2024-02-28', '2024-03-01', '2026-01-01'), 3, '闰年');
  assert.equal(IT.usedDays('2025-10-22', '', '2026-10-22'), 366);
  assert.equal(IT.usedDays('', '', '2026-10-22'), null);
  assert.equal(IT.usedDays('2026-10-23', '', '2026-10-22'), null);
  const itZh = IT.makeTr(strings('curio', 'zh').js.curioItems, 'zh'), itEn = IT.makeTr(strings('curio', 'en').js.curioItems, 'en');
  assert.equal(IT.daysText(30, itZh), '30 天');
  assert.equal(IT.daysText(731, itZh), '731 天 · 约 2 年');
  assert.equal(IT.daysText(1, itEn), '1 day');
  assert.equal(IT.daysText(400, itEn), '400 days · about 1.1 years');
  assert.equal(IT.daysText(370, itEn), '370 days · about 1 year');
  assert.match(IT.todayStr(Date.UTC(2026, 9, 22, 12)), /^2026-10-2[12]$/);
});

test('筛选、换代历史、平台联想、缩图尺寸', () => {
  const D = [{ id: 1, retired_at: '2025-01-01', replaced_by: 2 }, { id: 2, retired_at: '', replaced_by: 0 }, { id: 3, retired_at: '2024-01-01', replaced_by: 2 }];
  assert.deepEqual(IT.filterDevices(D, 'active').map((d) => d.id), [2]);
  assert.deepEqual(IT.filterDevices(D, 'retired').map((d) => d.id), [1, 3]);
  assert.equal(IT.filterDevices(D, 'all').length, 3);
  assert.deepEqual(IT.lineage(D, 2).before.map((d) => d.id), [1, 3]);
  assert.equal(IT.lineage(D, 1).after.id, 2);
  assert.equal(IT.lineage(D, 2).after, null);
  const Gs = [{ status: 'done', platform: 'Switch' }, { status: 'want', platform: ' PC ' }, { status: 'done', platform: 'Switch' }, { status: 'want', platform: '' }];
  assert.equal(IT.filterGames(Gs, 'done').length, 2);
  assert.equal(IT.filterGames(Gs, 'all').length, 4);
  assert.deepEqual(IT.platformsOf(Gs), ['Switch', 'PC']);
  assert.deepEqual(IT.fitSize(4000, 3000, 1600), { w: 1600, h: 1200 });
  assert.deepEqual(IT.fitSize(800, 600, 1600), { w: 800, h: 600 });
  assert.deepEqual(IT.KINDS.length, 9);
  assert.deepEqual(IT.STATUS, ['want', 'playing', 'done', 'shelved']);
});

test('裁剪几何：取景框按卡片比例、照片始终盖满、框住的原图区域、重新调整摆回原位', () => {
  const css = readFileSync(new URL('../../space/web/assets/curio/css/input.css', import.meta.url), 'utf8');
  /* 照片按 设备 4:3 / 游戏 3:4 存；2026-11 对齐 PR-C2 起卡片封面位是固定高度（共享外壳 .sgx-cc-im 150 / 90px），图片 object-fit: cover 铺满 */
  assert.match(readFileSync(new URL('../../space/web/assets/css/shell/shell.css', import.meta.url), 'utf8'), /\.sgx-cc-im img \{[^}]*object-fit: cover;/);
  assert.match(css, /\.it-cc \.sgx-cc-im img \{ z-index: 1; \}/);
  assert.equal(IT.CROP_RATIO.device, 4 / 3);
  assert.equal(IT.CROP_RATIO.game, 3 / 4);
  /* 412×915 手机：设备框 364×273，游戏框 364×485；矮屏按高度收 */
  assert.deepEqual(IT.cropFrame(412, 915, 4 / 3), { w: 364, h: 273 });
  assert.deepEqual(IT.cropFrame(412, 915, 3 / 4), { w: 364, h: 485 });
  assert.deepEqual(IT.cropFrame(1280, 600, 3 / 4), { w: 285, h: 380 });
  assert.deepEqual(IT.cropFrame(1920, 1080, 4 / 3), { w: 520, h: 390 });
  const f = { l: 24, t: 300, w: 364, h: 273 };
  /* 竖图 3000×4000 放进 4:3 框：按宽盖满，居中 */
  const c = IT.centerView(3000, 4000, f);
  assert.equal(c.k, 364 / 3000);
  const s = IT.cropSource(c, 3000, 4000, f);
  assert.ok(Math.abs(s.sx) < 1e-9 && Math.abs(s.sw - 3000) < 1e-9);
  assert.ok(Math.abs(s.sh - 2250) < 1e-6 && Math.abs(s.sy - 875) < 1e-6, '上下各裁掉 875');
  /* 夹住：缩小不到盖满，放大最多 8 倍，拖不出空白 */
  assert.equal(IT.clampView({ tx: 0, ty: 0, k: 0.01 }, 3000, 4000, f, 8).k, c.k);
  assert.equal(IT.clampView({ tx: 0, ty: 0, k: 99 }, 3000, 4000, f, 8).k, c.k * 8);
  const far = IT.clampView({ tx: 500, ty: 900, k: c.k }, 3000, 4000, f, 8);
  assert.deepEqual([far.tx, far.ty], [24, 300], '左上角不能进框');
  const away = IT.clampView({ tx: -9999, ty: -9999, k: c.k }, 3000, 4000, f, 8);
  assert.ok(Math.abs(away.tx + 3000 * c.k - (24 + 364)) < 1e-9 && Math.abs(away.ty + 4000 * c.k - (300 + 273)) < 1e-9, '右下角不能进框');
  /* 放大 2 倍拖到右下：原图区域在图内、比例 4:3 */
  const z = IT.clampView({ tx: -9999, ty: -9999, k: c.k * 2 }, 3000, 4000, f, 8);
  const zs = IT.cropSource(z, 3000, 4000, f);
  assert.ok(Math.abs(zs.sx + zs.sw - 3000) < 1e-6 && Math.abs(zs.sy + zs.sh - 4000) < 1e-6);
  assert.ok(Math.abs(zs.sw / zs.sh - 4 / 3) < 1e-9);
  /* 重新调整 / 转屏：换个框，照原图区域摆回去还是同一块 */
  const f2 = { l: 10, t: 50, w: 520, h: 390 };
  const back = IT.cropSource(IT.viewFromSource(zs, f2), 3000, 4000, f2);
  for (const key of ['sx', 'sy', 'sw', 'sh']) assert.ok(Math.abs(back[key] - zs[key]) < 1e-6, key);
  /* 输出：严格按卡片比例，长边 1200，小图不放大；取景框取整的误差（364×485）不进成品 */
  assert.deepEqual(IT.cropOut(zs.sw, zs.sh, 4 / 3, 1200), { w: 1200, h: 900 });
  assert.deepEqual(IT.cropOut(750.6, 1000, 3 / 4, 1200), { w: 750, h: 1000 });
  assert.deepEqual(IT.cropOut(4000, 3000, 4 / 3, 1200), { w: 1200, h: 900 });
  assert.deepEqual(IT.cropOut(300, 400, 3 / 4, 1200), { w: 300, h: 400 });
});

test('首页旧 hash（客户端兼容）：#devices / #games → 子页；#c/<id> 不跳（对齐 PR-C2 起首页就是发现，就地生效），其余不跳；curio-tabs.js 已删', () => {
  assert.deepEqual(HM.legacyTarget('#devices'), { entry: 'devices', hash: '' });
  assert.deepEqual(HM.legacyTarget('#games'), { entry: 'games', hash: '' });
  assert.deepEqual(HM.legacyTarget('#games/x'), { entry: 'games', hash: '' });
  for (const h of ['', '#', '#c/3', '#c/x', '#trove', '#music']) assert.equal(HM.legacyTarget(h), null, h);
  assert.equal(existsSync(new URL('../../space/web/assets/curio/js/curio-tabs.js', import.meta.url)), false);
});

test('电影：副标题 = 年份 · 导演；年份空 = 0、不合格 null；海报裁剪 2:3、长边 1600', () => {
  assert.equal(MV.movieSub({ year: 2000, director: '王家卫' }), '2000 · 王家卫');
  assert.equal(MV.movieSub({ year: 0, director: '' }), '');
  assert.equal(MV.parseYear(''), 0);
  assert.equal(MV.parseYear(' 2001 '), 2001);
  assert.equal(MV.parseYear('1700'), null);
  assert.equal(MV.parseYear('20.5'), null);
  assert.equal(IT.CROP_RATIO.movie, 2 / 3);
  assert.deepEqual(IT.cropOut(3000, 4500, 2 / 3, 1600), { w: 1067, h: 1600 });
});

test('音乐：倍速循环、时间格式、LRC 解析与当前行、文件名 → 曲序 / 曲名、自然排序、音频类型、歌词配对', () => {
  assert.deepEqual(MU.SPEEDS, [0.75, 1, 1.25, 1.5, 2]);
  assert.deepEqual([1, 1.25, 1.5, 2, 0.75].map(MU.nextSpeed), [1.25, 1.5, 2, 0.75, 1]);
  assert.equal(MU.nextSpeed(3), 0.75);
  assert.equal(MU.fmtTime(0), '0:00');
  assert.equal(MU.fmtTime(212.7), '3:32');
  assert.equal(MU.fmtTime(3725), '1:02:05');
  const L = MU.parseLrc('[ar:Joni]\n[00:01.50][00:10.00]hi\n\n[00:05]yo\nplain');
  assert.deepEqual(L, [{ t: 1.5, text: 'hi' }, { t: 5, text: 'yo' }, { t: 10, text: 'hi' }]);
  assert.equal(MU.lrcIndex(L, 0), -1);
  assert.equal(MU.lrcIndex(L, 1.5), 0);
  assert.equal(MU.lrcIndex(L, 7), 1);
  assert.equal(MU.lrcIndex(L, 99), 2);
  assert.equal(MU.lrcIndex([], 3), -1);
  assert.deepEqual(MU.trackFromName('01 - All I Want.mp3', 9), { no: 1, title: 'All I Want' });
  assert.deepEqual(MU.trackFromName('10.My Old Man.m4a', 1), { no: 10, title: 'My Old Man' });
  assert.deepEqual(MU.trackFromName('Blue.flac', 3), { no: 3, title: 'Blue' });
  assert.deepEqual(MU.sortByName([{ name: '10 b' }, { name: '2 a' }, { name: '01 c' }]).map((f) => f.name), ['01 c', '2 a', '10 b']);
  assert.equal(MU.audioType({ type: 'audio/flac', name: 'x' }), 'audio/flac');
  assert.equal(MU.audioType({ type: 'audio/x-m4a', name: 'x' }), 'audio/mp4');
  assert.equal(MU.audioType({ type: '', name: 'a.MP3' }), 'audio/mpeg');
  assert.equal(MU.audioType({ type: '', name: 'a.txt' }), '');
  assert.equal(MU.lrcKey('01 - Help Me.lrc'), MU.lrcKey('01 - Help Me.wav'));
  assert.equal(MU.TRACK_MAX, 95 * 1024 * 1024);
});

/* ---------- 2026-11 对齐 PR-C2：分区列表公共部件（curio-list.js）+ 条目页（相关文章 / 前后条目） ---------- */
const CL = require('../../space/web/assets/curio/js/curio-list.js');

test('grep：按空白切词、转小写、去掉开头 #；每个词都要出现', () => {
  assert.deepEqual(CL.grepWords('  #三星  Galaxy '), ['三星', 'galaxy']);
  assert.deepEqual(CL.grepWords(''), []);
  assert.equal(CL.grepMatch('Galaxy S25 Ultra 手机 三星', CL.grepWords('galaxy #三星')), true);
  assert.equal(CL.grepMatch('Galaxy S25 Ultra', CL.grepWords('galaxy pixel')), false);
  assert.equal(CL.grepMatch('anything', []), true);
});

test('排序：order / name 升序，其余降序；数字按数字比，空值垫底；同值按原顺序', () => {
  assert.equal(CL.sortAsc('order'), true);
  assert.equal(CL.sortAsc('name'), true);
  for (const k of ['recent', 'bought', 'rating', 'watched']) assert.equal(CL.sortAsc(k), false, k);
  const rows = [{ v: '3', ord: 0 }, { v: '10', ord: 1 }, { v: '', ord: 2 }, { v: '3', ord: 3 }];
  assert.deepEqual(rows.slice().sort((a, b) => CL.cmpKey(a, b, 'rating')).map((r) => r.ord), [1, 0, 3, 2]);
  assert.deepEqual(rows.slice().sort((a, b) => CL.cmpKey(a, b, 'order')).map((r) => r.ord), [0, 3, 1, 2]);
  const dates = [{ v: '2024-01-02', ord: 0 }, { v: '2025-03-01', ord: 1 }];
  assert.deepEqual(dates.slice().sort((a, b) => CL.cmpKey(a, b, 'bought')).map((r) => r.ord), [1, 0]);
  const names = [{ v: 'b', ord: 0 }, { v: 'A', ord: 1 }];
  assert.deepEqual(names.slice().sort((a, b) => CL.cmpKey(a, b, 'name', 'en')).map((r) => r.ord), [1, 0]);
});

test('分页条：「-- 已显示 / 共 --」，页大小桌面 12 / 手机 8；tab 计数只问别的分区的接口', () => {
  assert.equal(CL.countText(12, 42), '-- 12 / 42 --');
  assert.equal(CL.countText(12, 5), '-- 5 / 5 --');
  assert.equal(CL.countText(3, 9, '{n} of {total}'), '3 of 9');
  assert.equal(CL.pageSize(true), 12);
  assert.equal(CL.pageSize(false), 8);
  assert.deepEqual(CL.countSources('finds'), ['items', 'movies']);
  assert.deepEqual(CL.countSources('devices'), ['links', 'movies']);
  assert.deepEqual(CL.countSources('games'), ['links', 'movies']);
  assert.deepEqual(CL.countSources('movies'), ['links', 'items']);
  assert.deepEqual(CL.countSources('music'), ['links', 'items', 'movies']);
});

test('条目页：相关文章按名字找（整名在标题 > 词在标题 > 词在标签；同分取新的；没有 null）；收入于取年月；前后条目', () => {
  const posts = [
    { t: '把 Galaxy 当主力：一年记', u: '/blog/post/a/', g: ['三星'] },
    { t: 'Galaxy S25 Ultra 上手', u: '/blog/post/b/', g: [] },
    { t: '王国之泪通关', u: '/blog/post/c/', g: ['塞尔达传说'] },
    { t: '随便写写', u: '/blog/post/d/', g: ['Hades'] },
  ];
  assert.equal(IT.relatedPost('Galaxy S25 Ultra', posts).u, '/blog/post/b/');
  assert.equal(IT.relatedPost('Galaxy Tab S9', posts).u, '/blog/post/a/');
  assert.equal(IT.relatedPost('塞尔达传说 王国之泪', posts).u, '/blog/post/c/');
  assert.equal(IT.relatedPost('Hades II', posts).u, '/blog/post/d/');
  assert.equal(IT.relatedPost('Pixel 9', posts), null);
  assert.equal(IT.relatedPost('', posts), null);
  assert.equal(IT.relatedPost('Galaxy', []), null);
  assert.equal(IT.monthOf('2025-03-01'), '2025-03');
  assert.equal(IT.monthOf(''), '');
  const list = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(IT.neighbors(list, 1), { prev: null, next: { id: 2 } });
  assert.deepEqual(IT.neighbors(list, 2), { prev: { id: 1 }, next: { id: 3 } });
  assert.deepEqual(IT.neighbors(list, 3), { prev: { id: 2 }, next: null });
  assert.deepEqual(IT.neighbors(list, 9), { prev: null, next: null });
});

test('相关文章：拉丁词按整词比（pro 不算 project），中文按子串', () => {
  const posts = [{ t: 'Project notes', u: '/a/', g: [] }, { t: '用 iPad Pro 写字', u: '/b/', g: [] }];
  assert.equal(IT.relatedPost('MacBook Pro', posts).u, '/b/');
  assert.equal(IT.relatedPost('Prodigy', posts), null);
});
