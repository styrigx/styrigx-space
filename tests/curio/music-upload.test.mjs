/* 音乐上传 PR-b（音乐分层方案 v1.19 7.4「批量传到一半失败」/ 十二 M2 第 1、4 条）的纯函数（space/web/assets/curio/js/curio-music.js）：
   并发 2、进度百分比、去重提醒（歌名 + 歌手 + 时长 / 歌名 + 大小）、失败原因、能接着用的空单曲记录、拖放分类、没对上的歌词 / 封面手动配对。
   上传任务本身（每首状态、只重试失败、XHR 进度、拖放）在 e2e tests/curio/e2e/curio-music-upload.spec.js。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const MU = require('../../space/web/assets/curio/js/curio-music.js');
const SRC = readFileSync(new URL('../../space/web/assets/curio/js/curio-music.js', import.meta.url), 'utf8');

const t = (id, no, title, extra = {}) => ({ id, no, title, duration: 200, size: 1000, type: 'audio/mpeg', lrc: false, artist: '', artist_id: 0, ...extra });
const LIST = [
  { id: 1, kind: 'album', title: '叶惠美', artist: '周杰伦', artist_id: 5, tracks: [t(11, 1, '晴天', { artist: '周杰伦', duration: 269, size: 5000 }), t(12, 2, '以父之名')] },
  { id: 41, kind: 'single', title: '稻香', artist: '周杰伦', artist_id: 5, tracks: [t(51, 1, '稻香', { artist: '周杰伦', duration: 223, size: 7000 })] },
  { id: 42, kind: 'single', title: '空的', artist: 'A', artist_id: 0, tracks: [] },
  { id: 43, kind: 'single', title: '空的', artist: 'A', artist_id: 0, tracks: [] },
  { id: 44, kind: 'album', title: '空专辑', artist: 'A', artist_id: 0, tracks: [] },
];

test('并发 2；进度百分比在服务器回话之前最多 99', () => {
  assert.equal(MU.UP_CONC, 2);
  assert.equal(MU.pctOf(0, 100), 0);
  assert.equal(MU.pctOf(45, 100), 45);
  assert.equal(MU.pctOf(100, 100), 99, '字节传完还要等后端写 R2 / D1');
  assert.equal(MU.pctOf(5, 0), 0);
  assert.equal(MU.pctOf(1, 3), 33);
});

test('去重提醒：歌名一样 + 歌手一样 + 时长差 ≤ 1 秒，或歌名一样 + 大小一样；不分大小写 / 空白；曲目没歌手看专辑的', () => {
  assert.deepEqual(MU.dupOf({ title: '晴天', artist: '周杰伦', duration: 270, size: 1 }, LIST), { title: '晴天', artist: '周杰伦', album: '叶惠美' });
  assert.equal(MU.dupOf({ title: '晴天', artist: '周杰伦', duration: 272, size: 1 }, LIST), null, '时长差 3 秒不算');
  assert.equal(MU.dupOf({ title: '晴天', artist: '别人', duration: 269, size: 1 }, LIST), null, '歌手不一样不算');
  assert.deepEqual(MU.dupOf({ title: ' 晴 天 ', artist: '', duration: 0, size: 5000 }, LIST), { title: '晴天', artist: '周杰伦', album: '叶惠美' }, '歌名 + 大小');
  assert.equal(MU.dupOf({ title: '晴天', artist: '周杰伦', duration: 0, size: 1 }, LIST), null, '时长不知道、大小不同：不算');
  assert.deepEqual(MU.dupOf({ title: '稻香', artist: '周杰伦', duration: 223, size: 1 }, LIST), { title: '稻香', artist: '周杰伦', album: '' }, '单曲 album 空');
  assert.deepEqual(MU.dupOf({ title: '以父之名', artist: '周杰伦', duration: 200, size: 1 }, LIST), { title: '以父之名', artist: '周杰伦', album: '叶惠美' }, '曲目没歌手用专辑歌手');
  assert.equal(MU.dupOf({ title: '', artist: '', duration: 0, size: 1000 }, LIST), null, '没有歌名不比');
  assert.equal(MU.dupOf({ title: '新歌', artist: '周杰伦', duration: 200, size: 1000 }, LIST), null);
});

test('失败原因 → 文案键', () => {
  assert.equal(MU.upReason({ sgxLocked: true }), 'whyLocked');
  assert.equal(MU.upReason({ code: 'network' }), 'whyNetwork');
  assert.equal(MU.upReason({ code: 'too-large' }), 'whyTooLarge');
  assert.equal(MU.upReason({ code: 'limit' }), 'errLimit');
  assert.equal(MU.upReason({ code: 'single-full' }), 'singleFull');
  assert.equal(MU.upReason({ code: 'not-found' }), 'whyAlbumGone');
  assert.equal(MU.upReason({ code: 'forbidden' }), 'noPermission');
  assert.equal(MU.upReason({ code: 'cover' }), 'whyCover');
  assert.equal(MU.upReason({ code: 'edit' }), 'whyEdit');
  assert.equal(MU.upReason({ code: 'internal' }), 'whyOther');
  assert.equal(MU.upReason(null), 'whyOther');
  /* 每个键 zh / en 都有 */
  for (const lang of ['zh', 'en']) {
    const y = readFileSync(new URL(`../../space/web/data/curio/i18n/${lang}.yaml`, import.meta.url), 'utf8');
    const sec = y.slice(y.indexOf('  curioMusic:'));
    for (const k of ['whyLocked', 'whyNetwork', 'whyTooLarge', 'whyNotAudio', 'errLimit', 'singleFull', 'whyAlbumGone', 'whyStorage', 'noPermission', 'whyCover', 'whyEdit', 'whyAlbum', 'whyAlbumCover', 'whyOther'])
      assert.match(sec, new RegExp('\\n    ' + k + ': '), lang + ' ' + k);
  }
});

test('能接着用的空单曲记录：没有曲目、歌名歌手都一样、这次没占用；专辑不算', () => {
  assert.equal(MU.emptySingle(LIST, '空的', 'A', {}), 42);
  assert.equal(MU.emptySingle(LIST, ' 空的 ', 'A ', { 42: true }), 43, '同一批第二首用下一条');
  assert.equal(MU.emptySingle(LIST, '空的', 'A', { 42: true, 43: true }), 0);
  assert.equal(MU.emptySingle(LIST, '空的', 'B', {}), 0, '歌手不一样不用');
  assert.equal(MU.emptySingle(LIST, '稻香', '周杰伦', {}), 0, '有曲目的不用');
  assert.equal(MU.emptySingle(LIST, '空专辑', 'A', {}), 0, '空专辑不当单曲');
});

test('拖放分类：音频（按类型 / 扩展名）、.lrc、图片，别的不认识', () => {
  const f = (name, type = '') => ({ name, type });
  const k = MU.dropKinds([f('a.mp3', 'audio/mpeg'), f('b.FLAC'), f('a.lrc', 'text/plain'), f('c.jpg'), f('d.png', 'image/png'), f('e.webp'), f('notes.txt', 'text/plain'), f('x.pdf', 'application/pdf')]);
  assert.deepEqual(k.audio.map((x) => x.name), ['a.mp3', 'b.FLAC']);
  assert.deepEqual(k.lrc.map((x) => x.name), ['a.lrc']);
  assert.deepEqual(k.cover.map((x) => x.name), ['c.jpg', 'd.png', 'e.webp']);
  assert.deepEqual(k.other.map((x) => x.name), ['notes.txt', 'x.pdf']);
  assert.deepEqual(MU.dropKinds(null), { audio: [], lrc: [], cover: [], other: [] });
});

test('手动配对：没对上的歌词 / 封面配给某一首；先占位再按文件名对；一首只认第一个；新建 / 已有专辑不按首配封面', () => {
  const F = (name) => ({ name, tags: null });
  const files = [F('01 a.mp3'), F('02 b.mp3'), F('03 c.mp3')];
  const b = { mode: 'batch', target: '0', files, covers: ['a.jpg', 'zzz.png'], lrcs: ['b.lrc', 'stray.lrc'] };
  const auto = MU.uploadPlan(b, LIST);
  assert.deepEqual(auto.tracks.map((x) => [x.lrc, x.cover]), [[-1, 0], [0, -1], [-1, -1]]);
  assert.deepEqual(auto.unmatched, { lrc: ['stray.lrc'], cover: ['zzz.png'] });
  const man = MU.uploadPlan({ ...b, pairs: { lrc: { 1: 2 }, cover: { 1: 2 } } }, LIST);
  assert.deepEqual(man.tracks.map((x) => [x.lrc, x.cover]), [[-1, 0], [0, -1], [1, 1]]);
  assert.deepEqual(man.unmatched, { lrc: [], cover: [] });
  /* 手动把自动对上的那首抢走：原来那个文件就空出来、列进没对上 */
  const steal = MU.uploadPlan({ ...b, pairs: { lrc: { 1: 1 } } }, LIST);
  assert.equal(steal.tracks[1].lrc, 1);
  assert.deepEqual(steal.unmatched.lrc, ['b.lrc']);
  /* 一首只认第一个配给它的；越界的不认 */
  const two = MU.uploadPlan({ ...b, pairs: { lrc: { 0: 2, 1: 2, 5: 0 } } }, LIST);
  assert.equal(two.tracks[2].lrc, 0);
  assert.deepEqual(two.unmatched.lrc, ['stray.lrc']);
  assert.equal(MU.uploadPlan({ ...b, pairs: { lrc: { 1: -1 } } }, LIST).tracks[2].lrc, -1, '-1 = 不配');
  const into = MU.uploadPlan({ ...b, target: '1', pairs: { cover: { 1: 2 }, lrc: { 1: 2 } } }, LIST);
  assert.deepEqual(into.tracks.map((x) => x.cover), [-1, -1, -1], '划进已有专辑不传封面');
  assert.equal(into.tracks[2].lrc, 1, '歌词照样能配');
  assert.deepEqual(MU.applyPairs({ 0: 1, 1: 1 }, 2, 3, {}), { 1: 0 });
});

test('上传走 XHR（拿得到进度），右栏不用 innerHTML 拼文件名', () => {
  assert.match(SRC, /new XMLHttpRequest\(\)/);
  assert.match(SRC, /x\.upload\.onprogress/);
  const a = SRC.indexOf('function upList('), b = SRC.indexOf('function upPrefill(');
  assert.ok(a > 0 && b > a);
  assert.ok(!/innerHTML/.test(SRC.slice(a, b)), 'upList / upPairUi 只用 DOM + textContent');
});
