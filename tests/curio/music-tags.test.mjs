/* 音乐上传预填（space/web/assets/music/js/music-tags.js；音乐分层方案 v1.19 7.4 / 十二 M2 第 1 条，M2 PR-a）：
   文件名清理 + 拆歌手 / 歌名；自己写的读标签（ID3v2.3 / 2.4 / 2.2、ID3v1、FLAC Vorbis 注释 + 内嵌封面）；读不出来不抛错；
   预填（标签优先、文件名兜底）；新建专辑歌手取多数。真文件在 fixtures/music-tags（ffmpeg 生成，gen.sh），边角情况用手拼的字节。
   上传计划（music-page.js uploadPlan）也在这里。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const TG = require('../../space/web/assets/music/js/music-tags.js');
const MU = require('../../space/web/assets/music/js/music-page.js');
const fx = (n) => readFileSync(new URL('./fixtures/music-tags/' + n, import.meta.url));
const COVER = fx('cover.jpg');

/* ---------- 手拼 ID3v2 ---------- */
const ss = (n) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
const be = (n) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const utf16le = (s) => { const b = Buffer.alloc(s.length * 2); for (let i = 0; i < s.length; i++) b.writeUInt16LE(s.charCodeAt(i), i * 2); return b; };
const utf16be = (s) => { const b = Buffer.alloc(s.length * 2); for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), i * 2); return b; };
/** 一帧：ver 3 普通 32 位长度；ver 4 syncsafe（plain = true 时故意写成普通 32 位，模拟有问题的写法） */
function frame(id, data, { ver = 3, flags = [0, 0], plain = false } = {}) {
  const size = data.length;
  return Buffer.concat([Buffer.from(id, 'latin1'), Buffer.from(ver === 4 && !plain ? ss(size) : be(size)), Buffer.from(flags), data]);
}
const text = (enc, bytes) => Buffer.concat([Buffer.from([enc]), bytes]);
function tag(ver, frames, { flags = 0, pad = 16, ext = null } = {}) {
  const body = Buffer.concat([...(ext ? [ext] : []), ...frames, Buffer.alloc(pad)]);
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([ver, 0, flags]), Buffer.from(ss(body.length)), body]);
}
function unsync(b) { const out = []; for (let i = 0; i < b.length; i++) { out.push(b[i]); if (b[i] === 0xff && (i + 1 === b.length || b[i + 1] === 0 || b[i + 1] >= 0xe0)) out.push(0); } return Buffer.from(out); }

test('文件名清理（7.4）：去格式后缀、去末尾方括号标签；按第一个「 - 」拆歌手 / 歌名；没有「 - 」整段当歌名', () => {
  assert.equal(TG.cleanName('周杰伦 - 那天下雨了 [mqms2].flac'), '周杰伦 - 那天下雨了');
  assert.equal(TG.cleanName('a [mqms2] [320k].mp3'), 'a');
  assert.equal(TG.cleanName('dir/sub\\Song [x].MP3'), 'Song');
  assert.equal(TG.cleanName('[only].mp3'), '[only]', '整段都是方括号不去（不然就空了）');
  assert.equal(TG.cleanName('Mr. Brightside.mp3'), 'Mr. Brightside', '只去最后的格式后缀');
  assert.equal(TG.cleanName('a [b] c.mp3'), 'a [b] c', '只去末尾的方括号');
  assert.deepEqual(TG.splitArtistTitle('周杰伦 - 那天下雨了'), { artist: '周杰伦', title: '那天下雨了' });
  assert.deepEqual(TG.splitArtistTitle('A - B - C'), { artist: 'A', title: 'B - C' }, '按第一个拆');
  assert.deepEqual(TG.splitArtistTitle('AC-DC Live'), { artist: '', title: 'AC-DC Live' }, '没有前后带空格的「 - 」');
  assert.deepEqual(TG.splitArtistTitle(' - x'), { artist: '', title: '- x' });
  assert.deepEqual(TG.fromFileName('周杰伦 - 那天下雨了 [mqms2].flac'), { no: 0, artist: '周杰伦', title: '那天下雨了' });
  /* 曲序：带符号的总去；只隔空格的只在批量时去（单首「7 Rings」不该变「Rings」） */
  assert.deepEqual(TG.fromFileName('01 - 周杰伦 - 晴天.mp3', { batch: true }), { no: 1, artist: '周杰伦', title: '晴天' });
  assert.deepEqual(TG.fromFileName('03. Help Me.wav', { fallback: 9 }), { no: 3, artist: '', title: 'Help Me' });
  assert.deepEqual(TG.fromFileName('7 Rings.mp3', { fallback: 1 }), { no: 1, artist: '', title: '7 Rings' });
  assert.deepEqual(TG.fromFileName('02 Song.mp3', { batch: true, fallback: 5 }), { no: 2, artist: '', title: 'Song' });
  assert.equal(TG.fromFileName('x'.repeat(200) + '.mp3').title.length, 120, '单行上限 120');
});

test('真文件（ffmpeg 生成）：ID3v2.3（UTF-16 + 内嵌封面）、ID3v2.3 Latin-1、ID3v2.4 UTF-8、只有 ID3v1（Latin-1 / GBK）、FLAC Vorbis + PICTURE、没标签', async () => {
  const read = (n) => TG.readTags(new Blob([fx(n)]));
  const a = await read('v23-cover.mp3');
  assert.equal(a.title, '那天下雨了'); assert.equal(a.artist, '周杰伦');
  assert.equal(a.picture.mime, 'image/jpeg'); assert.equal(a.picture.type, 3);
  assert.deepEqual(Buffer.from(a.picture.bytes), COVER, '内嵌封面原样取出');
  assert.deepEqual(await read('v23-latin1.mp3'), { title: 'Rainy Day', artist: 'Jay Chou', picture: null });
  assert.deepEqual(await read('v24.mp3'), { title: '晴天', artist: '周杰伦', picture: null });
  assert.deepEqual(await read('v1.mp3'), { title: 'Only V1', artist: 'Old Artist', picture: null });
  assert.deepEqual(await read('v1-gbk.mp3'), { title: '七里香', artist: '周杰伦', picture: null }, 'ID3v1 里的 GBK 认成中文');
  const f = await read('tagged.flac');
  assert.equal(f.title, '稻香'); assert.equal(f.artist, '周杰伦');
  assert.deepEqual(Buffer.from(f.picture.bytes), COVER);
  assert.deepEqual(await read('notag.mp3'), { title: '', artist: '', picture: null });
  assert.deepEqual(await read('notag.flac'), { title: '', artist: '', picture: null });
  /* 同步的整块解析与按块读一致 */
  assert.equal(TG.parseFlac(fx('tagged.flac')).title, '稻香');
  assert.equal(TG.parseId3v2(fx('v24.mp3')).artist, '周杰伦');
  assert.equal(TG.parseId3v1(fx('v1.mp3').subarray(-128)).title, 'Only V1');
});

test('ID3v2 编码 0–3：UTF-16 带 BOM（小端 / 大端）、UTF-16BE 无 BOM、UTF-8；编码 0 里的 UTF-8 / GBK 也认；2.4 多值取第一个', () => {
  const t = (fr, ver = 3) => TG.parseId3v2(tag(ver, fr));
  assert.equal(t([frame('TIT2', text(1, Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le('晴天'), Buffer.from([0, 0])])))]).title, '晴天');
  assert.equal(t([frame('TIT2', text(1, Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be('晴天')])))]).title, '晴天');
  assert.equal(t([frame('TIT2', text(2, utf16be('稻香')), { ver: 4 })], 4).title, '稻香');
  assert.equal(t([frame('TIT2', text(3, Buffer.from('七里香\0', 'utf8')), { ver: 4 })], 4).title, '七里香');
  assert.equal(t([frame('TPE1', text(0, Buffer.from('Beyonc\xe9', 'latin1')))]).artist, 'Beyoncé', '真 Latin-1');
  assert.equal(t([frame('TPE1', text(0, Buffer.from('周杰伦', 'utf8')))]).artist, '周杰伦', '编码 0 里写的 UTF-8');
  assert.equal(t([frame('TPE1', text(0, Buffer.from([0xd6, 0xdc, 0xbd, 0xdc, 0xc2, 0xd7])))]).artist, '周杰伦', '编码 0 里写的 GBK');
  assert.equal(t([frame('TPE1', text(3, Buffer.from('\0A\0B', 'utf8')), { ver: 4 })], 4).artist, 'A', '多值取第一个非空的');
  assert.equal(t([frame('TPE1', text(3, Buffer.from('  a \n  b ', 'utf8')), { ver: 4 })], 4).artist, 'a b', '单行清理');
});

test('ID3v2 结构：整签去同步（2.3）、逐帧去同步（2.4）、扩展头（2.3 / 2.4）、2.4 写成普通 32 位的帧长、压缩 / 加密帧跳过、分组字节、ID3v2.2', () => {
  /* 2.3 整签去同步：UTF-16LE「ÿ」= FF 00 会被插 00 */
  const body = Buffer.concat([frame('TIT2', text(1, Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le('\u00ffx')]))), frame('TPE1', text(0, Buffer.from('A')))]);
  const us = unsync(body);
  assert.ok(us.length > body.length);
  const t23 = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0x80]), Buffer.from(ss(us.length)), us]);
  assert.deepEqual(TG.parseId3v2(t23), { title: '\u00ffx', artist: 'A', picture: null });
  /* 2.4 逐帧去同步（帧标志 0x02） */
  const raw = text(1, Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le('\u00ffy')]));
  const f24 = frame('TIT2', unsync(raw), { ver: 4, flags: [0, 0x02] });
  assert.equal(TG.parseId3v2(tag(4, [f24])).title, '\u00ffy');
  /* 扩展头：2.3 长度不含自己（4 字节 + 6）；2.4 syncsafe 含自己 */
  const ext23 = Buffer.from([...be(6), 0, 0, 0, 0, 0, 0]);
  assert.equal(TG.parseId3v2(tag(3, [frame('TIT2', text(0, Buffer.from('E3')))], { flags: 0x40, ext: ext23 })).title, 'E3');
  const ext24 = Buffer.from([...ss(6), 1, 0]);
  assert.equal(TG.parseId3v2(tag(4, [frame('TIT2', text(3, Buffer.from('E4')), { ver: 4 })], { flags: 0x40, ext: ext24 })).title, 'E4');
  /* 2.4 帧长写成普通 32 位（≥ 128 字节时两种读法不同）：看哪种后面接得上下一帧 */
  const long = 'x'.repeat(200);
  const bad = tag(4, [frame('TIT2', text(3, Buffer.from(long)), { ver: 4, plain: true }), frame('TPE1', text(3, Buffer.from('P')), { ver: 4 })]);
  assert.deepEqual(TG.parseId3v2(bad), { title: 'x'.repeat(120), artist: 'P', picture: null });
  /* 压缩 / 加密的帧跳过，后面的照读；分组字节去掉 */
  const skip = tag(3, [frame('TIT2', text(0, Buffer.from('zz')), { flags: [0, 0x80] }), frame('TPE1', Buffer.concat([Buffer.from([7]), text(0, Buffer.from('G'))]), { flags: [0, 0x20] }), frame('TIT2', text(0, Buffer.from('ok')))]);
  assert.deepEqual(TG.parseId3v2(skip), { title: 'ok', artist: 'G', picture: null });
  const skip4 = tag(4, [frame('TIT2', text(3, Buffer.from('zz')), { ver: 4, flags: [0, 0x04] }), frame('TIT2', Buffer.concat([Buffer.from(ss(3)), text(3, Buffer.from('DL'))]), { ver: 4, flags: [0, 0x01] })]);
  assert.equal(TG.parseId3v2(skip4).title, 'DL', '加密跳过；数据长度 4 字节去掉');
  /* ID3v2.2：三字母帧、三字节长度 */
  const f22 = (id, d) => Buffer.concat([Buffer.from(id), Buffer.from([0, 0, d.length]), d]);
  const pic22 = Buffer.concat([Buffer.from([0]), Buffer.from('JPG'), Buffer.from([3]), Buffer.from('d\0'), COVER.subarray(0, 100)]);
  const t22 = Buffer.concat([Buffer.from('ID3'), Buffer.from([2, 0, 0]), Buffer.from(ss(200)), f22('TT2', text(0, Buffer.from('v22'))), f22('TP1', text(0, Buffer.from('old'))), f22('PIC', pic22), Buffer.alloc(200)]);
  const r22 = TG.parseId3v2(t22);
  assert.equal(r22.title, 'v22'); assert.equal(r22.artist, 'old'); assert.equal(r22.picture.mime, 'image/jpeg');
});

test('APIC：前封面（类型 3）优先；外链（-->）不要；UTF-16 描述的结尾按两字节找', () => {
  const apic = (type, desc, enc = 0, mime = 'image/jpeg') => frame('APIC', Buffer.concat([Buffer.from([enc]), Buffer.from(mime + '\0', 'latin1'), Buffer.from([type]), desc, COVER]));
  const r = TG.parseId3v2(tag(3, [apic(0, Buffer.from('other\0')), apic(3, Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le('front'), Buffer.from([0, 0])]), 1)]));
  assert.equal(r.picture.type, 3);
  assert.deepEqual(Buffer.from(r.picture.bytes), COVER);
  assert.equal(TG.parseId3v2(tag(3, [apic(3, Buffer.from('\0'), 0, '-->')])).picture, null);
  assert.equal(TG.parseId3v2(tag(3, [apic(3, Buffer.from('\0'), 0, 'image/jpg')])).picture.mime, 'image/jpeg');
  assert.equal(TG.parseId3v2(tag(3, [apic(3, Buffer.from('\0'), 0, '')])).picture.mime, 'image/jpeg', '没写类型看字节');
});

test('尽力而为：截断、乱码、不是标签都不抛错；readTags 永远 resolve（坏 Blob 也一样）；ID3v2 缺的栏用 ID3v1 补；flac 前挂 ID3v2 时 Vorbis 优先', async () => {
  const full = tag(3, [frame('TIT2', text(0, Buffer.from('cut here')))]);
  for (let n = 0; n < full.length; n++) assert.doesNotThrow(() => TG.parseId3v2(full.subarray(0, n)));
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
  for (let k = 0; k < 300; k++) {
    const junk = Buffer.from(Array.from({ length: 64 + (k % 200) }, rnd));
    if (k % 3 === 0) junk.write('ID3', 0, 'latin1'); else if (k % 3 === 1) junk.write('fLaC', 0, 'latin1');
    assert.doesNotThrow(() => { TG.parseId3v2(junk); TG.parseFlac(junk); TG.parseId3v1(junk); });
    const r = await TG.readTags(new Blob([junk]));
    assert.equal(typeof r.title, 'string');
  }
  assert.equal(TG.parseId3v2(Buffer.from('hello world')), null);
  assert.deepEqual(await TG.readTags(null), { title: '', artist: '', picture: null });
  const broken = { size: 100, slice() { return { arrayBuffer: () => Promise.reject(new Error('io')) }; } };
  assert.deepEqual(await TG.readTags(broken), { title: '', artist: '', picture: null });
  /* v2 只有歌名、v1 有歌手 → 拼起来 */
  const v1 = fx('v1.mp3').subarray(-128);
  const mix = Buffer.concat([tag(3, [frame('TIT2', text(0, Buffer.from('From V2')))]), fx('notag.mp3'), v1]);
  assert.deepEqual(await TG.readTags(new Blob([mix])), { title: 'From V2', artist: 'Old Artist', picture: null });
  /* flac 前面挂了 ID3v2 */
  const both = Buffer.concat([tag(3, [frame('TIT2', text(0, Buffer.from('id3 title'))), frame('TPE1', text(0, Buffer.from('id3 artist')))]), fx('tagged.flac')]);
  const r = await TG.readTags(new Blob([both]));
  assert.equal(r.title, '稻香'); assert.equal(r.artist, '周杰伦');
});

test('预填：每一栏标签优先，没有再用文件名；新建专辑歌手取多数，平票取第一首的', () => {
  const QQ = '周杰伦 - 那天下雨了 [mqms2].flac';
  assert.deepEqual(TG.prefill(QQ, null), { no: 0, title: '那天下雨了', artist: '周杰伦' });
  assert.deepEqual(TG.prefill(QQ, { title: '那天下雨了 (Live)', artist: 'Jay Chou' }), { no: 0, title: '那天下雨了 (Live)', artist: 'Jay Chou' }, '标签优先（标签里的方括号不去）');
  assert.deepEqual(TG.prefill(QQ, { title: 'T', artist: '' }), { no: 0, title: 'T', artist: '周杰伦' }, '标签没歌手 → 文件名的');
  assert.deepEqual(TG.prefill('01 - x.mp3', { title: '', artist: 'A' }, { batch: true }), { no: 1, title: 'x', artist: 'A' });
  assert.equal(TG.majorityArtist(['a', 'b', 'b', 'c']), 'b');
  assert.equal(TG.majorityArtist(['a', 'b', 'b', 'a']), 'a', '平票取第一首的');
  assert.equal(TG.majorityArtist(['', 'b', 'a']), 'b', '第一首没歌手：平票的几位里先出现的');
  assert.equal(TG.majorityArtist([' a ', 'a', 'b']), 'a', '按清理后的名字算');
  assert.equal(TG.majorityArtist(['', '']), '');
});

/* ---------- 上传计划（music-page.js uploadPlan） ---------- */
const LIST = [
  { id: 1, kind: 'album', title: '叶惠美', artist: '周杰伦', tracks: [{ id: 11, no: 1 }, { id: 12, no: 7 }] },
  { id: 41, kind: 'single', title: '稻香', artist: '周杰伦', tracks: [{ id: 51, no: 1 }] },
];
const F = (name, tags = null) => ({ name, tags });

test('上传计划·单首：歌名必填；不划 = 单曲（年份写单曲、封面选的 / 内嵌）；新建专辑（专辑封面）；已有专辑接在最后、不传封面', () => {
  const base = { mode: 'one', name: '那天下雨了', artist: '周杰伦', year: 2010, files: [F('a.flac', { picture: true })], covers: [], lrcs: ['x.lrc'] };
  assert.deepEqual(MU.uploadPlan({ ...base, name: ' ' }, LIST), { error: 'needSong' });
  assert.deepEqual(MU.uploadPlan({ ...base, files: [] }, LIST), { error: 'needAudio' });
  const s = MU.uploadPlan({ ...base, target: '0' }, LIST);
  assert.equal(s.album, null); assert.equal(s.singleYear, 2010);
  assert.deepEqual(s.tracks, [{ file: 0, no: 1, title: '那天下雨了', artist: '周杰伦', lrc: 0, cover: -1, embedded: true }]);
  assert.deepEqual(MU.uploadPlan({ ...base, covers: ['c.jpg'] }, LIST).tracks[0].cover, 0, '选了封面就不用内嵌的');
  assert.equal(MU.uploadPlan({ ...base, covers: ['c.jpg'] }, LIST).tracks[0].embedded, false);
  assert.deepEqual(MU.uploadPlan({ ...base, target: 'new' }, LIST), { error: 'needAlbumName' });
  assert.equal(MU.uploadPlan({ ...base, name: '', target: 'new', preview: true }, LIST).tracks.length, 1, '预览（右栏 / 多数歌手）不查名字');
  const n = MU.uploadPlan({ ...base, target: 'new', albumName: '新专辑' }, LIST);
  assert.deepEqual(n.album, { add: { title: '新专辑', artist: '周杰伦', year: 2010 } });
  assert.deepEqual(n.albumCover, { embedded: 0 });
  assert.equal(n.tracks[0].no, 1); assert.equal(n.tracks[0].cover, -1);
  const e = MU.uploadPlan({ ...base, target: '1' }, LIST);
  assert.deepEqual(e.album, { id: 1, title: '叶惠美', artist: '周杰伦' });
  assert.equal(e.albumCover, null); assert.equal(e.tracks[0].no, 8, '接在最后（max(no)+1）'); assert.equal(e.tracks[0].embedded, false);
  assert.deepEqual(MU.uploadPlan({ ...base, target: '41' }, LIST), { error: 'albumGone' }, '单曲记录不能当专辑选');
});

test('上传计划·批量：每首按标签 / 文件名预填；不划 = 每首一条单曲、封面 / 歌词按文件名对上、没对上的列出来；新建专辑取文件名曲序、没歌手的用专辑歌手；已有专辑接在最后', () => {
  const files = [F('01 - 周杰伦 - 那天下雨了 [mqms2].mp3'), F('02.flac', { title: '稻香', artist: '周杰伦', picture: true }), F('03 晴天.mp3', { title: '晴天', artist: '' })];
  const b = { mode: 'batch', files, covers: ['01 - 周杰伦 - 那天下雨了 [mqms2].jpg', 'stray.png'], lrcs: ['晴天.lrc', '02.LRC', 'nope.lrc'] };
  const s = MU.uploadPlan({ ...b, target: '0' }, LIST);
  assert.equal(s.album, null);
  assert.deepEqual(s.tracks.map((t) => [t.no, t.title, t.artist, t.lrc, t.cover, t.embedded]), [
    [1, '那天下雨了', '周杰伦', -1, 0, false],
    [1, '稻香', '周杰伦', 1, -1, true],
    [1, '晴天', '', 0, -1, false],
  ]);
  assert.deepEqual(s.unmatched, { lrc: ['nope.lrc'], cover: ['stray.png'] });
  const n = MU.uploadPlan({ ...b, target: 'new', albumName: '合集', artist: '周杰伦', year: 0 }, LIST);
  assert.deepEqual(n.album.add, { title: '合集', artist: '周杰伦', year: 0 });
  assert.deepEqual(n.tracks.map((t) => [t.no, t.artist, t.cover]), [[1, '周杰伦', -1], [2, '周杰伦', -1], [3, '周杰伦', -1]], '没歌手的用专辑歌手；曲目不带封面');
  assert.deepEqual(n.albumCover, { pick: 0 }, '新建专辑：选的第一张当专辑封面');
  assert.deepEqual(n.unmatched.cover, [], '新建专辑不按文件名对封面');
  assert.deepEqual(MU.uploadPlan({ ...b, covers: [], target: 'new', albumName: 'x' }, LIST).albumCover, { embedded: 1 }, '没选就用第一首有内嵌封面的');
  const e = MU.uploadPlan({ ...b, target: '1' }, LIST);
  assert.deepEqual(e.tracks.map((t) => [t.no, t.artist]), [[8, '周杰伦'], [9, '周杰伦'], [10, '周杰伦']]);
  assert.equal(e.albumCover, null);
  assert.equal(MU.matchKey('A [mqms2].FLAC'), 'a');
});

test('封面裁切常量（十二 M2 第 3 条）：≤ 1000 的正方形 jpeg，3 MB 上限，超了降质量', () => {
  assert.deepEqual(MU.squareCrop(1600, 900, 1000), { sx: 350, sy: 0, side: 900, out: 900 });
  assert.deepEqual(MU.squareCrop(3000, 4000, 1000), { sx: 0, sy: 500, side: 3000, out: 1000 });
  assert.equal(MU.COVER_MAX, 3 * 1024 * 1024);
  assert.ok(MU.COVER_Q[0] === 0.86 && MU.COVER_Q.every((q, i, a) => i === 0 || q < a[i - 1]));
  const src = readFileSync(new URL('../../space/web/assets/music/js/music-page.js', import.meta.url), 'utf8');
  assert.ok(!/1600/.test(src) && !/image\/webp/.test(src), '不再缩到 1600 / 转 webp');
  assert.match(src, /var cropAvatar = cropCover;/, '头像和封面同一套裁切');
});
