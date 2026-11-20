/* assets/js/curio-music.js —— 奇趣「音乐」私人子页（P4-3 奇趣拆页：/curio/music/；浏览器 IIFE；node 测试时导出纯函数）。
 *
 * 三层（v5 S3；接口档在 workers/atlas-core/src/curio/routes.js ROUTE_ACCESS）：
 *   - 看：GET /curio/api/music 谁都能调（只有专辑 / 曲目元数据，没有音频地址）；回 canWrite（账号 + curio.write）才显示上传 / 删除专辑。
 *   - 听：要进站。没进站（网关标记 <html data-sgx-lock-session="locked">，或签令牌回 401）= 只看模式（html.mu-view-only）：
 *     播放整张 / 播放键是锁，播放条显示当前专辑和「未进站，仅可浏览」，上一首 / 下一首 / 倍速 / 进度不可用；
 *     点播放、点曲目都发 sgx:sudo（经 curio.js SgxCurioUI.sudo；= common/js/auth/sudo.js SUDO_EVENT），顶栏终端预填 su 。
 *   - 写的接口 401 同样按没进站处理。
 * 播放器（交互借 jojo.best/music 的思路，只借交互）：
 *   - 封面横滑切专辑（scroll-snap，停下来的那张是当前专辑；点封面也能切），下面是这张的曲目（按曲序）。
 *   - 「播放整张」从第 1 首按曲序放到最后一首；点某一首从那首开始，放完接下一首。
 *   - 歌词：有 LRC 就在播放条里滚动，当前行高亮（parseLrc / lrcIndex）。
 *   - 倍速：0.75 → 1 → 1.25 → 1.5 → 2 → 0.75 循环（SPEEDS），换曲目也保持。
 *   - 随机播放（第二步 2b）：顺序 / 随机，模式记在 localStorage「sgx-music-mode」，和弹出播放器共用一个设置（方案 v1.13 §7.1）；
 *     另一个窗口改了（storage 事件）这边跟着变。随机的队列规则在共用核。
 * 播放短链：POST /curio/api/music-play {album} 签随机令牌（10 分钟），<audio src> = /curio/api/music-stream?t=…&id=…（Range 拖进度）。
 *   签令牌、续签、切曲、倍速、防同时响都在共用核 music-core.js（SgxMusicCore.createPlayer；弹出播放器同一份），本文件只画界面。
 * 上传（M2 PR-a 起，见「上传」一节）：分段「单首 | 批量」；歌名 / 歌手按音频标签（curio-music-tags.js）、没有再按文件名预填；单首选「不划 / 新建 / 已有专辑」，
 *   批量选「这批划入哪个专辑」；封面裁方、≤ 1000、jpeg；音频按文件名排序逐个直传（单个 ≤ 95 MB）→ 每首一个 track.edit 写歌手 / 歌词。
 * 单曲 / 专辑分类（音乐 v1.13 ②，Gray 2026-11-14 17:33 定）：
 *   - 列表每条带 kind；页面分段「专辑 · 单曲」（两边都有才显示分段，哪边为空只显示有的那边）。专辑 = 封面横滑照旧；
 *     单曲 = 列表（小封面 · 歌名 · 歌手 · 时长），点一行就播，单曲区当播放列表（共用核 playQueue：按需为下一首签令牌，顺序 / 随机、到尾停同专辑）。
 *   - 播放条副标题：单曲只显示歌手（共用核 nowSub）。
 * 歌手页（M4，音乐 v1.19 7.5 / 十二 M4）：
 *   - 不加新路由：本页 ?artist=<id> 视图（history.pushState 换视图，不重新加载，正在放的歌不断）；头部头像（没有用默认图标）、名字、
 *     专辑数和单曲数（有简介 / 风格才显示），下面专辑一区、单曲一区。点专辑回到音乐页那张专辑；单曲区点一首 = 这位歌手的单曲当播放列表。
 *   - 入口：专辑标题下的歌手名、单曲行的歌手名、播放条里的歌手名（链接 / data-artist）；弹出播放器里的歌手名经 BroadcastChannel 让主窗口切过来
 *     （顶栏 mountMusic 收 artist-go 发 sgx-music-artist 事件，本页接住就在页内换视图，不接就整页跳过来）。
 *   - 改歌手（能写才有「编辑」）：名字、风格、简介（artist.edit，curio-write）+ 头像（浏览器裁方、≤ 1000、jpeg，music-upload kind=avatar）；
 *     合并到另一个歌手（artist.merge）、删歌手（artist.del，名下没作品才能删）都是 root 档：先确认，再领一次性票（同删专辑）。
 *   - 单曲没封面：封面空 → 歌手头像 → 默认图（共用核 coverOf）。
 *   - 歌手栏联想（7.5「输入带联想」）：上传 / 编辑 / 批量改的歌手栏挂同一个 <datalist>（已有歌手）；输入和已有歌手只差大小写 / 空格时提示一句，可点一下换成已有的。
 * 确认框、提示条、弹层开关借 curio.js 的（window.SgxCurioUI）。
 */
(function(){
"use strict";
var G = typeof globalThis !== 'undefined' ? globalThis : this;

/* 播放用的纯函数（倍速、时间、歌词）在共用核 music-core.js，这里转出去（测试照旧从本文件取） */
var CORE = typeof module !== 'undefined' && module.exports ? require('../../common/js/music/music-core.js') : G.SgxMusicCore;
/* 上传预填（读标签、清理文件名，M2）在 curio-music-tags.js */
var TAGS = typeof module !== 'undefined' && module.exports ? require('./curio-music-tags.js') : G.SgxMusicTags;
var SPEEDS = CORE.SPEEDS, nextSpeed = CORE.nextSpeed, fmtTime = CORE.fmtTime, parseLrc = CORE.parseLrc, lrcIndex = CORE.lrcIndex;
/** 单个音频上限（同 workers/atlas-core/src/curio/api/_music.js MUSIC_LIMITS.trackBytes） */
var TRACK_MAX = 95 * 1024 * 1024;
var EXT_TYPES = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', wav: 'audio/wav', webm: 'audio/webm' };

/** 文件名 → 曲序和曲名：开头的数字是曲序（没有就用 fallback），去掉扩展名和「01 - 」这类前缀 */
function trackFromName(name, fallback){
  var base = String(name || '').replace(/\.[^./\\]+$/, '');
  var m = /^\s*(\d{1,3})(?:\s*[-._)\]]\s*|\s+)(\S.*)$/.exec(base);
  var no = m ? Number(m[1]) : fallback;
  var title = (m ? m[2] : base).trim();
  return { no: no, title: title };
}
/** 文件按名字自然排序（01 < 2 < 10） */
function sortByName(files){
  return Array.prototype.slice.call(files || []).sort(function(a, b){ return String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }); });
}
/** 上传用的音频类型：文件自带的，没有就按扩展名猜；不认识返回 '' */
function audioType(file){
  var t = String(file && file.type || '').toLowerCase();
  if (/^audio\//.test(t)) return t === 'audio/x-m4a' ? 'audio/mp4' : t;
  var ext = (/\.([a-z0-9]+)$/i.exec(String(file && file.name || '')) || [])[1];
  return EXT_TYPES[String(ext || '').toLowerCase()] || '';
}
/** 歌词文件对上曲目：同名（去扩展名、去曲序前缀后比，忽略大小写） */
function lrcKey(name){ return trackFromName(name, 0).title.toLowerCase(); }
/** 歌单分两边：kind=single 的是单曲，其余（含旧数据没 kind 的）是专辑；各自保持原顺序 */
function splitKinds(list){
  var out = { albums: [], singles: [] };
  (list || []).forEach(function(a){ (CORE.isSingle(a) ? out.singles : out.albums).push(a); });
  return out;
}
/** 该显示哪一边：想要的那边有内容就是它，否则有内容的那边；两边都空 = 'album'（显示空提示） */
function pickSection(want, nAlbums, nSingles){
  if (want === 'single' ? nSingles : nAlbums) return want === 'single' ? 'single' : 'album';
  return nAlbums ? 'album' : nSingles ? 'single' : 'album';
}

/* ---------- 导入后编辑（M3，音乐 v1.18 十二 M3 / 7.4 / 7.6）的纯函数 ---------- */
/** 「所属专辑」下拉：只列 kind=album（单曲不列，后端也拒绝移到单曲，十二 M3 第 2 条），按名排序（自然序、不分大小写；同名按 id） */
function albumChoices(list, lang){
  return (list || []).filter(function(a){ return !CORE.isSingle(a); })
    .map(function(a){ return { id: a.id, title: String(a.title || '') }; })
    .sort(function(x, y){ return x.title.localeCompare(y.title, lang || undefined, { numeric: true, sensitivity: 'base' }) || x.id - y.id; });
}
/** 歌词有没有改：orig = 读出来的原文（null = 有歌词但没读出来 → 只有填了东西才算改）；没改返回 null */
function lrcChange(orig, val){
  val = String(val == null ? '' : val);
  if (orig == null) return val.trim() ? val : null;
  return val === orig ? null : val;
}
/**
 * 编辑表单 → 一个 track.edit 请求（所有改动一次发，后端一个 batch 提交）；什么都没改返回 null。
 * t = 表单打开时显示的值 {id, title, artist, year（单曲记录的年份）}；cur = {albumId, single}；
 * f = {title, artist, album: 下拉的值（'0' = 移出变单曲 / 专辑 id）, lrc: lrcChange 的结果, year: yearOf 的结果（单曲才有）}。
 * 下拉停在原处（单曲停在顶项、曲目停在本专辑）= 不移，不带 album_id（后端对「移到本来那张」回 400，十一 第 5 条）。
 * 单曲：改名后端连单曲记录名一起改；year 只在单曲没移走时带（后端写单曲记录，专辑曲目 / 移专辑时 400）。都在同一个请求、同一个 batch（Gray 审 1、3）。
 */
function trackEditBody(t, cur, f){
  var b = { op: 'track.edit', id: t.id };
  var title = String(f.title == null ? '' : f.title).trim(), artist = String(f.artist == null ? '' : f.artist).trim();
  if (title && title !== String(t.title || '')) b.title = title;
  if (artist !== String(t.artist || '').trim()) b.artist = artist;
  if (f.lrc != null) b.lrc = f.lrc;
  if (f.album !== '' && f.album != null) {
    var to = Number(f.album);
    if (!(cur.single ? to === 0 : to === cur.albumId)) b.album_id = to;
  }
  if (cur.single && b.album_id === undefined && f.year != null && f.year !== (Number(t.year) || 0)) b.year = f.year;
  return Object.keys(b).length > 2 ? b : null;
}
/** 年份栏：空 = 0（不填）；1900–2100 的整数；不合格 null */
function yearOf(v){
  v = String(v == null ? '' : v).trim();
  if (!v) return 0;
  var n = Number(v);
  return Number.isInteger(n) && n >= 1900 && n <= 2100 ? n : null;
}
/**
 * 批量改（十二 M3 第 3 条）→ 每条一个 track.edit（前端逐条发，没有后端批量接口）。
 * items = [{trackId, albumId（所在专辑 / 单曲记录 id）, name}]；f = {artist: ''（= 不改）, album: ''（不改）/ '0'（移出变单曲）/ 专辑 id, year: ''（不改）/ 数字}；
 * singles = 单曲区：年份只对单曲，跟歌手一起放进同一个 track.edit（后端同一个 batch 写进单曲记录，跟单曲编辑窗一样，Gray 审）；
 * 单曲划进专辑时年份不发（记录会删）。没有要改的条目不出现。
 */
function batchRequests(items, f, singles){
  var artist = String(f.artist == null ? '' : f.artist).trim();
  var to = f.album === '' || f.album == null ? null : Number(f.album);
  var yr = singles && f.year !== '' && f.year != null ? Number(f.year) : null;
  var out = [];
  (items || []).forEach(function(it){
    var b = { op: 'track.edit', id: it.trackId };
    if (artist) b.artist = artist;
    if (to !== null && to !== it.albumId && !(singles && to === 0)) b.album_id = to;
    if (yr !== null && b.album_id === undefined) b.year = yr;
    if (Object.keys(b).length > 2) out.push({ name: it.name, body: b });
  });
  return out;
}

/* ---------- 歌手页（M4，音乐 v1.19 7.5 / 十二 M4）的纯函数 ---------- */
/** 地址里的 ?artist=<编号>；没有 / 不对 0 */
function artistOf(search){ var m = /[?&]artist=(\d+)(?:&|$)/.exec(String(search || '')); var n = m ? Number(m[1]) : 0; return n > 0 && n < 2147483648 ? n : 0; }
/** 某位歌手名下的作品（按专辑 / 单曲记录的 artist_id）：{albums, singles}，各自保持歌单顺序 */
function artistWorks(list, id){
  var out = { albums: [], singles: [] };
  if (!(id > 0)) return out;
  (list || []).forEach(function(a){ if (a.artist_id === id) (CORE.isSingle(a) ? out.singles : out.albums).push(a); });
  return out;
}
/**
 * 歌手页的诚实空状态（Gray 2026-11-20）：这位名下没有专辑 / 单曲，但别的歌手的专辑里收了 TA 的曲目 → 那些专辑（只算专辑，不算单曲记录），保持歌单顺序。
 * 专辑区本身仍只按专辑的 artist_id 列（同 artistWorks）。
 */
function relatedAlbums(list, id){
  if (!(id > 0)) return [];
  return (list || []).filter(function(a){
    return !CORE.isSingle(a) && a.artist_id !== id && (a.tracks || []).some(function(t){ return t.artist_id === id; });
  });
}
/** 比对用：小写、去掉所有空白 */
function artistKey(s){ return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ''); }
/**
 * 近似名提示（7.5「重名、近似名在入口就能拦住」）：输入和某位已有歌手只差大小写 / 空格（但不完全一样）→ 那位的名字；否则 ''。
 * 完全一样的就是同一个人（后端按名字对上），不提示；繁简不算（十一 第 4 条不做繁简合并）。
 */
function similarArtist(name, arts){
  var v = String(name == null ? '' : name).trim(), k = artistKey(v);
  if (!k) return '';
  for (var i = 0; arts && i < arts.length; i++) {
    var n = String(arts[i].name || '');
    if (n === v) return '';
  }
  for (var j = 0; arts && j < arts.length; j++) if (artistKey(arts[j].name) === k) return String(arts[j].name);
  return '';
}
/** 头像裁切（十二 M4 第 2 条，同封面一套）：取中间的正方形，边长缩到 ≤ max → {sx, sy, side（原图里取的边长）, out（输出边长）} */
function squareCrop(w, h, max){
  var side = Math.max(1, Math.min(w, h)), m = max || 1000;
  return { sx: Math.round((w - side) / 2), sy: Math.round((h - side) / 2), side: side, out: Math.max(1, Math.min(m, side)) };
}

/* ---------- 上传（M2 PR-a，音乐 v1.19 7.3 / 7.4 / 十二 M2）的纯函数 ---------- */
/** 批量传时歌词 / 封面按文件名对上曲目（7.4）：去格式后缀（和末尾方括号标签）再比，不分大小写；a.mp3 配 a.lrc、a.jpg */
function matchKey(name){ return TAGS.cleanName(name).toLowerCase(); }
/** 在 names 里找和音频 fname 对上的那个：先按 matchKey 完全一样，再按原来的 lrcKey（去曲序前缀后比）；used 里的不再用 → 下标或 -1 */
function matchFile(fname, names, used){
  var k = matchKey(fname), k2 = lrcKey(fname), i;
  for (i = 0; i < names.length; i++) if (!used[i] && matchKey(names[i]) === k) return i;
  for (i = 0; i < names.length; i++) if (!used[i] && lrcKey(names[i]) === k2) return i;
  return -1;
}
/**
 * 上传计划（不发请求，只算发什么）。o = {
 *   mode: 'one' 单首 / 'batch' 批量；target: '0' 不划入专辑（= 单曲）/ 'new' 新建专辑 / 已有专辑 id；
 *   name（单首的歌名）, albumName（新建专辑的名）, artist（单首的歌手 / 新建专辑的歌手）, year（数字，0 = 不填）,
 *   files: [{name, tags: {title, artist, picture: 有没有内嵌封面}}]（批量已按文件名排好）, covers: [文件名], lrcs: [文件名], preview（只算预览，不查名字） }；list = 歌单（找已有专辑、它的曲序）。
 * → {error} 或 {album: null（单曲）/ {add: {title, artist, year}} / {id, title, artist}, singleYear, albumCover: null / {pick: k} / {embedded: 第几首},
 *    tracks: [{file, no, title, artist, lrc: 下标 / -1, cover: 下标 / -1, embedded: 用内嵌封面}], unmatched: {lrc: [名字], cover: [名字]}}
 * 规则：单首——歌名 = 填的；歌手 = 填的。批量——每首按 TAGS.prefill（标签优先、文件名兜底）；新建专辑 / 已有专辑里，没有歌手的曲目用专辑的歌手。
 * 曲序：单曲 1；新建专辑单首 1、批量取文件名开头的数字（没有用第几个）；已有专辑接在最后（max(no)+1 起）。
 * 封面（7.6）：单曲各用自己的（选的，没有用内嵌的）；新建专辑用选的那张，没有用第一首有内嵌封面的；划进已有专辑不传（用专辑封面）。
 */
function uploadPlan(o, list){
  var files = o.files || [], covers = o.covers || [], lrcs = o.lrcs || [], one = o.mode === 'one';
  var target = String(o.target == null ? '0' : o.target), artist = String(o.artist == null ? '' : o.artist).trim(), year = Number(o.year) || 0;
  /* preview：只算预览（右栏列表、多数歌手），名字还没填也照算 */
  if (!o.preview && one && !String(o.name || '').trim()) return { error: 'needSong' };
  if (!o.preview && target === 'new' && !String(o.albumName || '').trim()) return { error: 'needAlbumName' };
  if (!files.length) return { error: 'needAudio' };
  var plan = { album: null, singleYear: 0, albumCover: null, tracks: [], unmatched: { lrc: [], cover: [] } };
  var base = 0;
  if (target === 'new') plan.album = { add: { title: String(o.albumName).trim(), artist: artist, year: year } };
  else if (target !== '0') {
    var id = Number(target), a = (list || []).filter(function(x){ return x.id === id && !CORE.isSingle(x); })[0];
    if (!a) return { error: 'albumGone' };
    plan.album = { id: id, title: a.title, artist: String(a.artist || '').trim() };
    (a.tracks || []).forEach(function(t){ if (t.no > base) base = t.no; });
  } else plan.singleYear = year;
  var albArtist = plan.album ? (plan.album.add ? artist : plan.album.artist) : '';
  if (one) {
    var f0 = files[0], emb = !!(f0.tags && f0.tags.picture);
    var t0 = { file: 0, no: plan.album && plan.album.id ? base + 1 : 1, title: String(o.name).trim(), artist: artist, lrc: lrcs.length ? 0 : -1, cover: -1, embedded: false };
    if (!plan.album) { t0.cover = covers.length ? 0 : -1; t0.embedded = !covers.length && emb; }
    else if (plan.album.add) plan.albumCover = covers.length ? { pick: 0 } : emb ? { embedded: 0 } : null;
    plan.tracks.push(t0);
    return plan;
  }
  var usedL = {}, usedC = {}, useCovers = !plan.album;  /* 单曲：封面按文件名对上；新建专辑只要一张专辑封面；已有专辑不传 */
  files.forEach(function(f, i){
    var p = TAGS.prefill(f.name, f.tags, { batch: true, fallback: i + 1 });
    var li = matchFile(f.name, lrcs, usedL); if (li >= 0) usedL[li] = true;
    var ci = useCovers ? matchFile(f.name, covers, usedC) : -1; if (ci >= 0) usedC[ci] = true;
    plan.tracks.push({ file: i, no: plan.album ? (plan.album.add ? p.no : base + 1 + i) : 1, title: p.title || TAGS.cleanName(f.name) || String(f.name || ''),
      artist: p.artist || albArtist, lrc: li, cover: ci, embedded: !plan.album && ci < 0 && !!(f.tags && f.tags.picture) });
  });
  if (plan.album && plan.album.add) {
    if (covers.length) plan.albumCover = { pick: 0 };
    else for (var k = 0; k < files.length; k++) if (files[k].tags && files[k].tags.picture) { plan.albumCover = { embedded: k }; break; }
  }
  lrcs.forEach(function(n, i){ if (!usedL[i]) plan.unmatched.lrc.push(n); });
  if (useCovers) covers.forEach(function(n, i){ if (!usedC[i]) plan.unmatched.cover.push(n); });
  return plan;
}
/** 封面 / 头像裁切（十二 M2 第 3 条 / M4 第 2 条，同一套）：取中间正方形、≤ 1000、jpeg；质量从 0.86 起，超 3 MB 再降（同后端 coverBytes） */
var COVER_MAX = 3 * 1024 * 1024, COVER_Q = [0.86, 0.72, 0.55];

/* ---------- 文案表（语言包化第二部分 2026-11-07；curio / daymark 各脚本同一份小工具） ---------- */
/** 页面里 #sgx-i18n-<表> 的扁平字典；没有 / 坏了返回 {} */
function readDict(doc, table){
  try {
    var el = doc && doc.getElementById('sgx-i18n-' + table);
    var o = el && el.textContent ? JSON.parse(el.textContent) : null;
    return o && typeof o === 'object' ? o : {};
  } catch (e) { return {}; }
}
/**
 * 字典 → tr(键, 变量)：{名} 占位替换；变量里有数字 n 时先按 Intl.PluralRules(lang) 找「键_one」这类复数形式，没有就用键本身；缺键返回 ''。
 * 语言自己的规则（英文 1 link / 2 links，中文不分）都在字符串表里，脚本不分语言。
 */
function makeTr(dict, lang){
  /* 先拷一份原始文案：调用方会把带数字的键改挂成函数（例如数量键被改成按 n 取文案的函数），
     tr 若直接读同一个字典，拿到的就是那个函数而不是「{n} 条」 */
  var src = {};
  for (var k0 in dict) if (Object.prototype.hasOwnProperty.call(dict, k0)) src[k0] = dict[k0];
  var pr = null;
  try { pr = new Intl.PluralRules(lang || 'en'); } catch (e) { pr = null; }
  return function tr(key, vars){
    var s = null;
    if (vars && typeof vars.n === 'number' && pr) s = src[key + '_' + pr.select(vars.n)];
    if (s == null) s = src[key];
    s = s == null ? '' : String(s);
    if (vars) for (var k in vars) s = s.split('{' + k + '}').join(String(vars[k]));
    return s;
  };
}

var pure = { readDict: readDict, makeTr: makeTr, SPEEDS: SPEEDS, TRACK_MAX: TRACK_MAX, nextSpeed: nextSpeed, fmtTime: fmtTime, parseLrc: parseLrc, lrcIndex: lrcIndex, trackFromName: trackFromName, sortByName: sortByName, audioType: audioType, lrcKey: lrcKey, splitKinds: splitKinds, pickSection: pickSection, albumChoices: albumChoices, lrcChange: lrcChange, trackEditBody: trackEditBody, yearOf: yearOf, batchRequests: batchRequests, artistOf: artistOf, artistWorks: artistWorks, relatedAlbums: relatedAlbums, similarArtist: similarArtist, squareCrop: squareCrop, matchKey: matchKey, uploadPlan: uploadPlan, COVER_MAX: COVER_MAX, COVER_Q: COVER_Q };
if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }
G.SgxCurioMusic = pure;

var doc = G.document;
if (!doc.getElementById('cu-pane-music')) return;
var UI = G.SgxCurioUI;
var $ = function(s){ return doc.querySelector(s); };
/* 界面文案（语言包化第二部分 2026-11-07）：页面里的 #sgx-i18n-curioMusic，模板从字符串表 data/curio/i18n/<语言>.yaml 的 js.curioMusic 输出，
   已经是「英文表 ← 页面语言表」的合并（缺键回退英文）；本文件不再认识任何语言。带数字的文案走 tr（复数按 Intl.PluralRules）。 */
var lang = doc.documentElement.lang || 'en';
var T = readDict(doc, 'curioMusic');
var tr = makeTr(T, lang);
T.tracks = function(n){ return tr('tracks', { n: n }); };
T.tooBig = function(name){ return tr('tooBig', { name: name }); };
T.badType = function(name){ return tr('badType', { name: name }); };
T.up = function(i, n, name){ return tr('up', { i: i, n: n, name: name }); };
T.partial = function(n){ return tr('partial', { n: n }); };
T.chosen = function(n){ return tr('chosen', { n: n }); };
T.speed = function(s){ return tr('speed', { s: s }); };
T.selN = function(n){ return tr('selN', { n: n }); };
T.batchFail = function(n){ return tr('batchFail', { n: n }); };
T.batchDone = function(n){ return tr('batchDone', { n: n }); };
/** 删除键图标（同 curio/icon.html trash） */
var TRASH = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>';
/** 「⋯」编辑键、多选勾（M3） */
var MORE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/></svg>';
var CHECK = '<span class="mu-check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>';
/** 默认歌手图标（没头像时，7.5「歌手没头像时用默认图标」） */
var PERSON = '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c.9-3.9 3.9-6 7.5-6s6.6 2.1 7.5 6"/></svg>';
var NOTE = '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/></svg>';

/* all = 接口回的全部记录；albums = 其中的专辑（封面横滑，cur 是下标）；singles = 单曲（列表）；sec = 当前分段 'album' / 'single' */
var all = [], albums = [], singles = [], sec = 'album', cur = 0, coverVer = 0;
/* 歌手表（M4，GET / POST 回答里的 artists）；view = 歌手页视图里的歌手 id（0 = 音乐页本身；地址 ?artist=<id>） */
var arts = [], view = artistOf(G.location && G.location.search);
function artistById(id){ for (var k = 0; k < arts.length; k++) if (arts[k].id === id) return arts[k]; return null; }
/* 多选（M3 批量改）：on = 在多选里；ids = 选中的曲目 id（专辑页）/ 单曲记录 id（单曲区） */
var sel = { on: false, ids: {} };
function selCount(){ return Object.keys(sel.ids).length; }
function selExit(){ sel.on = false; sel.ids = {}; }
/** 换一份歌单：分两边，分段落在有内容的那边（want 不给 = 留在当前分段） */
function setData(list, want){
  all = list || [];
  var k = splitKinds(all);
  albums = k.albums; singles = k.singles;
  cur = Math.min(cur, Math.max(0, albums.length - 1));
  sec = pickSection(want || sec, albums.length, singles.length);
}
var audio = $('#mu-audio');
/** 歌词（画在播放条里）；声音和令牌在共用核 P 里 */
var lyr = { lines: [], line: -2 };
var speed = 1;
/* 共用核：签令牌走本页 req（401 = 只看模式），换曲 / 播停时这边只管画 */
var P = CORE.createPlayer({
  audio: audio,
  sign: function(albumId){ return req('POST', '/curio/api/music-play', { album: albumId }); },
  onTrack: paintTrack,
  onChange: syncToggle,
  onStop: function(){ renderAlbum(); syncToggle(); },
  /* 点播失败报一句（没进站已切只看模式，不再报）；切曲 / 续签失败照旧不吭声 */
  onError: function(e, where){ if (where === 'play' && !(e && e.sgxLocked)) toast(failMsg(e)); },
});

function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function toast(m){ if (UI) UI.toast(m); }
/** 只看模式：没进站（网关标记；签令牌 401 时改成 true） */
var viewOnly = doc.documentElement.getAttribute('data-sgx-lock-session') === 'locked';
/** 写的权限（GET /api/music 回的 canWrite：账号 + curio.write） */
var canWrite = false;
/** 请人进站：顶栏终端预填 su （curio.js SgxCurioUI.sudo → sgx:sudo，topbar/panel.js 接） */
function askSudo(){ if (UI && UI.sudo) UI.sudo(); }
/** 本页接口：401 = 没进站（切到只看模式 + 请人进站，抛 sgxLocked，调用方不再报错）；其它错误带 code 抛出 */
function req(method, url, body, type, ticket){
  var h = body === undefined ? {} : { 'Content-Type': type || 'application/json' };
  if (ticket) h['X-Sgx-Sudo'] = ticket; /* D-3 a′：album.del 的一次性票（curio.js SgxCurioUI.sudoTicket） */
  return fetch(url, {
    method: method, credentials: 'same-origin', cache: 'no-store',
    headers: h,
    body: body === undefined ? undefined : type ? body : JSON.stringify(body),
  }).then(function(r){
    return r.json().catch(function(){ return {}; }).then(function(j){
      if (r.status === 401) { setViewOnly(true); askSudo(); throw Object.assign(new Error('locked'), { sgxLocked: true }); }
      if (!r.ok || !j.ok) throw Object.assign(new Error(j.error || ('HTTP ' + r.status)), { code: j.error, status: r.status });
      if (Array.isArray(j.artists)) { arts = j.artists; fillArtistList(); }  /* M4：歌手表跟着每次回答换 */
      return j;
    });
  });
}
/** 失败提示：403 forbidden（2b：v6 身份不在 listen / curio-write，或 album.del 不是 root）说没权限，其余「出了点问题」 */
function failMsg(e){ return e && e.code === 'forbidden' && T.noPermission ? T.noPermission : T.failed; }
function album(){ return albums[cur] || null; }
/** 删专辑 / 单曲（album.del = root 档，D-3 a′）：先拿票再发；sudo 行带专辑 id */
function delAlbum(id){
  var get = UI && UI.sudoTicket ? UI.sudoTicket('sudo curio music rm ' + id, { method: 'POST', path: '/curio/api/music', action: 'album.del' }) : Promise.resolve('');
  return get.then(function(t){ return req('POST', '/curio/api/music', { op: 'album.del', id: id }, undefined, t); });
}
/** 封面地址：专辑 / 单曲自己的封面；单曲没有 → 歌手头像；都没有 ''（M4，共用核 coverOf） */
function coverUrl(a){ return CORE.coverOf(a, arts, coverVer); }
function avatarUrl(r){ return r && r.avatar ? '/curio/api/music-cover?artist=' + r.id + (coverVer ? '&v=' + coverVer : '') : ''; }
/** 歌手名 → 歌手页链接（M4 入口；对不上歌手表 / 没有歌手就只是文字）。inButton：在播放按钮里面（单曲行），不能放 <a>，用不可聚焦的 span */
function artistLink(name, id, inButton){
  var n = esc(name || '');
  if (!name || !(id > 0) || !artistById(id)) return n;
  return inButton ? '<span class="mu-artist-a" data-artist="' + id + '">' + n + '</span>' : '<a class="mu-artist-a" href="?artist=' + id + '" data-artist="' + id + '">' + n + '</a>';
}

/* ---------- 画 ---------- */
/** 分段：两边都有才显示 */
function renderSeg(){
  $('#mu-seg').classList.toggle('hidden', !(albums.length && singles.length));
  doc.querySelectorAll('#mu-seg [data-sec]').forEach(function(b){ b.setAttribute('aria-selected', String(b.dataset.sec === sec)); });
}
/** 单曲列表：小封面 · 歌名 · 歌手 · 时长；正在放的高亮 */
function renderSingles(){
  var box = $('#mu-singles');
  box.classList.toggle('hidden', sec !== 'single' || !singles.length);
  if (sec !== 'single') { box.innerHTML = ''; return; }
  box.innerHTML = singles.map(function(a, i){
    var t = a.tracks[0], on = !!P.state.queue && P.state.i >= 0 && P.state.album === a.id;
    var picked = sel.on && !!sel.ids[a.id];
    return '<li' + (canWrite ? ' class="mu-single-row"' : '') + '><button type="button" class="mu-single' + (on ? ' on' : '') + '" data-s="' + i + '"' + (on ? ' aria-current="true"' : '') + (sel.on ? ' aria-pressed="' + picked + '"' : '') + (t ? '' : ' disabled') + '>'
      + (sel.on ? CHECK : '')
      + singleIm(a)
      + '<span class="mu-single-tx"><b>' + esc(a.title) + '</b><i>' + (sel.on ? esc(a.artist || '') : artistLink(a.artist, a.artist_id, true)) + '</i></span>'
      + '<span class="mu-track-dur">' + (t && t.duration ? fmtTime(t.duration) : '') + '</span></button>'
      /* 「⋯」编辑（M3：歌名、歌手、歌词、所属专辑、封面）；多选时不画 */
      + (canWrite && t && !sel.on ? '<button type="button" class="mu-more" data-ed="' + i + '" aria-label="' + esc(tr('editBtn', { name: a.title })) + '" title="' + esc(tr('editBtn', { name: a.title })) + '">' + MORE + '</button>' : '')
      /* 删除单曲（同「删除专辑」权限：接口回 canWrite 才画；点了先弹确认） */
      + (canWrite && !sel.on ? '<button type="button" class="mu-single-del" data-del="' + a.id + '" aria-label="' + esc(tr('delSingleBtn', { name: a.title })) + '" title="' + esc(tr('delSingleBtn', { name: a.title })) + '">' + TRASH + '</button>' : '')
      + '</li>';
  }).join('');
}
/** 单曲小封面（M4：封面空 → 歌手头像 → 默认图） */
function singleIm(a){
  var u = coverUrl(a);
  return '<span class="mu-single-im" aria-hidden="true">' + (u ? '<img src="' + u + '" alt="" loading="lazy" decoding="async" onerror="this.remove()">' : '') + '<span class="mu-cover-ph">' + NOTE + '</span></span>';
}
function renderCovers(){
  $('#mu-covers').innerHTML = albums.map(function(a, i){
    return '<button type="button" role="listitem" class="mu-cover' + (i === cur ? ' on' : '') + '" data-i="' + i + '" aria-label="' + esc(a.title) + '">'
      + (a.cover ? '<img src="' + coverUrl(a) + '" alt="" decoding="async" onerror="this.remove()">' : '') + '<span class="mu-cover-ph">' + NOTE + '</span></button>';
  }).join('');
  $('#mu-dots').innerHTML = albums.length > 1 ? albums.map(function(_, i){ return '<i' + (i === cur ? ' class="on"' : '') + '></i>'; }).join('') : '';
}
function renderAlbum(){
  /* 歌手页视图（M4）：音乐页本身收起，只画歌手页 */
  $('#mu-lib').classList.toggle('hidden', !!view);
  if (view) return renderArtist();
  $('#mu-artist').classList.add('hidden');
  var a = album(), inAlb = sec === 'album';
  $('#mu-empty').classList.toggle('hidden', all.length > 0);
  ['#mu-covers', '#mu-dots'].forEach(function(s){ $(s).classList.toggle('hidden', !albums.length || !inAlb); });
  doc.querySelector('.mu-head').classList.toggle('hidden', !a || !inAlb);
  doc.querySelector('.mu-album-acts').classList.toggle('hidden', !a || !canWrite || !inAlb);
  $('#mu-album-edit').classList.toggle('hidden', !a || !canWrite || !inAlb);
  renderSelBar(a, inAlb);
  $('#mu-tracks').innerHTML = '';
  renderSeg(); renderSingles();
  if (viewOnly) paintViewOnly(inAlb ? a : singles[0] || null);
  if (!a || !inAlb) return;
  $('#mu-album-title').textContent = a.title;
  $('#mu-album-sub').innerHTML = [artistLink(a.artist, a.artist_id), a.year ? String(a.year) : '', esc(T.tracks(a.tracks.length))].filter(Boolean).join(' · ');
  $('#mu-play-all').disabled = !a.tracks.length;
  $('#mu-tracks').innerHTML = a.tracks.map(function(t, i){
    var on = P.state.album === a.id && P.state.i === i, picked = sel.on && !!sel.ids[t.id];
    return '<li' + (canWrite ? ' class="mu-track-row"' : '') + '><button type="button" class="mu-track' + (on ? ' on' : '') + '" data-t="' + i + '"' + (on ? ' aria-current="true"' : '') + (sel.on ? ' aria-pressed="' + picked + '"' : '') + '>'
      + (sel.on ? CHECK : '<span class="mu-track-no">' + (t.no || i + 1) + '</span>') + '<span class="mu-track-title">' + esc(t.title) + '</span>'
      + '<span class="mu-track-dur">' + (t.duration ? fmtTime(t.duration) : '') + '</span></button>'
      /* 「⋯」编辑（M3：歌名、歌手、歌词、所属专辑；专辑里的曲目不设封面，7.6）；多选时不画 */
      + (canWrite && !sel.on ? '<button type="button" class="mu-more" data-ed="' + i + '" aria-label="' + esc(tr('editBtn', { name: t.title })) + '" title="' + esc(tr('editBtn', { name: t.title })) + '">' + MORE + '</button>' : '')
      + '</li>';
  }).join('');
  doc.querySelectorAll('#mu-dots i').forEach(function(d, i){ d.classList.toggle('on', i === cur); });
  doc.querySelectorAll('.mu-cover').forEach(function(c, i){ c.classList.toggle('on', i === cur); });
}
function select(i, scroll){
  if (i < 0 || i >= albums.length) return;
  if (i !== cur) selExit();
  cur = i;
  renderAlbum();
  if (scroll) { var c = doc.querySelector('.mu-cover[data-i="' + i + '"]'); if (c) c.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }); }
}
/* 分段切换：专辑 ↔ 单曲（只换显示，不打断正在放的） */
$('#mu-seg').addEventListener('click', function(e){
  var b = e.target.closest('[data-sec]');
  if (!b || b.dataset.sec === sec) return;
  sec = pickSection(b.dataset.sec, albums.length, singles.length);
  selExit();
  renderAlbum();
  if (sec === 'album') { var c = doc.querySelector('.mu-cover[data-i="' + cur + '"]'); if (c) c.scrollIntoView({ inline: 'center', block: 'nearest' }); }
});
/* 单曲：点一行从这首开始，单曲区当播放列表 */
$('#mu-singles').addEventListener('click', function(e){
  /* 单曲行里的歌手名（M4）：进歌手页，不播放；多选时照旧是选中 */
  var ar = !sel.on && e.target.closest('[data-artist]');
  if (ar) { e.preventDefault(); return goArtist(Number(ar.dataset.artist)); }
  var d = e.target.closest('[data-del]');
  if (d) return askDelSingle(Number(d.dataset.del));
  var m = e.target.closest('[data-ed]');
  if (m) { var sa = singles[Number(m.dataset.ed)]; return sa && sa.tracks[0] && openTrackEdit(sa, sa.tracks[0]); }
  var b = e.target.closest('[data-s]');
  if (!b) return;
  if (sel.on) { var s1 = singles[Number(b.dataset.s)]; return s1 && selToggle(s1.id); }
  if (viewOnly) return askSudo();
  playSingles(Number(b.dataset.s));
});
/* 封面横滑：停下来以后离中线最近的那张是当前专辑 */
(function(){
  var box = $('#mu-covers'), t = 0;
  box.addEventListener('scroll', function(){
    clearTimeout(t);
    t = setTimeout(function(){
      var mid = box.scrollLeft + box.clientWidth / 2, best = cur, d = Infinity;
      box.querySelectorAll('.mu-cover').forEach(function(c, i){ var x = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid); if (x < d) { d = x; best = i; } });
      if (best !== cur) select(best, false);
    }, 90);
  }, { passive: true });
  box.addEventListener('click', function(e){ var b = e.target.closest('.mu-cover'); if (b) select(Number(b.dataset.i), true); });
})();

/* ---------- 只看模式（没进站） ---------- */
/** 播放条停在当前专辑：标题 / 「艺术家 · 未进站，仅可浏览」，时间 --:-- @param {any} a */
function paintViewOnly(a){
  var pl = $('#mu-player');
  pl.classList.toggle('hidden', !a);
  if (!a) return;
  $('#mu-now-title').textContent = a.title;
  $('#mu-now-sub').textContent = [a.artist, T.viewOnly].filter(Boolean).join(' · ');  /* 专辑 / 单曲一样：歌手 · 未进站 */
  $('#mu-time').textContent = '--:--'; $('#mu-dur').textContent = '--:--';
  $('#mu-seek').value = '0';
}
/** 切到 / 离开只看模式（离开只在本页不会发生：进站后页面重新取） @param {boolean} v */
function setViewOnly(v){
  viewOnly = v;
  doc.documentElement.classList.toggle('mu-view-only', v);
  ['#mu-prev', '#mu-next', '#mu-speed', '#mu-seek', '#mu-shuffle'].forEach(function(s){ $(s).disabled = v; });
  ['#mu-play-all', '#mu-toggle'].forEach(function(s){
    var b = $(s);
    if (v) { b.setAttribute('aria-disabled', 'true'); b.setAttribute('aria-label', T.locked); }
    else b.removeAttribute('aria-disabled');
  });
  if (v) { P.reset(); doc.documentElement.classList.remove('mu-playing'); }
  renderAlbum();
}

/* ---------- 播放（声音、令牌、切曲在共用核 music-core.js；这里只画） ---------- */
function setLyrics(src){
  lyr.lines = parseLrc(src); lyr.line = -2;
  $('#mu-lyrics-in').innerHTML = lyr.lines.map(function(l, i){ return '<p data-l="' + i + '">' + esc(l.text || '♪') + '</p>'; }).join('');
  $('#mu-lyrics').classList.toggle('hidden', !lyr.lines.length);
}
function syncLyrics(){
  if (!lyr.lines.length) return;
  var i = lrcIndex(lyr.lines, audio.currentTime);
  if (i === lyr.line) return;
  lyr.line = i;
  var box = $('#mu-lyrics'), inner = $('#mu-lyrics-in');
  inner.querySelectorAll('p.on').forEach(function(p){ p.classList.remove('on'); });
  var p = i >= 0 ? inner.querySelector('[data-l="' + i + '"]') : null;
  if (p) { p.classList.add('on'); inner.style.transform = 'translateY(' + Math.round(box.clientHeight / 2 - p.offsetTop - p.offsetHeight / 2) + 'px)'; }
  else inner.style.transform = 'translateY(' + Math.round(box.clientHeight / 2 - 12) + 'px)';
}
/** 播放条副标题（同共用核 nowSub：专辑「专辑名 · 歌手」，单曲只歌手），歌手名可点进歌手页（M4） */
function paintNowSub(a){
  var el = $('#mu-now-sub');
  if (!a) { el.textContent = ''; return; }
  var who = artistLink(a.artist, a.artist_id);
  el.innerHTML = CORE.isSingle(a) ? who : [esc(a.title), who].filter(Boolean).join(' · ');
}
/** 共用核开始放某一首：播放条标题、歌词、曲目高亮 */
function paintTrack(t, st){
  var a = all.filter(function(x){ return x.id === st.album; })[0];
  $('#mu-now-title').textContent = t.title;
  paintNowSub(a);  /* 单曲只显示歌手；歌手名是歌手页链接（M4） */
  $('#mu-time').textContent = fmtTime(0); $('#mu-seek').value = '0';
  $('#mu-dur').textContent = CORE.durText(NaN, t.duration);  /* 元数据到之前先用已知时长 */
  setLyrics(t.lrc);
  $('#mu-player').classList.remove('hidden');
  doc.documentElement.classList.add('mu-playing');
  renderAlbum();
}
function playFrom(a, i){ return P.playFrom(a.id, i); }
/** 单曲区当播放列表：从第 i 首开始（没有音频的单曲不进列表） */
function playSingles(i){
  var list = singles.filter(function(a){ return a.tracks.length; }), pick = singles[i];
  var k = list.indexOf(pick);
  if (k < 0) return;
  return P.playQueue(list.map(function(a){ return a.id; }), k);
}
function syncToggle(){
  var b = $('#mu-toggle'), on = P.playing();
  b.classList.toggle('is-playing', on);
  b.setAttribute('aria-label', on ? b.dataset.lPause : b.dataset.lPlay);
}
$('#mu-play-all').addEventListener('click', function(){ if (viewOnly) return askSudo(); var a = album(); if (a && a.tracks.length) playFrom(a, 0); });
$('#mu-tracks').addEventListener('click', function(e){
  var a = album(); if (!a) return;
  var m = e.target.closest('[data-ed]');
  if (m) { var t = a.tracks[Number(m.dataset.ed)]; return t && openTrackEdit(a, t); }
  var b = e.target.closest('[data-t]'); if (!b) return;
  if (sel.on) { var t1 = a.tracks[Number(b.dataset.t)]; return t1 && selToggle(t1.id); }
  if (viewOnly) return askSudo();
  playFrom(a, Number(b.dataset.t));
});
$('#mu-toggle').addEventListener('click', function(){
  if (viewOnly) return askSudo();
  if (!P.toggle()) {
    if (sec === 'single') return playSingles(0);
    var a = album(); if (a && a.tracks.length) playFrom(a, 0);
  }
});
/* 随机播放：和弹出播放器共用本地设置（sgx-music-mode） */
var modeStore = null;
try { modeStore = G.localStorage; } catch (e) { modeStore = null; }
function syncShuffle(){
  var b = $('#mu-shuffle'), on = P.state.shuffle;
  b.setAttribute('aria-pressed', String(on)); b.title = on ? T.shuffleOn : T.shuffleOff;
}
function applyMode(){ var on = CORE.readMode(modeStore) === 'shuffle'; if (on !== P.state.shuffle) P.setShuffle(on); syncShuffle(); }
$('#mu-shuffle').addEventListener('click', function(){
  if (viewOnly) return askSudo();
  P.setShuffle(!P.state.shuffle); CORE.saveMode(modeStore, P.state.shuffle ? 'shuffle' : 'seq'); syncShuffle();
});
G.addEventListener('storage', function(e){ if (!e || e.key === CORE.MODE_KEY) applyMode(); });
applyMode();
$('#mu-prev').addEventListener('click', function(){ P.prev(); });
$('#mu-next').addEventListener('click', function(){ P.next(); });
$('#mu-speed').addEventListener('click', function(){
  speed = nextSpeed(speed);
  P.setSpeed(speed);
  var b = $('#mu-speed'); b.textContent = speed + '×'; b.setAttribute('aria-label', T.speed(speed));
});
var seeking = false;
$('#mu-seek').addEventListener('input', function(){ seeking = true; if (audio.duration) $('#mu-time').textContent = fmtTime(audio.duration * this.value / 1000); });
$('#mu-seek').addEventListener('change', function(){ seeking = false; if (audio.duration) audio.currentTime = audio.duration * this.value / 1000; });
audio.addEventListener('timeupdate', function(){
  if (!seeking && audio.duration) { $('#mu-seek').value = String(Math.round(audio.currentTime / audio.duration * 1000)); $('#mu-time').textContent = fmtTime(audio.currentTime); }
  syncLyrics();
});
/** 总时长：元数据到了用真实 duration，没到 / 不可用用曲目已知时长（CORE.durText） */
function paintDur(){ var t = P.state.list[P.state.i]; $('#mu-dur').textContent = CORE.durText(audio.duration, t && t.duration); }
audio.addEventListener('loadedmetadata', paintDur);
audio.addEventListener('durationchange', paintDur);

/* ---------- 删除专辑 ---------- */
$('#mu-album-del').addEventListener('click', function(){
  var a = album();
  if (!a || !UI) return;
  UI.ask(T.delAlbum, T.del, function(){
    delAlbum(a.id).then(function(j){
      if (P.state.album === a.id) { P.reset(); lyr = { lines: [], line: -2 }; $('#mu-player').classList.add('hidden'); doc.documentElement.classList.remove('mu-playing'); }
      setData(j.albums); renderCovers(); renderAlbum(); toast(T.deleted);
    }).catch(function(e){ if (!e.sgxLocked) toast(failMsg(e)); });
  });
});

/* ---------- 删除单曲（v1.13 ②，Gray 2026-11-14 18:40）：每行一个删除键，先弹确认（悬浮卡片 <dialog class="sgx-qp sgx-up mu-del">，同上传窗，不从底部升起），
   确认后复用 album.del（单曲 = kind=single 的专辑记录，连音频 / 封面一起删）；回来的歌单重画，单曲区空了按 pickSection 回到专辑、分段随之隐藏 ---------- */
var delDlg = $('#mu-del-wrap'), delId = 0;
/* M3：同一张确认卡片也给「删曲目」用（十二 M3 第 4 条）：delOp = {title, msg, run() → Promise<歌单>, stops() → 删的是不是正在放的}；删单曲（album.del）照旧 */
var delOp = null;
var delSheet = G.SgxModalSheet ? G.SgxModalSheet(delDlg, doc.createElement('span') /* 共享状态机要一个同步 aria-expanded 的按钮；删除键是每行画的，给个占位 */, { ms: 240, reducedMs: 120, stateKey: 'sgxMuDel', modal: false, onOpen: function(){ upLock(true); }, onClosed: function(){ upLock(false); delId = 0; delOp = null; } })
  : { open: function(){ if (!delDlg.open) { delDlg.show(); delDlg.classList.add('is-open'); upLock(true); } }, close: function(){ if (delDlg.open) { delDlg.classList.remove('is-open'); delDlg.close(); } upLock(false); delId = 0; delOp = null; } };
/** 弹确认：id = 单曲记录 id。删的是它那一首（track.del，curio-write 档，十二 M3 第 4 条；Gray 审 2）：后端连空单曲记录和封面一起删。
 *  没有曲目的单曲记录（旧数据）没有 track.del 可发，才退回 album.del（root + 票） */
function askDelSingle(id){
  var a = singles.filter(function(x){ return x.id === id; })[0];
  if (!a || !canWrite) return;
  delId = id;
  var t = a.tracks[0];
  askDel({ title: T.delSingleTitle, msg: tr('delSingle', { name: a.title }),
    run: function(){ return t ? req('POST', '/curio/api/music', { op: 'track.del', id: t.id }) : delAlbum(id); },
    stops: function(){ return P.state.album === id; } });
}
/** 弹确认卡片（删单曲 / 删曲目共用） */
function askDel(o){
  delOp = o;
  $('#mu-del-title').textContent = o.title;
  $('#mu-del-msg').textContent = o.msg;
  $('#mu-del-ok').textContent = o.ok || T.del;  /* M4：合并歌手用同一张卡片，确认键写「合并」 */
  $('#mu-del-ok').disabled = false;
  delSheet.open();
  try { $('#mu-del-cancel').focus(); } catch (e) {}
}
delDlg.addEventListener('click', function(e){ if (e.target === delDlg) delSheet.close(); });
$('#mu-del-x').addEventListener('click', function(){ delSheet.close(); });
$('#mu-del-cancel').addEventListener('click', function(){ delSheet.close(); });
$('#mu-del-ok').addEventListener('click', function(){
  var o = delOp, ok = this;
  if (!o) return delSheet.close();
  ok.disabled = true;
  o.run().then(function(j){
    if (o.stops()) {  /* 正在放这首：停下、收起播放条（同删专辑） */
      P.reset(); lyr = { lines: [], line: -2 }; $('#mu-player').classList.add('hidden'); doc.documentElement.classList.remove('mu-playing'); }
    /* M4：换视图（合并后去目标歌手、删歌手后回音乐页）要等卡片的历史哨兵出栈之后再 pushState */
    delSheet.close(o.after ? function(){ G.setTimeout(function(){ o.after(j); }, 0); } : undefined);
    setData(j.albums); renderCovers(); renderAlbum(); toast(o.done || T.deleted);
  }).catch(function(e){ ok.disabled = false; delSheet.close(); if (!e.sgxLocked) toast(o.err ? o.err(e) : failMsg(e)); });
});

/* ---------- 上传（M2 PR-a，音乐 v1.19 7.3 / 7.4 / 7.5 / 十二 M2） ----------
 * 一个入口两种模式（分段「单首 | 批量」，默认单首）：
 *   - 单首：选 1 个音频 → 读标签（curio-music-tags.js）预填歌名、歌手（标签优先，没有再按文件名清理 + 拆「 - 」）；只是预填，用户动过的栏不再覆盖。
 *     「所属专辑」= 不划入（album.add kind=single）/ 新建专辑（album.add kind=album，歌手 = 这首的歌手）/ 已有专辑（接在最后；封面、年份跟专辑走）。
 *   - 批量：多选音频 → 每首预填，右栏列出「歌名 · 歌手」（新歌手标「新」）；「这批划入哪个专辑」= 不划（每首一条单曲）/ 新建专辑（歌手默认取多数，十二 M2 第 5 条）/ 已有专辑。
 *     歌词按文件名对上；不划时封面也按文件名对上（7.4），没对上的列出来。
 *   - 歌手栏挂 M4 的联想（#mu-artist-list）+ 近似名提示；预填的歌手和已有歌手同名就是同一个人（后端按名字对上 artist_id，十一 第 4 条）。
 *   - 曲目的歌手：上传接口不收歌手，传完一首发一个 track.edit {artist, lrc}（有才发），写曲目的 artist_id。
 *   - 封面：选的图、音频内嵌的封面都裁方、≤ 1000、jpeg（cropCover，十二 M2 第 3 条；已存的旧封面不动）。内嵌封面读不出来 / 解不开就算了，不算失败。
 * 逐首顺序传（并发、每首状态、只重试失败、进度、拖放、去重提醒是 PR-b）。 */
var upFiles = { audio: [], cover: [], lrc: [], tags: [] };
/** 上传窗模式：'one' 单首（默认）/ 'batch' 批量 */
var upMode = 'one', upGen = 0;
/** 用户亲手改过的栏（预填不再覆盖）；预填写进去的值不算 */
var upDirty = { name: false, artist: false };
var upPrev = '';
/* 内嵌封面预览只用固定的几种图片类型（标签里的 MIME 字符串不直接进 Blob） */
var UP_IMG_MIME = { 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/png': 'image/png', 'image/gif': 'image/gif' };
function upDropPreview(){ if (upPrev) { try { URL.revokeObjectURL(upPrev); } catch (e) {} upPrev = ''; } }
function upMsg(m, bad){ var el = $('#mu-up-msg'); el.textContent = m || ''; el.classList.toggle('hidden', !m); el.classList.toggle('text-m-error', !!bad); }
function upTarget(){ return $('#mu-up-album').value || '0'; }
/** 「所属专辑」/「这批划入哪个专辑」：不划 · 新建 · 已有专辑（只列 kind=album，同 M3 albumChoices） */
function upFillAlbums(){
  /* 每次换模式 / 打开都回到「不划」（批量的划入专辑是可选的，7.3） */
  fillAlbums($('#mu-up-album'), [{ v: '0', t: upMode === 'one' ? T.stayNoAlbum : T.noAlbumBatch }, { v: 'new', t: T.newAlbum }], '0');
}
/** 跟着模式 / 目标专辑换：哪些栏显示、哪些变灰、文件框单选还是多选 */
function upLayout(){
  var one = upMode === 'one', t = upTarget(), into = t !== '0' && t !== 'new';
  $('#mu-up-title').textContent = one ? T.uploadOne : T.uploadBatch;
  $('#mu-up-name-row').classList.toggle('hidden', !one);
  $('#mu-up-album-l').textContent = one ? T.inAlbum : T.inBatch;
  $('#mu-up-aname-row').classList.toggle('hidden', t !== 'new');
  /* 批量：歌手 / 年份只给新建专辑（= 专辑的歌手、年份）；单首一直有歌手，年份划进已有专辑时跟专辑走 */
  $('#mu-up-meta').classList.toggle('hidden', !one && t !== 'new');
  /* 栏的先后（7.4）：单首 = 歌名 → 歌手 · 年份 → 所属专辑；批量 = 划入哪个专辑 → 新专辑名 → 专辑歌手 · 年份 */
  var meta = $('#mu-up-meta'), hint = doc.querySelector('[data-hint-for="mu-up-artist"]'), alb = $('#mu-up-album').closest('label'), an = $('#mu-up-aname-row');
  if (one) { alb.parentNode.insertBefore(meta, alb); meta.parentNode.insertBefore(hint, alb); }
  else { an.parentNode.insertBefore(meta, an.nextSibling); meta.parentNode.insertBefore(hint, meta.nextSibling); }
  $('#mu-up-artist-l').textContent = !one && t === 'new' ? T.albumArtist : T.singer;
  $('#mu-up-year').disabled = into;
  $('#mu-up-note').textContent = one ? T.prefillNote : T.batchNote;
  $('#mu-up-audio').multiple = !one; $('#mu-up-lrc').multiple = !one; $('#mu-up-cover').multiple = !one && t === '0';
  $('#mu-up-cover').disabled = into;
  upCoverName(); upLrcName(); upList();
}
function upCoverName(){
  var one = upMode === 'one', t = upTarget(), into = t !== '0' && t !== 'new', c = upFiles.cover;
  /* 内嵌封面：单首 = 这首的；批量新建专辑 = 第一首有内嵌封面的（同 uploadPlan）；批量不划时每首各用各的，不预览 */
  var emb = null;
  if (one) emb = upFiles.tags[0] && upFiles.tags[0].picture;
  else if (t === 'new') for (var k = 0; k < upFiles.tags.length && !emb; k++) emb = upFiles.tags[k] && upFiles.tags[k].picture;
  var txt;
  if (into) txt = T.coverAlbum;
  else if (c.length) txt = c.length > 1 ? T.chosen(c.length) : c[0].name;
  else if (emb) txt = one ? T.coverEmbedded : T.coverAlbumEmbedded;
  else txt = one ? T.coverNone : t === 'new' ? T.coverAlbumPick : T.coverMatch;
  $('#mu-up-cover-name').textContent = txt;
  /* 小图：选的第一张，单首没选就用内嵌的 */
  var img = $('#mu-up-cover-img'), src = null;
  upDropPreview();
  $('#mu-up-cover-row').querySelector('.mu-ed-cover-im').classList.toggle('hidden', !one && t === '0');
  if (!into && c.length) src = c[0];
  else if (!into && emb) src = new Blob([emb.bytes], { type: UP_IMG_MIME[emb.mime] || 'image/jpeg' });
  if (src) { try { upPrev = URL.createObjectURL(src); } catch (e) { upPrev = ''; } }
  img.classList.toggle('hidden', !upPrev);
  if (upPrev) img.src = upPrev; else img.removeAttribute('src');
}
function upLrcName(){
  var one = upMode === 'one', l = upFiles.lrc;
  $('#mu-up-lrc-name').textContent = l.length ? (l.length > 1 ? T.chosen(l.length) : l[0].name) : (one ? T.lrcOne : T.lrcNone);
}
function upAudioName(){
  var one = upMode === 'one', a = upFiles.audio;
  $('#mu-up-audio-name').textContent = a.length ? (one ? a[0].name : T.chosen(a.length)) : (one ? T.chooseOne : T.choose);
}
/** 这次要传的计划（uploadPlan），标签还没读完的那几首先按文件名算 */
function upPlanNow(preview){
  var y = Number($('#mu-up-year').value) || 0;
  return uploadPlan({ preview: !!preview, mode: upMode, target: upTarget(), name: $('#mu-up-name').value, albumName: $('#mu-up-aname').value, artist: $('#mu-up-artist').value, year: y >= 1900 && y <= 2100 ? y : 0,
    files: upFiles.audio.map(function(f, i){ var g = upFiles.tags[i]; return { name: f.name, tags: g ? { title: g.title, artist: g.artist, picture: !!g.picture } : null }; }),
    covers: upFiles.cover.map(function(f){ return f.name; }), lrcs: upFiles.lrc.map(function(f){ return f.name; }) }, all);
}
/** 批量：右栏列出每首会传成什么（歌名 · 歌手，新歌手标「新」）和没对上的歌词 / 封面 */
function upList(){
  var box = $('#mu-up-list');
  if (upMode === 'one' || !upFiles.audio.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  var p = upPlanNow(true), rows = p.tracks || [];
  var known = {}; arts.forEach(function(r){ known[r.name] = true; });
  var h = '<p class="mu-up-list-h">' + esc(T.listHead) + '</p><ol class="mu-up-rows">' + rows.map(function(t){
    var who = t.artist ? esc(t.artist) + (known[t.artist] ? '' : ' <span class="mu-up-new">' + esc(T.newArtist) + '</span>') : '<span class="mu-up-none">' + esc(T.noArtist) + '</span>';
    return '<li><b>' + esc(t.title) + '</b><span>' + who + '</span></li>';
  }).join('') + '</ol>';
  var miss = (p.unmatched ? p.unmatched.lrc.concat(p.unmatched.cover) : []);
  if (miss.length) h += '<p class="mu-up-miss">' + esc(tr('unmatched', { names: miss.join(T.arSep || '、') })) + '</p>';
  box.innerHTML = h; box.classList.remove('hidden');
}
/** 预填（单首）：没被用户改过的栏才写；近似名提示跟着刷新 */
function upPrefill(){
  if (upMode !== 'one' || !upFiles.audio.length) return;
  var p = TAGS.prefill(upFiles.audio[0].name, upFiles.tags[0], {});
  if (!upDirty.name) $('#mu-up-name').value = p.title;
  if (!upDirty.artist) { $('#mu-up-artist').value = p.artist; $('#mu-up-artist').dispatchEvent(new Event('input')); }
}
/** 批量 + 新建专辑：歌手默认取多数（平票第一首），用户改过就不动 */
function upMajority(){
  if (upMode !== 'batch' || upTarget() !== 'new' || upDirty.artist) return;
  /* 按每首自己的预填歌手算（不掺专辑歌手栏里现有的值） */
  $('#mu-up-artist').value = TAGS.majorityArtist(upFiles.audio.map(function(f, i){ return TAGS.prefill(f.name, upFiles.tags[i], { batch: true }).artist; }));
  $('#mu-up-artist').dispatchEvent(new Event('input'));
}
function setUpMode(m){
  upMode = m === 'batch' ? 'batch' : 'one';
  doc.querySelectorAll('#mu-up-kind [data-kind]').forEach(function(b){ b.setAttribute('aria-selected', String(b.dataset.kind === upMode)); });
  /* 切模式清掉已选的文件和预填（单选 / 多选不能互相带） */
  upGen++;
  $('#mu-up-audio').value = ''; $('#mu-up-lrc').value = ''; $('#mu-up-cover').value = '';
  upFiles = { audio: [], cover: [], lrc: [], tags: [] };
  if (!upDirty.name) $('#mu-up-name').value = '';
  if (!upDirty.artist) { $('#mu-up-artist').value = ''; $('#mu-up-artist').dispatchEvent(new Event('input')); }
  upFillAlbums(); upAudioName(); upLayout();
  upMsg('');
}
$('#mu-up-kind').addEventListener('click', function(e){ var b = e.target.closest('[data-kind]'); if (b && b.dataset.kind !== upMode) setUpMode(b.dataset.kind); });
$('#mu-up-album').addEventListener('change', function(){
  /* 不划 → 新建再回来：封面单选 / 多选会变，已选的封面先清掉 */
  $('#mu-up-cover').value = ''; upFiles.cover = [];
  upLayout(); upMajority();
});
$('#mu-up-name').addEventListener('input', function(e){ if (e.isTrusted) upDirty.name = true; });
$('#mu-up-artist').addEventListener('input', function(e){ if (e.isTrusted) upDirty.artist = true; if (upMode === 'batch') upList(); });
/* 上传窗 = 非模态 <dialog class="sgx-qp sgx-up">（同 AI 窗口的悬浮卡片）+ 共享 modalSheet（topbar-host.js 挂的 window.SgxModalSheet）：
 * 系统返回 / Esc 只关窗不离页；点遮罩（dialog 本身）关；点顶栏任一按钮先关它（同顶栏窗口互斥）。时长同 CSS .24s。
 * 拿不到状态机（不该发生）就退回裸 show / close。 */
var upDlg = $('#mu-up-wrap');
function upLock(on){ doc.body.style.overflow = on || doc.querySelector('.bk-overlay.open') ? 'hidden' : ''; }
var upSheet = G.SgxModalSheet ? G.SgxModalSheet(upDlg, $('#mu-upload'), { ms: 240, reducedMs: 120, stateKey: 'sgxMuUp', modal: false, onOpen: function(){ upLock(true); }, onClosed: function(){ upLock(false); } })
  : { open: function(){ if (!upDlg.open) { upDlg.show(); upDlg.classList.add('is-open'); upLock(true); } }, close: function(){ if (upDlg.open) { upDlg.classList.remove('is-open'); upDlg.close(); } upLock(false); } };
upDlg.addEventListener('click', function(e){ if (e.target === upDlg) upSheet.close(); });
var nav = doc.getElementById('site-nav');
/* 先关上传窗、等它的历史哨兵出栈，再在下一个任务里把这次点击补给原按钮（同 topbar/panel.js 顶栏窗口互斥）：
 * 同一个 popstate 还要派给顶栏窗口的 modalSheet 监听，同一下里就开顶栏窗口会被它当成「系统返回」立刻关掉 */
/* M3：三个编辑窗同样处理（openSheets 在下面编辑那节登记） */
var openSheets = [function(){ return upDlg.open ? upSheet : null; }];
if (nav) nav.addEventListener('click', function(e){
  var sh = null;
  for (var k = 0; k < openSheets.length && !sh; k++) sh = openSheets[k]();
  var t = sh && e.target.closest && e.target.closest('button, a');
  if (!t) return;
  e.preventDefault(); e.stopPropagation();
  sh.close(function(){ G.setTimeout(function(){ t.click(); }, 0); });
}, true);
$('#mu-up-x').addEventListener('click', function(){ upSheet.close(); });
$('#mu-upload').addEventListener('click', function(){
  $('#mu-up-form').reset();
  upDirty = { name: false, artist: false };
  upMsg(''); $('#mu-up-go').disabled = false;
  setUpMode('one');
  upSheet.open();
});
$('#mu-up-audio').addEventListener('change', function(){
  var one = upMode === 'one', gen = ++upGen;
  upFiles.audio = sortByName(this.files).slice(0, one ? 1 : undefined);
  upFiles.tags = upFiles.audio.map(function(){ return null; });
  upAudioName(); upCoverName(); upPrefill(); upList(); upMajority();
  /* 读标签（尽力而为，永远 resolve）；读完再预填一次。换了文件 / 模式（gen 变了）就不管旧的 */
  Promise.all(upFiles.audio.map(function(f, i){
    return TAGS.readTags(f).then(function(g){ if (gen === upGen) upFiles.tags[i] = g; });
  })).then(function(){
    if (gen !== upGen) return;
    upCoverName(); upPrefill(); upList(); upMajority();
  });
});
$('#mu-up-cover').addEventListener('change', function(){ upFiles.cover = Array.prototype.slice.call(this.files || []); upCoverName(); upList(); });
$('#mu-up-lrc').addEventListener('change', function(){
  upFiles.lrc = Array.prototype.slice.call(this.files || []).slice(0, upMode === 'one' ? 1 : undefined);
  upLrcName(); upList();
});
/** 封面（十二 M2 第 3 条，同歌手头像一套）：取中间正方形、缩到 ≤ 1000、jpeg；超 3 MB 降质量再压（还超就报错，不传） */
function cropCover(file){
  return new Promise(function(resolve, reject){
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function(){
      var k = squareCrop(img.naturalWidth, img.naturalHeight, 1000), c = doc.createElement('canvas');
      c.width = k.out; c.height = k.out;
      c.getContext('2d').drawImage(img, k.sx, k.sy, k.side, k.side, 0, 0, k.out, k.out);
      URL.revokeObjectURL(url);
      var qi = 0;
      (function enc(){
        c.toBlob(function(b){
          if (!b) return reject(new Error('encode'));
          if (b.size <= COVER_MAX) return resolve(b);
          if (++qi < COVER_Q.length) return enc();
          reject(new Error('too-large'));
        }, 'image/jpeg', COVER_Q[qi]);
      })();
    };
    img.onerror = function(){ URL.revokeObjectURL(url); reject(new Error('image')); };
    img.src = url;
  });
}
/** 音频时长（秒，取不到 0；最多等 8 秒） */
function durationOf(file){
  return new Promise(function(resolve){
    var a = doc.createElement('audio'), url = URL.createObjectURL(file), done = false;
    function fin(v){ if (done) return; done = true; URL.revokeObjectURL(url); resolve(v); }
    a.preload = 'metadata';
    a.onloadedmetadata = function(){ fin(isFinite(a.duration) ? Math.round(a.duration) : 0); };
    a.onerror = function(){ fin(0); };
    setTimeout(function(){ fin(0); }, 8000);
    a.src = url;
  });
}
function readText(f){ return new Promise(function(ok){ var r = new FileReader(); r.onload = function(){ ok(String(r.result || '')); }; r.onerror = function(){ ok(''); }; r.readAsText(f); }); }
/** 内嵌封面 → Blob（没有 null） */
function embBlob(i){ var g = upFiles.tags[i]; return g && g.picture ? new Blob([g.picture.bytes], { type: UP_IMG_MIME[g.picture.mime] || 'image/jpeg' }) : null; }
$('#mu-up-go').addEventListener('click', function(){
  var one = upMode === 'one';
  /* 标签没读完就点了：等读完（readTags 永远 resolve，不会卡住） */
  var gen = upGen, btn = this;
  btn.disabled = true;
  Promise.all(upFiles.audio.map(function(f, i){ return upFiles.tags[i] ? null : TAGS.readTags(f).then(function(g){ if (gen === upGen) upFiles.tags[i] = g; }); })).then(function(){
    var plan = upPlanNow();
    if (plan.error) { btn.disabled = false; return upMsg(plan.error === 'needSong' ? T.needSong : plan.error === 'needAlbumName' ? T.needAlbumName : plan.error === 'needAudio' ? T.needAudio : T.failed, true); }
    for (var k = 0; k < upFiles.audio.length; k++) {
      var f = upFiles.audio[k];
      if (f.size > TRACK_MAX) { btn.disabled = false; return upMsg(T.tooBig(f.name), true); }
      if (!audioType(f)) { btn.disabled = false; return upMsg(T.badType(f.name), true); }
    }
    return runUpload(plan, one);
  }).then(function(){ btn.disabled = false; }, function(){ btn.disabled = false; });
});
/** 按计划逐首传：专辑（新建的）→ 专辑封面 → 每首（单曲先建记录、传封面）音频 → 歌手 / 歌词一个 track.edit → 重新拉歌单 */
function runUpload(plan, one){
  var albumId = plan.album && plan.album.id || 0, failed = 0;
  var files = upFiles.audio, covers = upFiles.cover, lrcs = upFiles.lrc;
  function cover(id, file, best){
    /* best = 内嵌封面：解不开就算了（不算失败） */
    return cropCover(file).then(function(b){ return req('POST', '/curio/api/music-upload?album=' + id + '&kind=cover', b, b.type); })
      .catch(function(e){ if (e && e.sgxLocked) throw e; if (!best) failed++; });
  }
  var start = Promise.resolve();
  if (plan.album && plan.album.add) start = req('POST', '/curio/api/music', { op: 'album.add', kind: 'album', title: plan.album.add.title, artist: plan.album.add.artist, year: plan.album.add.year }).then(function(j){
    albumId = j.id;
    var ac = plan.albumCover;
    if (!ac) return null;
    var file = ac.pick !== undefined ? covers[ac.pick] : embBlob(ac.embedded);
    if (!file) return null;
    upMsg(T.cover);
    return cover(albumId, file, ac.pick === undefined);
  });
  return start.then(function(){
    var chain = Promise.resolve();
    plan.tracks.forEach(function(t, i){
      chain = chain.then(function(){
        var f = files[t.file];
        upMsg(T.up(i + 1, plan.tracks.length, f.name));
        var into = albumId;
        var made = plan.album ? Promise.resolve(albumId)
          : req('POST', '/curio/api/music', { op: 'album.add', kind: 'single', title: t.title, artist: t.artist, year: plan.singleYear }).then(function(j){
            var file = t.cover >= 0 ? covers[t.cover] : t.embedded ? embBlob(t.file) : null;
            return (file ? cover(j.id, file, t.cover < 0) : Promise.resolve()).then(function(){ return j.id; });
          });
        return made.then(function(id){
          into = id;
          return durationOf(f);
        }).then(function(d){
          var q = '?album=' + into + '&kind=track&no=' + t.no + '&title=' + encodeURIComponent(t.title) + '&duration=' + d;
          return req('POST', '/curio/api/music-upload' + q, f, audioType(f));
        }).then(function(r){
          /* 曲目的歌手（写 artist_id）和歌词：一个 track.edit，有才发 */
          var body = { op: 'track.edit', id: r.id };
          if (t.artist) body.artist = t.artist;
          return (t.lrc >= 0 ? readText(lrcs[t.lrc]) : Promise.resolve(null)).then(function(text){
            if (text) body.lrc = text;
            if (Object.keys(body).length <= 2) return null;
            if (body.lrc) upMsg(T.lyrics);
            return req('POST', '/curio/api/music', body);
          });
        }).catch(function(e){ if (e && e.sgxLocked) throw e; failed++; });
      });
    });
    return chain;
  }).then(function(){
    return req('GET', '/curio/api/music');
  }).then(function(j){
    coverVer = Date.now();
    var toSingles = !plan.album;
    setData(j.albums, toSingles ? 'single' : 'album');
    var i = albums.map(function(a){ return a.id; }).indexOf(albumId);
    renderCovers();
    if (toSingles) renderAlbum(); else select(i < 0 ? 0 : i, true);
    upDropPreview();
    upSheet.close();
    toast(failed ? T.partial(failed) : T.saved);
  }).catch(function(e){ if (!e || !e.sgxLocked) upMsg(failMsg(e), true); });
}

/* ---------- 导入后编辑（M3，音乐 v1.18 十二 M3 / 7.4 / 7.6） ----------
 * 曲目行 / 单曲行「⋯」→ #mu-ed-wrap：歌名、歌手（M4 之前只填文本，不联想）、所属专辑（只列 kind=album 按名排序，顶上「移出变单曲」）、歌词；
 *   单曲多一个封面、一个年份（专辑里的曲目不设封面，7.6；单曲选了划进专辑 → 封面不传、年份不发，跟专辑走）。所有改动一个 track.edit（后端一个 batch）：
 *   单曲改名 / 改年份由后端在同一个 batch 写进单曲记录（Gray 审 1、3）；换封面走 music-upload kind=cover。
 *   左下「删除」→ 确认卡片（同删除单曲）→ track.del（curio-write 档；单曲唯一一首 → 后端连空单曲记录和封面一起删）。
 * 专辑标题旁「编辑」→ #mu-ae-wrap：名、歌手、年份（album.edit）+ 封面（music-upload kind=cover），一个入口统一改整张专辑。
 * 多选 → 「批量改」→ #mu-be-wrap：歌手、移专辑；年份只对单曲（跟歌手同一个 track.edit，后端写单曲记录）。每条一个请求（batchRequests），失败的列出来。 */
function mkSheet(dlg, key){
  return G.SgxModalSheet ? G.SgxModalSheet(dlg, doc.createElement('span'), { ms: 240, reducedMs: 120, stateKey: key, modal: false, onOpen: function(){ upLock(true); }, onClosed: function(){ upLock(false); } })
    : { open: function(){ if (!dlg.open) { dlg.show(); dlg.classList.add('is-open'); upLock(true); } }, close: function(after){ if (dlg.open) { dlg.classList.remove('is-open'); dlg.close(); } upLock(false); if (after) after(); } };
}
function wire(dlg, sh, x){
  dlg.addEventListener('click', function(e){ if (e.target === dlg) sh.close(); });
  $(x).addEventListener('click', function(){ sh.close(); });
  openSheets.push(function(){ return dlg.open ? sh : null; });
}
function msgOf(id){ return function(m, bad){ var el = $(id); el.textContent = m || ''; el.classList.toggle('hidden', !m); el.classList.toggle('text-m-error', !!bad); }; }
/** 写失败的一句话：上限 / 封面复制失败 / 没权限，其余「出了点问题」 */
function errText(e){
  var c = e && e.code;
  if (c === 'limit') return T.errLimit || T.failed;
  if (c === 'storage') return T.errStorage || T.failed;
  return failMsg(e);
}
function fillAlbums(selEl, top, pick){
  selEl.innerHTML = top.map(function(o){ return '<option value="' + esc(o.v) + '">' + esc(o.t) + '</option>'; }).join('')
    + albumChoices(all, lang).map(function(a){ return '<option value="' + a.id + '">' + esc(a.title) + '</option>'; }).join('');
  selEl.value = String(pick);
}
/** 歌单换了（编辑之后）：重画，当前专辑按 id 留住 */
function refresh(list){
  var keep = album() ? album().id : 0;
  setData(list);
  var i = albums.map(function(a){ return a.id; }).indexOf(keep);
  if (i >= 0) cur = i;
  renderCovers(); renderAlbum();
}
function upCover(albumId, file){
  return cropCover(file).then(function(b){ return req('POST', '/curio/api/music-upload?album=' + albumId + '&kind=cover', b, b.type); }).then(function(){ coverVer = Date.now(); });
}
function coverPreview(img, a){
  img.classList.toggle('hidden', !(a && a.cover));
  if (a && a.cover) img.src = coverUrl(a); else img.removeAttribute('src');
}

/* --- 曲目 / 单曲 --- */
var edDlg = $('#mu-ed-wrap'), edSheet = mkSheet(edDlg, 'sgxMuEd');
wire(edDlg, edSheet, '#mu-ed-x');
var edMsg = msgOf('#mu-ed-msg');
/** ed = {a: 所在专辑 / 单曲记录, t: 曲目, single, lrc: 读出来的歌词（null = 有但没读出来；'' = 没有）, cover: 新选的封面, gen} */
var ed = null, edGen = 0;
function edCoverName(){
  var into = ed.single && $('#mu-ed-album').value !== '0';
  $('#mu-ed-cover').disabled = into;
  $('#mu-ed-year').disabled = into;  /* 划进专辑：年份跟专辑走，不发 */
  $('#mu-ed-cover-name').textContent = into ? T.coverAlbum : ed.cover ? ed.cover.name : ed.a.cover ? T.coverHas : T.coverPick;
}
/** 歌词正文只在签播放令牌时给（GET 只说有没有）：直接调 music-play 读这张的歌词，不走 req（401 不切只看模式、不请人进站） */
function loadLrc(albumId, trackId){
  return fetch('/curio/api/music-play', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ album: albumId }) })
    .then(function(r){ return r.json(); })
    .then(function(j){
      var hit = j && j.ok && (j.tracks || []).filter(function(x){ return x.id === trackId; })[0];
      if (!hit || typeof hit.lrc !== 'string') throw new Error('lrc');
      return hit.lrc;
    });
}
function openTrackEdit(a, t){
  if (!canWrite || !a || !t) return;
  var single = CORE.isSingle(a), gen = ++edGen;
  ed = { a: a, t: t, single: single, lrc: t.lrc ? null : '', cover: null };
  $('#mu-ed-form').reset();
  $('#mu-ed-title').textContent = single ? T.editSingle : T.editTrack;
  $('#mu-ed-name').value = single ? a.title : t.title;
  $('#mu-ed-artist').value = single ? (a.artist || '') : (t.artist || '');
  fillAlbums($('#mu-ed-album'), [{ v: '0', t: single ? T.stayNoAlbum : T.moveOut }], single ? '0' : a.id);
  $('#mu-ed-cover-row').classList.toggle('hidden', !single);
  $('#mu-ed-year-row').classList.toggle('hidden', !single);
  $('#mu-ed-year').value = single && a.year ? String(a.year) : '';
  if (single) { coverPreview($('#mu-ed-cover-img'), a); edCoverName(); }
  var ta = $('#mu-ed-lrc'), note = $('#mu-ed-lrc-note');
  ta.value = ''; ta.disabled = !!t.lrc; note.classList.toggle('hidden', !t.lrc); note.textContent = t.lrc ? T.lrcLoading : '';
  if (t.lrc) loadLrc(a.id, t.id).then(function(text){
    if (gen !== edGen) return;
    ed.lrc = text; ta.value = text; ta.disabled = false; note.classList.add('hidden');
  }).catch(function(){ if (gen !== edGen) return; ta.disabled = false; note.textContent = T.lrcUnread; });
  edMsg(''); $('#mu-ed-save').disabled = false; $('#mu-ed-del').disabled = false;
  edSheet.open();
}
$('#mu-ed-album').addEventListener('change', function(){ if (ed && ed.single) edCoverName(); });
$('#mu-ed-cover').addEventListener('change', function(){ if (!ed) return; ed.cover = this.files && this.files[0] || null; edCoverName(); });
$('#mu-ed-save').addEventListener('click', function(){
  if (!ed) return;
  var e0 = ed, a = e0.a, t = e0.t, single = e0.single, btn = this;
  var name = $('#mu-ed-name').value.trim();
  if (!name) return edMsg(T.needSong, true);
  var yr = null;
  if (single && !$('#mu-ed-year').disabled) { yr = yearOf($('#mu-ed-year').value); if (yr === null) return edMsg(T.badYear, true); }
  var body = trackEditBody({ id: t.id, title: single ? a.title : t.title, artist: single ? a.artist : t.artist, year: single ? a.year : 0 }, { albumId: a.id, single: single },
    { title: name, artist: $('#mu-ed-artist').value, album: $('#mu-ed-album').value, lrc: $('#mu-ed-lrc').disabled ? null : lrcChange(e0.lrc, $('#mu-ed-lrc').value), year: yr });
  var stay = !(body && body.album_id !== undefined);  /* 没移走 */
  var cover = single && stay && e0.cover;
  if (!body && !cover) return edSheet.close();
  btn.disabled = true; edMsg('');
  var list = null;
  /* 歌名、歌手、歌词、所属专辑、单曲的名 / 年份：一个 track.edit（后端一个 batch）；换封面另走 music-upload */
  (body ? req('POST', '/curio/api/music', body) : Promise.resolve(null)).then(function(j){
    if (j) list = j.albums;
  }).then(function(){
    if (!cover) return null;
    edMsg(T.cover);
    return upCover(a.id, cover).then(function(){ return req('GET', '/curio/api/music'); }).then(function(j3){ list = j3.albums; });
  }).then(function(){
    if (list) refresh(list);
    edSheet.close(); toast(T.savedEdit);
  }).catch(function(e){
    if (list) refresh(list);
    if (!e.sgxLocked) edMsg(errText(e), true);
  }).then(function(){ btn.disabled = false; });
});
/* 删曲目：先关编辑窗、等它的历史哨兵出栈，再弹确认卡片（同上传窗关了再开顶栏窗口） */
$('#mu-ed-del').addEventListener('click', function(){
  if (!ed) return;
  var a = ed.a, t = ed.t, single = ed.single;
  edSheet.close(function(){ G.setTimeout(function(){
    askDel({
      title: single ? T.delSingleTitle : T.delTrackTitle,
      msg: tr(single ? 'delSingle' : 'delTrack', { name: single ? a.title : t.title }),
      run: function(){ return req('POST', '/curio/api/music', { op: 'track.del', id: t.id }); },
      stops: function(){ var c = P.state.list && P.state.list[P.state.i]; return P.state.album === a.id && (single || !!(c && c.id === t.id)); },
    });
  }, 0); });
});

/* --- 专辑 --- */
var aeDlg = $('#mu-ae-wrap'), aeSheet = mkSheet(aeDlg, 'sgxMuAe');
wire(aeDlg, aeSheet, '#mu-ae-x');
var aeMsg = msgOf('#mu-ae-msg');
var ae = null;
function aeCoverName(){ $('#mu-ae-cover-name').textContent = ae.cover ? ae.cover.name : ae.a.cover ? T.coverHas : T.coverPick; }
$('#mu-album-edit').addEventListener('click', function(){
  var a = album();
  if (!a || !canWrite) return;
  ae = { a: a, cover: null };
  $('#mu-ae-form').reset();
  $('#mu-ae-name').value = a.title; $('#mu-ae-artist').value = a.artist || ''; $('#mu-ae-year').value = a.year ? String(a.year) : '';
  coverPreview($('#mu-ae-cover-img'), a); aeCoverName();
  aeMsg(''); $('#mu-ae-save').disabled = false;
  aeSheet.open();
});
$('#mu-ae-cover').addEventListener('change', function(){ if (!ae) return; ae.cover = this.files && this.files[0] || null; aeCoverName(); });
$('#mu-ae-save').addEventListener('click', function(){
  if (!ae) return;
  var a = ae.a, file = ae.cover, btn = this;
  var name = $('#mu-ae-name').value.trim(), artist = $('#mu-ae-artist').value.trim(), yr = yearOf($('#mu-ae-year').value);
  if (!name) return aeMsg(T.needName, true);
  if (yr === null) return aeMsg(T.badYear, true);
  var b = { op: 'album.edit', id: a.id };
  if (name !== a.title) b.title = name;
  if (artist !== String(a.artist || '')) b.artist = artist;
  if (yr !== (a.year || 0)) b.year = yr;
  var edit = Object.keys(b).length > 2;
  if (!edit && !file) return aeSheet.close();
  btn.disabled = true; aeMsg('');
  var list = null;
  (edit ? req('POST', '/curio/api/music', b) : Promise.resolve(null)).then(function(j){
    if (j) list = j.albums;
    if (!file) return null;
    aeMsg(T.cover);
    return upCover(a.id, file).then(function(){ return req('GET', '/curio/api/music'); }).then(function(j2){ list = j2.albums; });
  }).then(function(){
    if (list) refresh(list);
    aeSheet.close(); toast(T.savedEdit);
  }).catch(function(e){
    if (list) refresh(list);
    if (!e.sgxLocked) aeMsg(errText(e), true);
  }).then(function(){ btn.disabled = false; });
});

/* --- 多选 / 批量改 --- */
/** 多选条：能写、这一边有东西才显示；没在多选 =「多选」，在多选 =「已选 n 首 · 批量改 · 取消」 */
function renderSelBar(a, inAlb){
  var has = inAlb ? !!(a && a.tracks.length) : singles.length > 0;
  var bar = $('#mu-sel-bar');
  bar.classList.toggle('hidden', !canWrite || !has);
  if (!has && sel.on) selExit();
  var n = selCount();
  $('#mu-sel-n').textContent = sel.on ? (n ? T.selN(n) : T.selNone) : '';
  $('#mu-sel').classList.toggle('hidden', sel.on);
  $('#mu-sel-edit').classList.toggle('hidden', !sel.on);
  $('#mu-sel-x').classList.toggle('hidden', !sel.on);
  $('#mu-sel-edit').disabled = !n;
}
function selToggle(id){ if (sel.ids[id]) delete sel.ids[id]; else sel.ids[id] = 1; renderAlbum(); }
$('#mu-sel').addEventListener('click', function(){ sel.on = true; sel.ids = {}; renderAlbum(); });
$('#mu-sel-x').addEventListener('click', function(){ selExit(); renderAlbum(); });
var beDlg = $('#mu-be-wrap'), beSheet = mkSheet(beDlg, 'sgxMuBe');
wire(beDlg, beSheet, '#mu-be-x');
var beMsg = msgOf('#mu-be-msg');
/** 选中的条目 → batchRequests 的 items（专辑页：本专辑的曲目；单曲区：单曲记录和它那一首） */
function selItems(){
  if (sec === 'single') return singles.filter(function(s){ return sel.ids[s.id] && s.tracks[0]; }).map(function(s){ return { trackId: s.tracks[0].id, albumId: s.id, name: s.title }; });
  var a = album();
  return a ? a.tracks.filter(function(t){ return sel.ids[t.id]; }).map(function(t){ return { trackId: t.id, albumId: a.id, name: t.title }; }) : [];
}
$('#mu-sel-edit').addEventListener('click', function(){
  if (!selCount()) return;
  var one = sec === 'single';
  $('#mu-be-form').reset();
  fillAlbums($('#mu-be-album'), [{ v: '', t: T.keep }].concat(one ? [] : [{ v: '0', t: T.moveOut }]), '');
  $('#mu-be-year-row').classList.toggle('hidden', !one);
  beMsg(''); $('#mu-be-save').disabled = false;
  beSheet.open();
});
$('#mu-be-save').addEventListener('click', function(){
  var one = sec === 'single', btn = this;
  var yv = $('#mu-be-year').value.trim();
  if (one && yv && !yearOf(yv)) return beMsg(T.badYear, true);
  var plan = batchRequests(selItems(), { artist: $('#mu-be-artist').value, album: $('#mu-be-album').value, year: one && yv ? yearOf(yv) : '' }, one);
  if (!plan.length) return beSheet.close();
  btn.disabled = true; beMsg('');
  var fails = [], list = null, locked = false;
  var chain = Promise.resolve();
  plan.forEach(function(item){
    chain = chain.then(function(){
      if (locked) return null;
      return req('POST', '/curio/api/music', item.body).then(function(j){ list = j.albums; }).catch(function(e){ if (e.sgxLocked) { locked = true; return; } fails.push(item.name + '：' + errText(e)); });
    });
  });
  chain.then(function(){
    if (list) refresh(list);
    if (locked) return;
    if (fails.length) { beMsg(T.batchFail(fails.length) + '\n' + fails.join('\n'), true); return; }
    selExit(); renderAlbum();
    beSheet.close(); toast(T.batchDone(plan.length));
  }).then(function(){ btn.disabled = false; });
});

/* ---------- 歌手页（M4，音乐 v1.19 7.5 / 十二 M4） ----------
 * 视图 ?artist=<id>（pushState，不重新加载）；popstate 跟着地址换（弹层的历史哨兵地址不变，不会误触发）。 */
function goArtist(id, opt){
  id = Number(id) || 0;
  if (id === view && !(opt && opt.album)) return;
  view = id; selExit();
  try { G.history.pushState({ sgxMuArtist: id }, '', id ? '?artist=' + id : G.location.pathname + G.location.hash); } catch (e) {}
  if (!id && opt && opt.album) {
    var i = albums.map(function(a){ return a.id; }).indexOf(opt.album);
    if (i >= 0) { cur = i; sec = 'album'; }
  }
  G.scrollTo({ top: 0, behavior: 'auto' });
  renderAlbum();
  if (!id && sec === 'album') { var c = doc.querySelector('.mu-cover[data-i="' + cur + '"]'); if (c) c.scrollIntoView({ inline: 'center', block: 'nearest' }); }
}
G.addEventListener('popstate', function(){
  var v = artistOf(G.location.search);
  if (v === view) return;
  view = v; selExit(); renderAlbum();
});
/* 链接（专辑标题下、播放条里的歌手名、歌手页的返回）：页内换视图；中键 / 修饰键照旧按链接走 */
doc.addEventListener('click', function(e){
  var a = e.target.closest && e.target.closest('a[data-artist]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  goArtist(Number(a.getAttribute('data-artist')) || 0);
});
/* 弹出播放器点了歌手名、顶栏挑中了本页（common/js/frame/topbar/panel.js mountMusic）：页内换视图，不整页跳 */
doc.addEventListener('sgx-music-artist', function(e){
  var id = e && e.detail && Number(e.detail.id);
  if (!(id > 0)) return;
  e.preventDefault();
  goArtist(id);
});
/** 歌手页这一份作品（renderArtist 时记下，点单曲时用） */
var arWorks = { albums: [], singles: [] };
function renderArtist(){
  $('#mu-artist').classList.remove('hidden');
  if (viewOnly) paintViewOnly(null);
  var r = artistById(view);
  $('#mu-ar-missing').classList.toggle('hidden', !!r);
  $('#mu-ar-body').classList.toggle('hidden', !r);
  if (!r) return;
  var w = arWorks = artistWorks(all, r.id);
  $('#mu-ar-name').textContent = r.name;
  $('#mu-ar-sub').textContent = tr('arAlbums', { n: w.albums.length }) + ' · ' + tr('arSingles', { n: w.singles.length });
  $('#mu-ar-style').textContent = r.style || ''; $('#mu-ar-style').classList.toggle('hidden', !r.style);
  $('#mu-ar-bio').textContent = r.bio || ''; $('#mu-ar-bio').classList.toggle('hidden', !r.bio);
  var img = $('#mu-ar-img'), u = avatarUrl(r);
  img.classList.toggle('hidden', !u);
  if (u) { if (img.getAttribute('src') !== u) img.src = u; } else img.removeAttribute('src');
  $('#mu-ar-edit').classList.toggle('hidden', !canWrite);
  $('#mu-ar-albums-h').classList.toggle('hidden', !w.albums.length);
  $('#mu-ar-singles-h').classList.toggle('hidden', !w.singles.length);
  /* 名下没有专辑 / 单曲：别的专辑里收了 TA 的曲目 → 一行提示链到那些专辑；真的什么都没有才说「还没有专辑或单曲」 */
  var empty = !(w.albums.length || w.singles.length), rel = empty ? relatedAlbums(all, r.id) : [];
  $('#mu-ar-none').classList.toggle('hidden', !empty || rel.length > 0);
  var relEl = $('#mu-ar-rel');
  relEl.classList.toggle('hidden', !rel.length);
  relEl.innerHTML = rel.length ? relLine(rel) : '';
  $('#mu-ar-albums').innerHTML = w.albums.map(function(a){
    var u2 = coverUrl(a);
    return '<li><button type="button" class="mu-single" data-al="' + a.id + '">'
      + '<span class="mu-single-im" aria-hidden="true">' + (u2 ? '<img src="' + u2 + '" alt="" loading="lazy" decoding="async" onerror="this.remove()">' : '') + '<span class="mu-cover-ph">' + NOTE + '</span></span>'
      + '<span class="mu-single-tx"><b>' + esc(a.title) + '</b><i>' + esc([a.year ? String(a.year) : '', T.tracks(a.tracks.length)].filter(Boolean).join(' · ')) + '</i></span></button></li>';
  }).join('');
  $('#mu-ar-singles').innerHTML = w.singles.map(function(a, i){
    var t = a.tracks[0], on = !!P.state.queue && P.state.i >= 0 && P.state.album === a.id;
    return '<li><button type="button" class="mu-single' + (on ? ' on' : '') + '" data-as="' + i + '"' + (on ? ' aria-current="true"' : '') + (t ? '' : ' disabled') + '>'
      + singleIm(a)
      + '<span class="mu-single-tx"><b>' + esc(a.title) + '</b><i>' + esc(a.year ? String(a.year) : '') + '</i></span>'
      + '<span class="mu-track-dur">' + (t && t.duration ? fmtTime(t.duration) : '') + '</span></button></li>';
  }).join('');
}
/** 字典里的一句，{name} 处换成一段已转义的 HTML（其余部分转义；先换数字变量，再拼 HTML，专辑名里的「{n}」不会被当成占位） */
function htmlLine(key, slot, html, vars){
  var parts = tr(key, vars).split('{' + slot + '}');
  return esc(parts[0]) + (parts.length > 1 ? html + esc(parts.slice(1).join('{' + slot + '}')) : '');
}
/** 「有曲目收在「A」、「B」、「C」等 n 张专辑里」：最多链三张，多的说个数 */
function relLine(rel){
  var shown = rel.slice(0, 3);
  var links = shown.map(function(a){ return htmlLine('arRelItem', 'a', '<a class="mu-ar-rel-a" href="./" data-rel="' + a.id + '">' + esc(a.title) + '</a>'); }).join(esc(T.arSep || ', '));
  if (rel.length > shown.length) links = htmlLine('arRelMore', 'albums', links, { n: rel.length - shown.length, total: rel.length });
  return htmlLine('arRelOnly', 'albums', links, { n: rel.length });
}
$('#mu-ar-rel').addEventListener('click', function(e){
  var a = e.target.closest('a[data-rel]');
  if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  goArtist(0, { album: Number(a.dataset.rel) });
});
/* 歌手页：点专辑 → 回音乐页那张专辑；点单曲 → 这位歌手的单曲当播放列表（同单曲区） */
$('#mu-ar-albums').addEventListener('click', function(e){
  var b = e.target.closest('[data-al]');
  if (b) goArtist(0, { album: Number(b.dataset.al) });
});
$('#mu-ar-singles').addEventListener('click', function(e){
  var b = e.target.closest('[data-as]');
  if (!b) return;
  if (viewOnly) return askSudo();
  var list = arWorks.singles.filter(function(a){ return a.tracks.length; }), k = list.indexOf(arWorks.singles[Number(b.dataset.as)]);
  if (k >= 0) P.playQueue(list.map(function(a){ return a.id; }), k);
});

/* --- 歌手栏联想（7.5）：同一个 <datalist>；近似名提示可点一下换成已有的 --- */
function fillArtistList(){
  var dl = doc.getElementById('mu-artist-list');
  if (dl) dl.innerHTML = arts.map(function(r){ return '<option value="' + esc(r.name) + '"></option>'; }).join('');
}
['#mu-up-artist', '#mu-ed-artist', '#mu-ae-artist', '#mu-be-artist'].forEach(function(sel1){
  var inp = $(sel1), hint = doc.querySelector('[data-hint-for="' + sel1.slice(1) + '"]');
  if (!inp || !hint) return;
  function paint(){
    var near = similarArtist(inp.value, arts);
    hint.classList.toggle('hidden', !near);
    if (near) { hint.textContent = tr('similar', { name: near }); hint.dataset.name = near; }
  }
  inp.addEventListener('input', paint);
  hint.addEventListener('click', function(){ if (hint.dataset.name) { inp.value = hint.dataset.name; paint(); inp.focus(); } });
  /* 表单 reset / 重新打开时收起 */
  inp.form && inp.form.addEventListener('reset', function(){ hint.classList.add('hidden'); });
});

/* --- 改歌手：名字、风格、简介、头像；合并、删除（root + 一次性票） --- */
var arDlg = $('#mu-ar-wrap'), arSheet = mkSheet(arDlg, 'sgxMuAr');
wire(arDlg, arSheet, '#mu-ar-x');
var arMsg = msgOf('#mu-ar-msg');
/* 名字栏自己的错（没填 / 重名）显示在名字栏正下方（Gray 2026-11-20），其余的错照旧在表单底下 */
var arNameMsg = msgOf('#mu-ar-name-err');
function arNameErr(m){ arNameMsg(m, true); var i = $('#mu-ar-name-in'); if (m) i.setAttribute('aria-invalid', 'true'); else i.removeAttribute('aria-invalid'); }
$('#mu-ar-name-in').addEventListener('input', function(){ arNameErr(''); });
/* 头像预览：选了图就在圆框里先显示（本地 object URL，圆框 object-fit: cover 正好是中间那块正方形，同 squareCrop）；换图 / 重开窗时收掉旧的 */
var arPreview = '';
function arDropPreview(){ if (arPreview) { try { URL.revokeObjectURL(arPreview); } catch (e) {} arPreview = ''; } }
/** ar = {r: 歌手, file: 新选的头像, works: 名下作品数} */
var ar = null;
function arAvatarName(){ $('#mu-ar-av-name').textContent = ar.file ? ar.file.name : ar.r.avatar ? T.avatarHas : T.avatarPick; }
function arErr(e){
  var c = e && e.code;
  if (c === 'artist-exists') return T.errArtistExists || T.failed;
  if (c === 'artist-has-works') return T.errHasWorks || T.failed;
  return failMsg(e);
}
$('#mu-ar-edit').addEventListener('click', function(){
  var r = artistById(view);
  if (!r || !canWrite) return;
  var w = artistWorks(all, r.id);
  /* 名下作品：专辑 / 单曲记录之外，曲目自己也可能指着这位（专辑里改过歌手的曲目），删之前都要算上 */
  var tracks = 0;
  all.forEach(function(a){ a.tracks.forEach(function(t){ if (t.artist_id === r.id && a.artist_id !== r.id) tracks++; }); });
  ar = { r: r, file: null, works: w.albums.length + w.singles.length + tracks };
  $('#mu-ar-form').reset();
  arDropPreview(); arNameErr('');
  $('#mu-ar-name-in').value = r.name; $('#mu-ar-style-in').value = r.style || ''; $('#mu-ar-bio-in').value = r.bio || '';
  var img = $('#mu-ar-av-img'), u = avatarUrl(r);
  img.classList.toggle('hidden', !u); if (u) img.src = u; else img.removeAttribute('src');
  arAvatarName();
  var others = arts.filter(function(x){ return x.id !== r.id; }).slice().sort(function(x, y){ return String(x.name).localeCompare(String(y.name), lang || undefined, { numeric: true, sensitivity: 'base' }) || x.id - y.id; });
  $('#mu-ar-into').innerHTML = '<option value="">' + esc(T.mergePick) + '</option>' + others.map(function(x){ return '<option value="' + x.id + '">' + esc(x.name) + '</option>'; }).join('');
  $('#mu-ar-merge-row').classList.toggle('hidden', !others.length);
  $('#mu-ar-merge').disabled = true;
  $('#mu-ar-del').disabled = ar.works > 0;
  $('#mu-ar-del-note').classList.toggle('hidden', !(ar.works > 0));
  arMsg(''); $('#mu-ar-save').disabled = false;
  arSheet.open();
});
$('#mu-ar-into').addEventListener('change', function(){ $('#mu-ar-merge').disabled = !this.value; });
$('#mu-ar-av').addEventListener('change', function(){
  if (!ar) return;
  ar.file = this.files && this.files[0] || null;
  arAvatarName();
  var img = $('#mu-ar-av-img'), u = ar.file ? '' : avatarUrl(ar.r);
  arDropPreview();
  if (ar.file) { try { arPreview = u = URL.createObjectURL(ar.file); } catch (e) { u = ''; } }
  img.classList.toggle('hidden', !u);
  if (u) img.src = u; else img.removeAttribute('src');
});
/** 头像：取中间的正方形、缩到 ≤ 1000、jpeg（十二 M4 第 2 条）——M2 起封面也是这一套（十二 M2 第 3 条），直接用 cropCover */
var cropAvatar = cropCover;
$('#mu-ar-save').addEventListener('click', function(){
  if (!ar) return;
  var r = ar.r, file = ar.file, btn = this;
  var name = $('#mu-ar-name-in').value.trim(), style = $('#mu-ar-style-in').value.trim(), bio = $('#mu-ar-bio-in').value.trim();
  if (!name) { arNameErr(T.needArtist); return $('#mu-ar-name-in').focus(); }
  var b = { op: 'artist.edit', id: r.id };
  if (name !== r.name) b.name = name;
  if (style !== (r.style || '')) b.style = style;
  if (bio !== (r.bio || '')) b.bio = bio;
  var edit = Object.keys(b).length > 2;
  if (!edit && !file) return arSheet.close();
  btn.disabled = true; arMsg(''); arNameErr('');
  var list = null;
  (edit ? req('POST', '/curio/api/music', b) : Promise.resolve(null)).then(function(j){
    if (j) list = j.albums;
    if (!file) return null;
    arMsg(T.avatarUp);
    return cropAvatar(file).then(function(blob){ return req('POST', '/curio/api/music-upload?artist=' + r.id + '&kind=avatar', blob, 'image/jpeg'); })
      .then(function(){ coverVer = Date.now(); return req('GET', '/curio/api/music'); }).then(function(j2){ list = j2.albums; });
  }).then(function(){
    if (list) refresh(list);
    arDropPreview();
    arSheet.close(); toast(T.savedEdit);
  }).catch(function(e){
    if (list) refresh(list);
    if (e.sgxLocked) return;
    if (e && e.code === 'artist-exists') { arMsg(''); arNameErr(arErr(e)); $('#mu-ar-name-in').focus(); } else arMsg(arErr(e), true);
  }).then(function(){ btn.disabled = false; });
});
/** root 档（合并 / 删歌手）：先领一次性票再发（同删专辑 delAlbum） */
function rootOp(body, line){
  var get = UI && UI.sudoTicket ? UI.sudoTicket(line, { method: 'POST', path: '/curio/api/music', action: body.op }) : Promise.resolve('');
  return get.then(function(t){ return req('POST', '/curio/api/music', body, undefined, t); });
}
$('#mu-ar-merge').addEventListener('click', function(){
  if (!ar) return;
  var from = ar.r, into = artistById(Number($('#mu-ar-into').value));
  if (!into) return;
  arSheet.close(function(){ G.setTimeout(function(){
    askDel({ title: T.mergeTitle, msg: tr('mergeMsg', { from: from.name, to: into.name }), ok: T.mergeOk, done: T.merged, err: arErr,
      run: function(){ return rootOp({ op: 'artist.merge', id: from.id, into: into.id }, 'sudo curio music artist merge ' + from.id + ' ' + into.id); },
      stops: function(){ return false; },
      after: function(){ goArtist(into.id); } });
  }, 0); });
});
$('#mu-ar-del').addEventListener('click', function(){
  if (!ar || ar.works > 0) return;
  var r = ar.r;
  arSheet.close(function(){ G.setTimeout(function(){
    askDel({ title: T.delArtistTitle, msg: tr('delArtist', { name: r.name }), err: arErr,
      run: function(){ return rootOp({ op: 'artist.del', id: r.id }, 'sudo curio music artist rm ' + r.id); },
      stops: function(){ return false; },
      after: function(){ goArtist(0); } });
  }, 0); });
});

/* ---------- 启动 ---------- */
function done(){ doc.querySelectorAll('.it-loading').forEach(function(el){ el.classList.add('hidden'); }); }
req('GET', '/curio/api/music').then(function(j){
  setData(j.albums);
  canWrite = !!j.canWrite;
  done();
  $('#mu-app').classList.remove('hidden');
  $('#mu-upload').classList.toggle('hidden', !canWrite);
  renderCovers();
  if (viewOnly) setViewOnly(true); else renderAlbum();
}).catch(function(){
  done();
  var p = doc.querySelector('.it-loading'); if (p) { p.textContent = (T.loadFail || T.failed); p.classList.remove('hidden'); }
});
})();
