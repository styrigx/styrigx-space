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

test('makeTr：页面把带数字的键改挂成函数（T.tracks = function(n){ return tr(\'tracks\', …) }）后，tr 仍读原始文案（各脚本同一份；curio-items / curio-movies 奇趣重组 PR 3 删了）', () => {
  for (const f of ['curio/js/curio.js', 'music/js/music-page.js', 'games/js/games-page.js']) {
    const M = require('../../space/web/assets/' + f);
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

/* ===== 音乐（music/js/music-page.js，music 搬家第 3 步前 curio-music.js）；设备 curio-items.js、首页旧 hash curio-home.js、电影 curio-movies.js 奇趣重组 PR 3 删了 ===== */
test('isLockedReply：写请求 401 当锁定；其余不是', () => {
  assert.equal(C.isLockedReply(401), true);
  assert.equal(C.isLockedReply(403), false);
  assert.equal(C.isLockedReply(200), false);
});

const MU = require('../../space/web/assets/music/js/music-page.js');

test('奇趣重组 PR 3：设备 / 电影的脚本（curio-items.js、curio-movies.js）和首页旧 hash 转跳（curio-home.js）删了；curio-tabs.js 早已删；curio.js 不再有条目页 / tab「›」/ SgxCurioList 计数', () => {
  for (const f of ['curio-items.js', 'curio-movies.js', 'curio-home.js', 'curio-tabs.js']) {
    assert.equal(existsSync(new URL('../../space/web/assets/curio/js/' + f, import.meta.url)), false, f);
  }
  const src = readFileSync(new URL('../../space/web/assets/curio/js/curio.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /showItem|onItemRoute|goItem|paintTabsMore|cu-tabs-more|SgxCurioList|SgxCurioPhoto|curio\/api\/(items|movies|photo)/);
  const css = readFileSync(new URL('../../space/web/assets/curio/css/input.css', import.meta.url), 'utf8') + readFileSync(new URL('../../space/web/assets/curio/css/curio-tail.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /cu-tabs-more|it-photo-prev--poster|#dv-edit-wrap|#mv-edit-wrap|is-retired/);
  /* 游戏子站借奇趣 main.css 的卡片 / 条目页 / 裁剪规则，这几条留着 */
  assert.match(css, /\.it-cc \.sgx-cc-im img \{ z-index: 1; \}/);
  assert.match(css, /\.cu-item\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.cu-crop \{/);
});

test('音乐：时间格式、文件名 → 曲序 / 曲名、自然排序、音频类型、歌词配对（倍速 / LRC 当前行随页内播放删了，music 搬家第 3 步；LRC 解析在共用核，播放器用）', () => {
  const CORE = require('../../space/web/assets/common/js/music/music-core.js');
  assert.equal(MU.SPEEDS, undefined);
  assert.equal(MU.fmtTime(0), '0:00');
  assert.equal(MU.fmtTime(212.7), '3:32');
  assert.equal(MU.fmtTime(3725), '1:02:05');
  const L = CORE.parseLrc('[ar:Joni]\n[00:01.50][00:10.00]hi\n\n[00:05]yo\nplain');
  assert.deepEqual(L, [{ t: 1.5, text: 'hi' }, { t: 5, text: 'yo' }, { t: 10, text: 'hi' }]);
  assert.equal(CORE.lrcIndex(L, 0), -1);
  assert.equal(CORE.lrcIndex(L, 1.5), 0);
  assert.equal(CORE.lrcIndex(L, 7), 1);
  assert.equal(CORE.lrcIndex(L, 99), 2);
  assert.equal(CORE.lrcIndex([], 3), -1);
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

test('音乐 M3 导入后编辑：所属专辑下拉只列 kind=album、按名排序；编辑表单只带改了的字段（停在原处不带 album_id）；歌词改没改；年份；批量改逐条成请求（年份只对单曲）', () => {
  const list = [
    { id: 1, kind: 'album', title: 'Blue' }, { id: 9, kind: 'single', title: 'Aaa' }, { id: 2, kind: 'album', title: 'ammonia' },
    { id: 3, title: '旧数据没 kind' }, { id: 4, kind: 'album', title: 'Album 10' }, { id: 5, kind: 'album', title: 'Album 9' },
  ];
  assert.deepEqual(MU.albumChoices(list, 'en').map((a) => a.id), [5, 4, 2, 1, 3], '单曲不列；自然序、不分大小写');
  assert.deepEqual(MU.albumChoices([], 'zh'), []);

  const t = { id: 11, title: 'A', artist: 'Joni' };
  assert.equal(MU.trackEditBody(t, { albumId: 1, single: false }, { title: 'A', artist: 'Joni', album: '1', lrc: null }), null, '没改');
  assert.deepEqual(MU.trackEditBody(t, { albumId: 1, single: false }, { title: ' B ', artist: '', album: '1', lrc: '' }), { op: 'track.edit', id: 11, title: 'B', artist: '', lrc: '' });
  assert.deepEqual(MU.trackEditBody(t, { albumId: 1, single: false }, { title: 'A', artist: 'Joni', album: '2', lrc: null }), { op: 'track.edit', id: 11, album_id: 2 });
  assert.deepEqual(MU.trackEditBody(t, { albumId: 1, single: false }, { title: 'A', artist: 'Joni', album: '0', lrc: null }), { op: 'track.edit', id: 11, album_id: 0 }, '移出变单曲');
  assert.equal(MU.trackEditBody(t, { albumId: 31, single: true }, { title: 'A', artist: 'Joni', album: '0', lrc: null }), null, '单曲停在顶项 = 不移');
  assert.deepEqual(MU.trackEditBody(t, { albumId: 31, single: true }, { title: 'A', artist: 'Joni', album: '1', lrc: null }), { op: 'track.edit', id: 11, album_id: 1 }, '单曲划进专辑');
  assert.equal(MU.trackEditBody(t, { albumId: 1, single: false }, { title: '', artist: 'Joni', album: '1', lrc: null }), null, '空歌名不发（表单先拦）');
  /* 单曲年份（Gray 审 3）：同一个 track.edit 带 year；没改不带；划进专辑不带；专辑里的曲目不带 */
  const ts = { id: 41, title: 'River', artist: 'Joni', year: 1971 };
  assert.deepEqual(MU.trackEditBody(ts, { albumId: 31, single: true }, { title: 'River (Live)', artist: 'Joni', album: '0', lrc: null, year: 1972 }), { op: 'track.edit', id: 41, title: 'River (Live)', year: 1972 }, '单曲改名 + 年份：一个请求');
  assert.equal(MU.trackEditBody(ts, { albumId: 31, single: true }, { title: 'River', artist: 'Joni', album: '0', lrc: null, year: 1971 }), null, '年份没改');
  assert.deepEqual(MU.trackEditBody(ts, { albumId: 31, single: true }, { title: 'River', artist: 'Joni', album: '0', lrc: null, year: 0 }), { op: 'track.edit', id: 41, year: 0 }, '清空年份');
  assert.deepEqual(MU.trackEditBody(ts, { albumId: 31, single: true }, { title: 'River', artist: 'Joni', album: '1', lrc: null, year: 1972 }), { op: 'track.edit', id: 41, album_id: 1 }, '划进专辑不带年份');
  assert.deepEqual(MU.trackEditBody(t, { albumId: 1, single: false }, { title: 'B', artist: 'Joni', album: '1', lrc: null, year: 1999 }), { op: 'track.edit', id: 11, title: 'B' }, '专辑曲目不带年份');

  assert.equal(MU.lrcChange('', ''), null);
  assert.equal(MU.lrcChange('', '[00:01]x'), '[00:01]x');
  assert.equal(MU.lrcChange('[00:01]x', '[00:01]x'), null);
  assert.equal(MU.lrcChange('[00:01]x', ''), '', '清空歌词');
  assert.equal(MU.lrcChange(null, '  '), null, '有歌词但没读出来：空着不改');
  assert.equal(MU.lrcChange(null, '[00:02]y'), '[00:02]y');

  assert.equal(MU.yearOf(''), 0);
  assert.equal(MU.yearOf(' 1971 '), 1971);
  assert.equal(MU.yearOf('1899'), null);
  assert.equal(MU.yearOf('2101'), null);
  assert.equal(MU.yearOf('19.5'), null);

  const items = [{ trackId: 11, albumId: 1, name: 'A' }, { trackId: 12, albumId: 1, name: 'B' }];
  assert.deepEqual(MU.batchRequests(items, { artist: '', album: '', year: '' }, false), [], '都不改');
  assert.deepEqual(MU.batchRequests(items, { artist: ' X ', album: '2', year: 2000 }, false), [
    { name: 'A', body: { op: 'track.edit', id: 11, artist: 'X', album_id: 2 } },
    { name: 'B', body: { op: 'track.edit', id: 12, artist: 'X', album_id: 2 } },
  ], '专辑页：年份不发（曲目跟专辑走）');
  assert.deepEqual(MU.batchRequests(items, { artist: '', album: '1', year: '' }, false), [], '移到本来那张 = 不改');
  assert.deepEqual(MU.batchRequests(items, { artist: '', album: '0', year: '' }, false).map((x) => x.body.album_id), [0, 0], '移出变单曲');
  const singles = [{ trackId: 41, albumId: 31, name: 'River' }, { trackId: 42, albumId: 32, name: '晴天' }];
  assert.deepEqual(MU.batchRequests(singles, { artist: '周杰伦', album: '', year: 2003 }, true), [
    { name: 'River', body: { op: 'track.edit', id: 41, artist: '周杰伦', year: 2003 } },
    { name: '晴天', body: { op: 'track.edit', id: 42, artist: '周杰伦', year: 2003 } },
  ], '单曲：歌手 + 年份一个 track.edit（不发 album.edit）');
  assert.deepEqual(MU.batchRequests(singles, { artist: '', album: '', year: 2003 }, true).map((x) => x.body), [
    { op: 'track.edit', id: 41, year: 2003 }, { op: 'track.edit', id: 42, year: 2003 },
  ], '单曲只改年份：也是 track.edit');
  assert.deepEqual(MU.batchRequests(singles, { artist: '', album: '', year: 0 }, true).map((x) => x.body.year), [0, 0], '年份清空 = 0 也发');
  assert.deepEqual(MU.batchRequests(singles, { artist: '周杰伦', album: '', year: '' }, true).map((x) => x.body), [
    { op: 'track.edit', id: 41, artist: '周杰伦' }, { op: 'track.edit', id: 42, artist: '周杰伦' },
  ], '单曲只改歌手：不带 year');
  for (const f of [{ artist: 'A', album: '', year: 2003 }, { artist: '', album: '1', year: 2003 }, { artist: 'A', album: '', year: '' }]) {
    for (const x of MU.batchRequests(singles, f, true)) assert.equal(x.body.op, 'track.edit', '单曲批量改只发 track.edit');
  }
  assert.deepEqual(MU.batchRequests(singles, { artist: '', album: '1', year: 2003 }, true).map((x) => x.body), [
    { op: 'track.edit', id: 41, album_id: 1 }, { op: 'track.edit', id: 42, album_id: 1 },
  ], '单曲划进专辑：年份不发（单曲记录会删）');
  assert.deepEqual(MU.batchRequests(singles, { artist: '', album: '0', year: '' }, true), [], '单曲没有「移出变单曲」');
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

test('分页条：「-- 已显示 / 共 --」，页大小桌面 12 / 手机 8；分区 tab 计数随 tab 行删了（奇趣重组 PR 2）', () => {
  assert.equal(CL.countText(12, 42), '-- 12 / 42 --');
  assert.equal(CL.countText(12, 5), '-- 5 / 5 --');
  assert.equal(CL.countText(3, 9, '{n} of {total}'), '3 of 9');
  assert.equal(CL.pageSize(true), 12);
  assert.equal(CL.pageSize(false), 8);
  assert.equal(CL.countSources, undefined, 'tab 计数（问别的分区接口）删了');
});
