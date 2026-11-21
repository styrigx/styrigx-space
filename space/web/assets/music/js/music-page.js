/* assets/music/js/music-page.js —— 音乐页（/music/，中文 /music/zh/；浏览器 IIFE；node 测试时导出纯函数）。
 * music 搬家第 3 步（搬家设计稿 v1.1 3.1–3.3，2026-11-21）：原 assets/curio/js/curio-music.js（奇趣「音乐」子页 /curio/music/），音乐升为第四个子站，
 * 接口改走 /music/api/*；本页不再出声——播放条、<audio>、同步歌词、倍速都删了，发声只归弹出播放器 /music/player/（Gray 2026-11-21 02:02–02:09）。
 *
 * 三层（v5 S3；接口档在账号 Worker core/route-access.js 与 workers/atlas-core/src/curio/routes.js ROUTE_ACCESS）：
 *   - 看：GET /music/api/music 谁都能调（只有专辑 / 曲目元数据，没有音频地址）；回 canManage（music-manage）才显示上传 / 删除专辑。
 *   - 听：要进站。没进站（网关标记 <html data-sgx-lock-session="locked">，或接口回 401）= 只看模式（html.mu-view-only）：
 *     「播放整张」是锁；点播放、点曲目都发 sgx:sudo（经 curio.js SgxCurioUI.sudo；= common/js/auth/sudo.js SUDO_EVENT），顶栏终端预填 su ，不开播放器。
 *   - 写的接口 401 同样按没进站处理。
 * 播放 = 交给弹出播放器（3.3）：
 *   - 封面横滑切专辑（scroll-snap，停下来的那张是当前专辑；点封面也能切），下面是这张的曲目（按曲序）。
 *   - 「播放整张」= 从第 1 首；点某一首 = 从那首。单曲区 / 歌手页单曲区 = 那一列单曲当播放列表（queue）。
 *   - 播放器开着：BroadcastChannel「sgx-music」发 remote-cmd {cmd:'play', album, i}（单曲 {cmd:'play', queue:[单曲记录 id…], i}），播放器换到那张、从第 i 首放。
 *     本页不等 player-hello 的回答，点一下总是发（没开就没人收；刚加载就点也不会漏，见 handOff）。
 *   - 然后发可取消的 sgx-music-open {url}，顶栏 mountMusic（common/js/frame/topbar/panel.js）用开顶栏音乐图标同一套 go()：
 *     同名单窗口 sgx-music-player，已开就只切过去（不重新加载），没开就开 /music/player/?album=<id>&t=<i>（手机新标签页，被拦整页跳）。
 *     没有顶栏接（不该发生）就本页直接跳过去。新开的播放器没有用户手势、自动播放被拦时停在那首、播放键亮着（不另想绕法）。
 *   - 不在本页标出正在播的曲目（Gray 2026-11-21 14:17）。
 * 上传（M2 PR-a 起，见「上传」一节）：分段「单首 | 批量」；歌名 / 歌手按音频标签（music-tags.js）、没有再按文件名预填；单首选「不划 / 新建 / 已有专辑」，
 *   批量选「这批划入哪个专辑」；封面裁方、≤ 1000、jpeg；音频按文件名排序直传（单个 ≤ 95 MB）→ 每首一个 track.edit 写歌手 / 歌词。
 *   PR-b：一次 2 首、每首状态 + XHR 进度、只重试失败的（不重建记录）、拖放、去重提醒（可跳过）、没对上的歌词 / 封面手动配对。
 * 单曲 / 专辑分类（音乐 v1.13 ②，Gray 2026-11-14 17:33 定）：
 *   - 列表每条带 kind；页面分段「专辑 · 单曲」（两边都有才显示分段，哪边为空只显示有的那边）。专辑 = 封面横滑照旧；
 *     单曲 = 列表（小封面 · 歌名 · 歌手 · 时长），点一行 = 交给播放器，单曲区当播放列表。
 * 歌手页（M4，音乐 v1.19 7.5 / 十二 M4）：
 *   - 不加新路由：本页 ?artist=<id> 视图（history.pushState 换视图，不重新加载）；头部头像（没有用默认图标）、名字、
 *     专辑数和单曲数（有简介 / 风格才显示），下面专辑一区、单曲一区。点专辑回到音乐页那张专辑；单曲区点一首 = 这位歌手的单曲当播放列表交给播放器。
 *   - 入口：专辑标题下的歌手名、单曲行的歌手名（链接 / data-artist）；弹出播放器里的歌手名经 BroadcastChannel 让主窗口切过来
 *     （顶栏 mountMusic 收 artist-go 发 sgx-music-artist 事件，本页接住就在页内换视图，不接就整页跳过来）。
 *   - 改歌手（能写才有「编辑」）：名字、风格、简介（artist.edit，music-manage）+ 头像（浏览器裁方、≤ 1000、jpeg，music-upload kind=avatar）；
 *     合并到另一个歌手（artist.merge）、删歌手（artist.del，名下没作品才能删）都是 root 档：先确认，再领一次性票（同删专辑）。
 *   - 单曲没封面：封面空 → 歌手头像 → 默认图（共用核 coverOf）。
 *   - 歌手栏联想（7.5「输入带联想」）：上传 / 编辑 / 批量改的歌手栏挂同一个 <datalist>（已有歌手）；输入和已有歌手只差大小写 / 空格时提示一句，可点一下换成已有的。
 * 确认框、提示条、弹层开关、sudo / sudoTicket 借 curio.js 的（window.SgxCurioUI）——技术债（3.1 第 3 条）：搬家做完再挪进 common。
 */
(function(){
"use strict";
var G = typeof globalThis !== 'undefined' ? globalThis : this;

/* 共用核 music-core.js 的纯函数（单曲判断、封面、时长、歌手页地址、频道名）；本页不再 createPlayer（3.3） */
var CORE = typeof module !== 'undefined' && module.exports ? require('../../common/js/music/music-core.js') : G.SgxMusicCore;
/* 上传预填（读标签、清理文件名，M2）在 music-tags.js */
var TAGS = typeof module !== 'undefined' && module.exports ? require('./music-tags.js') : G.SgxMusicTags;
var fmtTime = CORE.fmtTime;
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
/** 地址里的 ?album=<专辑记录编号>（主页专辑格子直达，同 artistOf）；没有 / 不对 0 */
function albumOf(search){ var m = /[?&]album=(\d+)(?:&|$)/.exec(String(search || '')); var n = m ? Number(m[1]) : 0; return n > 0 && n < 2147483648 ? n : 0; }
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
 *   files: [{name, tags: {title, artist, picture: 有没有内嵌封面}}]（批量已按文件名排好）, covers: [文件名], lrcs: [文件名], pairs: {lrc / cover: {文件下标: 第几首}}（手动配对，PR-b）, preview（只算预览，不查名字） }；list = 歌单（找已有专辑、它的曲序）。
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
  /* 手动配对（PR-b，7.4「没配上的列出来手动对」）先占位，剩下的再按文件名对 */
  var manL = applyPairs(o.pairs && o.pairs.lrc, lrcs.length, files.length, usedL);
  var manC = useCovers ? applyPairs(o.pairs && o.pairs.cover, covers.length, files.length, usedC) : {};
  files.forEach(function(f, i){
    var p = TAGS.prefill(f.name, f.tags, { batch: true, fallback: i + 1 });
    var li = manL[i] !== undefined ? manL[i] : matchFile(f.name, lrcs, usedL); if (li >= 0) usedL[li] = true;
    var ci = manC[i] !== undefined ? manC[i] : useCovers ? matchFile(f.name, covers, usedC) : -1; if (ci >= 0) usedC[ci] = true;
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
/** 手动配对 pairs = {文件下标: 第几首音频}（-1 / 缺 = 不配）→ {第几首: 文件下标}，占掉的文件记进 used；一首只认第一个配给它的 */
function applyPairs(pairs, nFiles, nTracks, used){
  var by = {};
  Object.keys(pairs || {}).forEach(function(k){
    var f = Number(k), a = Number(pairs[k]);
    if (!(f >= 0 && f < nFiles) || !(a >= 0 && a < nTracks) || by[a] !== undefined || used[f]) return;
    by[a] = f; used[f] = true;
  });
  return by;
}

/* ---------- 上传 PR-b（并发 2、每文件状态、只重试失败、XHR 进度、去重提醒；7.4 / 十二 M2 第 1、4 条）的纯函数 ---------- */
/** 一次同时传几首（7.4「并发建议一次传 2 个」） */
var UP_CONC = 2;
/** 进度百分比：服务器回话之前最多 99（字节传完了还要等它写 R2 / D1） */
function pctOf(loaded, total){ if (!(total > 0)) return 0; return Math.max(0, Math.min(99, Math.floor(loaded * 100 / total))); }
/** 比歌名 / 歌手用的键：不分大小写、去掉空白（同近似歌手 artistKey） */
function dupKey(s){ return artistKey(s); }
/**
 * 去重提醒（十二 M2 第 4 条：只提醒，可勾选跳过，不拦）。f = {title, artist, duration（秒，0 = 不知道）, size（字节）}；list = 歌单（写的人能拿到 size）。
 * 算重复：歌名一样，且 ①歌手一样、时长差不超过 1 秒（「歌名 + 歌手 + 时长」）或 ②文件大小一样（「文件名 + 大小」：库里不存文件名，用歌名代替）。
 * 曲目没自己的歌手就看专辑的。→ 第一条对上的 {title, artist, album（单曲 ''）} 或 null
 */
function dupOf(f, list){
  if (!dupKey(f && f.title)) return null;
  for (var i = 0; list && i < list.length; i++) {
    var a = list[i], ts = a.tracks || [];
    for (var j = 0; j < ts.length; j++) {
      var t = ts[j], who = t.artist || a.artist || '';
      if (sameSong(f, { title: t.title, artist: who, duration: t.duration, size: t.size })) return { title: t.title, artist: who, album: CORE.isSingle(a) ? '' : a.title };
    }
  }
  return null;
}
/** 两首算不算重复（dupOf / batchDups 共用）：歌名一样（不分大小写、去空白），且 ①歌手一样、时长都知道且差不超过 1 秒，或 ②文件大小一样 */
function sameSong(f, g){
  var tk = dupKey(f && f.title);
  if (!tk || !g || dupKey(g.title) !== tk) return false;
  var meta = dupKey(g.artist) === dupKey(f.artist) && f.duration > 0 && g.duration > 0 && Math.abs(g.duration - f.duration) <= 1;
  return meta || (f.size > 0 && g.size === f.size);
}
/**
 * 同一批里的重复（Gray 2026-11-20 定 3）：每首和这批排在它前面的比，规则同 dupOf（sameSong）；只提醒、可勾跳过，不拦。
 * fs = 这批每首 [{title, artist, duration, size}]（按右栏的顺序）→ 每首 null 或 {batch: 前面那首是这批第几首（从 1 数）, title}；第一份不算重复。
 */
function batchDups(fs){
  var out = [];
  for (var i = 0; fs && i < fs.length; i++) {
    var hit = null;
    for (var j = 0; j < i && !hit; j++) if (sameSong(fs[i], fs[j])) hit = { batch: j + 1, title: fs[j].title };
    out.push(hit);
  }
  return out;
}
/** 失败原因 → 文案键（每文件状态「失败：原因」） */
function upReason(e){
  var c = e && (e.sgxLocked ? 'locked' : e.code);
  return ({ locked: 'whyLocked', network: 'whyNetwork', 'too-large': 'whyTooLarge', 'not-audio': 'whyNotAudio', limit: 'errLimit', 'single-full': 'singleFull',
    'not-found': 'whyAlbumGone', albumGone: 'whyAlbumGone', storage: 'whyStorage', forbidden: 'noPermission', cover: 'whyCover', edit: 'whyEdit', album: 'whyAlbum' })[c] || 'whyOther';
}
/** 能接着用的空单曲记录（上次传到一半留下的：没有曲目，歌名、歌手都一样）；taken = 这次已经占用的记录 id → id 或 0 */
function emptySingle(list, title, artist, taken){
  var tt = String(title || '').trim(), aa = String(artist || '').trim();
  for (var i = 0; list && i < list.length; i++) {
    var a = list[i];
    if (CORE.isSingle(a) && !(a.tracks || []).length && String(a.title || '').trim() === tt && String(a.artist || '').trim() === aa && !(taken && taken[a.id])) return a.id;
  }
  return 0;
}
/** 拖进来的文件分三类：音频（认得的类型）/ 歌词 .lrc / 图片；别的算不认识 */
function dropKinds(files){
  var o = { audio: [], lrc: [], cover: [], other: [] };
  Array.prototype.forEach.call(files || [], function(f){
    var n = String(f.name || ''), ty = String(f.type || '');
    if (/\.lrc$/i.test(n)) o.lrc.push(f);
    else if (/^image\//.test(ty) || /\.(jpe?g|png|webp|gif)$/i.test(n)) o.cover.push(f);
    else if (audioType(f)) o.audio.push(f);
    else o.other.push(f);
  });
  return o;
}
/** 封面 / 头像裁切（十二 M2 第 3 条 / M4 第 2 条，同一套）：取中间正方形、≤ 1000、jpeg；质量从 0.86 起，超 3 MB 再降（同后端 coverBytes） */
var COVER_MAX = 3 * 1024 * 1024, COVER_Q = [0.86, 0.72, 0.55];

/* ---------- 播放交给弹出播放器（music 搬家第 3 步 3.3）的纯函数 ---------- */
/** 弹出播放器的窗口名、小窗尺寸（同 common/js/frame/topbar/panel.js MUSIC_WIN / MUSIC_FEATURES；播放器页自己也把 window.name 设成它） */
var PLAYER_WIN = 'sgx-music-player';
/** 音乐页路径 → 播放器页路径：/music/ → /music/player/，/music/zh/ → /music/zh/player/ @param {string} pathname */
function playerPathOf(pathname){ return String(pathname || '/music/').replace(/[^/]*$/, '') + 'player/'; }
/** 没开播放器时开的地址：播放器页 ?album=<记录 id>&t=<第几首（从 0 起）>；单曲 album = 那条单曲记录、t = 0（播放器从单曲组里它那一首开始） */
function playerUrl(pathname, albumId, i){ return playerPathOf(pathname) + '?album=' + Number(albumId) + '&t=' + Number(i); }
/** 发给开着的播放器的 remote-cmd：专辑 {cmd:'play', album, i}；单曲列表 {cmd:'play', queue:[单曲记录 id…], i} @param {{album?: number, queue?: number[], i: number}} o */
function playCmd(o){
  var m = { type: 'remote-cmd', cmd: 'play', i: Number(o.i) };
  if (o.queue) m.queue = o.queue.slice(); else m.album = Number(o.album);
  return m;
}

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

var pure = { readDict: readDict, makeTr: makeTr, TRACK_MAX: TRACK_MAX, fmtTime: fmtTime, PLAYER_WIN: PLAYER_WIN, playerPathOf: playerPathOf, playerUrl: playerUrl, playCmd: playCmd, trackFromName: trackFromName, sortByName: sortByName, audioType: audioType, lrcKey: lrcKey, splitKinds: splitKinds, pickSection: pickSection, albumChoices: albumChoices, lrcChange: lrcChange, trackEditBody: trackEditBody, yearOf: yearOf, batchRequests: batchRequests, artistOf: artistOf, albumOf: albumOf, artistWorks: artistWorks, relatedAlbums: relatedAlbums, similarArtist: similarArtist, squareCrop: squareCrop, matchKey: matchKey, uploadPlan: uploadPlan, applyPairs: applyPairs, UP_CONC: UP_CONC, pctOf: pctOf, dupOf: dupOf, batchDups: batchDups, upReason: upReason, emptySingle: emptySingle, dropKinds: dropKinds, COVER_MAX: COVER_MAX, COVER_Q: COVER_Q };
if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }
G.SgxMusicPage = pure;

var doc = G.document;
if (!doc.getElementById('cu-pane-music')) return;
var UI = G.SgxCurioUI;
var $ = function(s){ return doc.querySelector(s); };
/* 界面文案（语言包化第二部分 2026-11-07）：页面里的 #sgx-i18n-musicPage，模板从字符串表 data/music/i18n/<语言>.yaml 的 js.musicPage 输出，
   已经是「英文表 ← 页面语言表」的合并（缺键回退英文）；本文件不再认识任何语言。带数字的文案走 tr（复数按 Intl.PluralRules）。 */
var lang = doc.documentElement.lang || 'en';
var T = readDict(doc, 'musicPage');
var tr = makeTr(T, lang);
T.tracks = function(n){ return tr('tracks', { n: n }); };
T.tooBig = function(name){ return tr('tooBig', { name: name }); };
T.badType = function(name){ return tr('badType', { name: name }); };
T.chosen = function(n){ return tr('chosen', { n: n }); };
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

function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function toast(m){ if (UI) UI.toast(m); }
/** 只看模式：没进站（网关标记；签令牌 401 时改成 true） */
var viewOnly = doc.documentElement.getAttribute('data-sgx-lock-session') === 'locked';
/** 写的权限（GET /api/music 回的 canManage：music-manage） */
var canManage = false;
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
    return r.json().catch(function(){ return {}; }).then(function(j){ return answer(r.status, j); });
  });
}
/** 回答的统一处理（req 和上传音频的 XHR 共用）：401 = 没进站；不 ok 带 code 抛出；歌手表跟着换 */
function answer(status, j){
  j = j || {};
  if (status === 401) { setViewOnly(true); askSudo(); throw Object.assign(new Error('locked'), { sgxLocked: true }); }
  if (!(status >= 200 && status < 300) || !j.ok) throw Object.assign(new Error(j.error || ('HTTP ' + status)), { code: j.error, status: status });
  if (Array.isArray(j.artists)) { arts = j.artists; fillArtistList(); }  /* M4：歌手表跟着每次回答换 */
  return j;
}
/** 上传音频（PR-b，7.4「换 XMLHttpRequest，不碰后端」）：同 req 的地址、头和回答处理，多一个真实的上传进度 onPct(0–99)；断网 / 超时 code = network */
function xhrUpload(url, body, type, onPct){
  return new Promise(function(resolve, reject){
    var x = new XMLHttpRequest();
    x.open('POST', url, true);
    x.setRequestHeader('Content-Type', type);
    if (x.upload) x.upload.onprogress = function(e){ if (e.lengthComputable && onPct) onPct(pctOf(e.loaded, e.total)); };
    x.onload = function(){
      var j = {};
      try { j = JSON.parse(x.responseText || '{}') || {}; } catch (e) { j = {}; }
      try { resolve(answer(x.status, j)); } catch (e) { reject(e); }
    };
    x.onerror = x.ontimeout = x.onabort = function(){ reject(Object.assign(new Error('network'), { code: 'network' })); };
    x.send(body);
  });
}
/** 失败提示：403 forbidden（2b：v6 身份不在 music-use / music-manage，或 album.del 不是 root）说没权限，其余「出了点问题」 */
function failMsg(e){ return e && e.code === 'forbidden' && T.noPermission ? T.noPermission : T.failed; }
function album(){ return albums[cur] || null; }
/** 删专辑 / 单曲（album.del = root 档，D-3 a′）：先拿票再发；sudo 行带专辑 id */
function delAlbum(id){
  var get = UI && UI.sudoTicket ? UI.sudoTicket('sudo curio music rm ' + id, { method: 'POST', path: '/music/api/music', action: 'album.del' }) : Promise.resolve('');
  return get.then(function(t){ return req('POST', '/music/api/music', { op: 'album.del', id: id }, undefined, t); });
}
/** 封面地址：专辑 / 单曲自己的封面；单曲没有 → 歌手头像；都没有 ''（M4，共用核 coverOf） */
function coverUrl(a){ return CORE.coverOf(a, arts, coverVer); }
function avatarUrl(r){ return r && r.avatar ? '/music/api/music-cover?artist=' + r.id + (coverVer ? '&v=' + coverVer : '') : ''; }
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
/** 单曲列表：小封面 · 歌名 · 歌手 · 时长（本页不标正在播的，3.3） */
function renderSingles(){
  var box = $('#mu-singles');
  box.classList.toggle('hidden', sec !== 'single' || !singles.length);
  if (sec !== 'single') { box.innerHTML = ''; return; }
  box.innerHTML = singles.map(function(a, i){
    var t = a.tracks[0];
    var picked = sel.on && !!sel.ids[a.id];
    return '<li' + (canManage ? ' class="mu-single-row"' : '') + '><button type="button" class="mu-single" data-s="' + i + '"' + (sel.on ? ' aria-pressed="' + picked + '"' : '') + (t ? '' : ' disabled') + '>'
      + (sel.on ? CHECK : '')
      + singleIm(a)
      + '<span class="mu-single-tx"><b>' + esc(a.title) + '</b><i>' + (sel.on ? esc(a.artist || '') : artistLink(a.artist, a.artist_id, true)) + '</i></span>'
      + '<span class="mu-track-dur">' + (t && t.duration ? fmtTime(t.duration) : '') + '</span></button>'
      /* 「⋯」编辑（M3：歌名、歌手、歌词、所属专辑、封面）；多选时不画 */
      + (canManage && t && !sel.on ? '<button type="button" class="mu-more" data-ed="' + i + '" aria-label="' + esc(tr('editBtn', { name: a.title })) + '" title="' + esc(tr('editBtn', { name: a.title })) + '">' + MORE + '</button>' : '')
      /* 删除单曲（同「删除专辑」权限：接口回 canManage 才画；点了先弹确认） */
      + (canManage && !sel.on ? '<button type="button" class="mu-single-del" data-del="' + a.id + '" aria-label="' + esc(tr('delSingleBtn', { name: a.title })) + '" title="' + esc(tr('delSingleBtn', { name: a.title })) + '">' + TRASH + '</button>' : '')
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
  doc.querySelector('.mu-album-acts').classList.toggle('hidden', !a || !canManage || !inAlb);
  $('#mu-album-edit').classList.toggle('hidden', !a || !canManage || !inAlb);
  renderSelBar(a, inAlb);
  $('#mu-tracks').innerHTML = '';
  renderSeg(); renderSingles();
  if (!a || !inAlb) return;
  $('#mu-album-title').textContent = a.title;
  $('#mu-album-sub').innerHTML = [artistLink(a.artist, a.artist_id), a.year ? String(a.year) : '', esc(T.tracks(a.tracks.length))].filter(Boolean).join(' · ');
  $('#mu-play-all').disabled = !a.tracks.length;
  $('#mu-tracks').innerHTML = a.tracks.map(function(t, i){
    var picked = sel.on && !!sel.ids[t.id];
    return '<li' + (canManage ? ' class="mu-track-row"' : '') + '><button type="button" class="mu-track" data-t="' + i + '"' + (sel.on ? ' aria-pressed="' + picked + '"' : '') + '>'
      + (sel.on ? CHECK : '<span class="mu-track-no">' + (t.no || i + 1) + '</span>') + '<span class="mu-track-title">' + esc(t.title) + '</span>'
      + '<span class="mu-track-dur">' + (t.duration ? fmtTime(t.duration) : '') + '</span></button>'
      /* 「⋯」编辑（M3：歌名、歌手、歌词、所属专辑；专辑里的曲目不设封面，7.6）；多选时不画 */
      + (canManage && !sel.on ? '<button type="button" class="mu-more" data-ed="' + i + '" aria-label="' + esc(tr('editBtn', { name: t.title })) + '" title="' + esc(tr('editBtn', { name: t.title })) + '">' + MORE + '</button>' : '')
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
/* 分段切换：专辑 ↔ 单曲（只换显示） */
$('#mu-seg').addEventListener('click', function(e){
  var b = e.target.closest('[data-sec]');
  if (!b || b.dataset.sec === sec) return;
  sec = pickSection(b.dataset.sec, albums.length, singles.length);
  selExit();
  renderAlbum();
  if (sec === 'album') { var c = doc.querySelector('.mu-cover[data-i="' + cur + '"]'); if (c) c.scrollIntoView({ inline: 'center', block: 'nearest' }); }
});
/* 单曲：点一行 = 交给播放器从这首开始，单曲区当播放列表 */
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
/* 封面横滑：停下来以后离中线最近的那张是当前专辑。
   按屏幕位置比（getBoundingClientRect），不用 offsetLeft：offsetLeft 相对最近的定位祖先、不是横滑框，框离页左边远（桌面）时判错，
   会把刚选中 / 刚传完的那张又跳回第一张（搬家前就有，第 3 步在 1440 跑 e2e 时发现，一并修） */
(function(){
  var box = $('#mu-covers'), t = 0;
  box.addEventListener('scroll', function(){
    clearTimeout(t);
    t = setTimeout(function(){
      var r = box.getBoundingClientRect(), mid = r.left + box.clientWidth / 2, best = cur, d = Infinity;
      box.querySelectorAll('.mu-cover').forEach(function(c, i){ var q = c.getBoundingClientRect(), x = Math.abs(q.left + q.width / 2 - mid); if (x < d) { d = x; best = i; } });
      if (best !== cur) select(best, false);
    }, 90);
  }, { passive: true });
  box.addEventListener('click', function(e){ var b = e.target.closest('.mu-cover'); if (b) select(Number(b.dataset.i), true); });
})();

/* ---------- 只看模式（没进站） ---------- */
/** 切到 / 离开只看模式（离开只在本页不会发生：进站后页面重新取）：「播放整张」换锁标；点播放发 sgx:sudo、不开播放器 @param {boolean} v */
function setViewOnly(v){
  viewOnly = v;
  doc.documentElement.classList.toggle('mu-view-only', v);
  var b = $('#mu-play-all');
  if (v) { b.setAttribute('aria-disabled', 'true'); b.setAttribute('aria-label', T.locked); }
  else b.removeAttribute('aria-disabled');
  renderAlbum();
}

/* ---------- 播放 = 交给弹出播放器（music 搬家第 3 步 3.3；本页不出声） ---------- */
/* 本页只发不收：remote-cmd 走 BroadcastChannel「sgx-music」（同页顶栏 mountMusic 也有一个频道对象，它不认 remote-cmd） */
var mc = null;
try { if (typeof G.BroadcastChannel === 'function') mc = new G.BroadcastChannel(CORE.CHANNEL); } catch (e) { mc = null; }
/**
 * 交给播放器（要在这次点击里同步调用：window.open 要用户手势）：
 *   1. 发 remote-cmd play。开着的播放器收到就换到那张、从第 i 首放；没开就没人收，白发一次。
 *      不先等 player-hello 的回答再决定发不发：刚加载就点，回答还没到，会把开着的播放器当成没开（只切过去不放）——总是发，结果一样、没有这个空档。
 *   2. 发可取消的 sgx-music-open {url}：顶栏 mountMusic 用开音乐图标同一套 go()——同名单窗口已开 = 只切过去（不重新加载，靠第 1 步放）；
 *      没开 = 开 url（?album=&t=，新窗口自己从那首放），手机新标签页，被拦整页跳。
 * @param {{album?: number, queue?: number[], i: number}} o @param {number} openAlbum 没开时地址里的 album @param {number} openI 地址里的 t
 */
function handOff(o, openAlbum, openI){
  if (mc) { try { mc.postMessage(playCmd(o)); } catch (e) {} }
  var url = playerUrl(G.location.pathname, openAlbum, openI), ev = null;
  try { ev = new CustomEvent('sgx-music-open', { detail: { url: url }, cancelable: true }); } catch (e) { ev = null; }
  if (ev && !doc.dispatchEvent(ev)) return;
  /* 没有顶栏接：本页直接跳过去（同顶栏 go() 被拦时的退路） */
  G.location.href = url;
}
/** 专辑从第 i 首放 */
function playFrom(a, i){
  if (!a || !a.tracks.length || !(i >= 0 && i < a.tracks.length)) return;
  handOff({ album: a.id, i: i }, a.id, i);
}
/** 一列单曲当播放列表（没有音频的单曲不进列表），从 pick 那条开始 @param {any[]} list @param {any} pick */
function playQueueOf(list, pick){
  var q = list.filter(function(a){ return a.tracks.length; }), k = q.indexOf(pick);
  if (k < 0) return;
  handOff({ queue: q.map(function(a){ return a.id; }), i: k }, pick.id, 0);
}
/** 单曲区当播放列表：从第 i 首开始 */
function playSingles(i){ return playQueueOf(singles, singles[i]); }
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

/* ---------- 删除专辑 ---------- */
$('#mu-album-del').addEventListener('click', function(){
  var a = album();
  if (!a || !UI) return;
  UI.ask(T.delAlbum, T.del, function(){
    delAlbum(a.id).then(function(j){
      setData(j.albums); renderCovers(); renderAlbum(); toast(T.deleted);
    }).catch(function(e){ if (!e.sgxLocked) toast(failMsg(e)); });
  });
});

/* ---------- 删除单曲（v1.13 ②，Gray 2026-11-14 18:40）：每行一个删除键，先弹确认（悬浮卡片 <dialog class="sgx-qp sgx-up mu-del">，同上传窗，不从底部升起），
   确认后复用 album.del（单曲 = kind=single 的专辑记录，连音频 / 封面一起删）；回来的歌单重画，单曲区空了按 pickSection 回到专辑、分段随之隐藏 ---------- */
var delDlg = $('#mu-del-wrap'), delId = 0;
/* M3：同一张确认卡片也给「删曲目」用（十二 M3 第 4 条）：delOp = {title, msg, run() → Promise<歌单>}；删单曲（album.del）照旧 */
var delOp = null;
var delSheet = G.SgxModalSheet ? G.SgxModalSheet(delDlg, doc.createElement('span') /* 共享状态机要一个同步 aria-expanded 的按钮；删除键是每行画的，给个占位 */, { ms: 240, reducedMs: 120, stateKey: 'sgxMuDel', modal: false, onOpen: function(){ upLock(true); }, onClosed: function(){ upLock(false); delId = 0; delOp = null; } })
  : { open: function(){ if (!delDlg.open) { delDlg.show(); delDlg.classList.add('is-open'); upLock(true); } }, close: function(){ if (delDlg.open) { delDlg.classList.remove('is-open'); delDlg.close(); } upLock(false); delId = 0; delOp = null; } };
/** 弹确认：id = 单曲记录 id。删的是它那一首（track.del，music-manage 档，十二 M3 第 4 条；Gray 审 2）：后端连空单曲记录和封面一起删。
 *  没有曲目的单曲记录（旧数据）没有 track.del 可发，才退回 album.del（root + 票） */
function askDelSingle(id){
  var a = singles.filter(function(x){ return x.id === id; })[0];
  if (!a || !canManage) return;
  delId = id;
  var t = a.tracks[0];
  askDel({ title: T.delSingleTitle, msg: tr('delSingle', { name: a.title }),
    run: function(){ return t ? req('POST', '/music/api/music', { op: 'track.del', id: t.id }) : delAlbum(id); } });
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
 * PR-b（十二 M2 第 1、4 条，7.4「批量传到一半失败」）：
 *   - 一次同时传 2 首（UP_CONC）；右栏每首一行状态：等待 / 上传中（XHR 真实进度）/ 完成 / 失败：原因 / 跳过。
 *   - 传完有失败的：窗口留着，底部「重试失败的（n）」只重传失败的那几首，从断的那一步接着来（已建的单曲记录、已传的音频、已写的歌手歌词不再做一遍），
 *     新建专辑只建一次；「放弃剩下的」关窗，留下的空记录不删（见 jobAbandon），下次传同名同歌手的单曲接着用那条空记录（emptySingle）。
 *     关窗（× / 遮罩 / 返回）不丢任务：再点上传回到这次的状态。
 *   - 拖放：文件拖进上传窗就按类型分到音频 / 封面 / 歌词（dropKinds）；单首拖进多首音频自动切到批量。
 *   - 去重提醒（dupOf）：歌名 + 歌手 + 时长，或歌名 + 文件大小，和已有曲目一样就在那一行提醒；批量可勾「跳过这首」，不勾照传，不拦。
 *     同一批里的也比（batchDups，Gray 定 3）：和这批前面某首一样就提醒「和这批第 n 首一样」，同样可勾跳过；库里的重复先报。
 *   - 真在传的时候（job.running）挂 beforeunload，离开 / 刷新先问一下；传完、停在失败、放弃、没任务都摘掉（upGuard，Gray 定 4）。
 *   - 批量没按文件名对上的歌词 / 封面列在右栏，每个一个下拉手动配给某一首（upPairs → uploadPlan pairs）。
 *   - 右栏全用 DOM + textContent 画（文件名、歌名不进 innerHTML）。 */
var upFiles = { audio: [], cover: [], lrc: [], tags: [], dur: [] };
/** 上传窗模式：'one' 单首（默认）/ 'batch' 批量 */
var upMode = 'one', upGen = 0;
/** 用户亲手改过的栏（预填不再覆盖）；预填写进去的值不算 */
var upDirty = { name: false, artist: false };
var upPrev = '';
/* PR-b：手动配对 {lrc / cover: {文件下标: 第几首}}、勾了跳过的 {第几首: true}、这次上传任务（null = 还没开始；见 jobNew） */
var upPairs = { lrc: {}, cover: {} }, upSkip = {}, job = null;
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
    covers: upFiles.cover.map(function(f){ return f.name; }), lrcs: upFiles.lrc.map(function(f){ return f.name; }), pairs: upPairs }, all);
}
function mk(tag, cls, text){ var e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
/** 这一首和已有曲目重复吗（PR-b 去重提醒；时长读出来之前只按大小比） */
function upSong(t){ var f = upFiles.audio[t.file]; return f ? { title: t.title, artist: t.artist, duration: upFiles.dur[t.file] || 0, size: f.size } : null; }
function upDup(t){ var s = upSong(t); return s ? dupOf(s, all) : null; }
/** 每首的状态文字 */
function stText(r){ return r.st === 'up' ? tr('stUp', { p: r.pct }) : r.st === 'wait' ? T.stWait : r.st === 'done' ? T.stDone : r.st === 'fail' ? T.stFail : r.st === 'skip' ? T.stSkip : ''; }
/**
 * 右栏列表（全用 DOM + textContent）：
 *   没开始传：批量列出每首会传成什么（歌名 · 歌手，新歌手标「新」）+ 重复提醒（可勾跳过）+ 没对上的歌词 / 封面（下拉手动配）；单首只在重复时列一行。
 *   传的时候 / 传完：每首一行状态（等待 / 上传中 + 进度条 / 完成 / 失败 + 原因 / 跳过）。
 */
function upList(){
  var box = $('#mu-up-list');
  box.textContent = '';
  var rows, plan;
  if (job) { plan = job.plan; rows = job.items; }
  else {
    plan = upFiles.audio.length ? upPlanNow(true) : { error: 'needAudio' };
    /* 库里的重复先报；没有再看同一批前面的（批量才有） */
    var bd = plan.error || upMode === 'one' ? [] : batchDups(plan.tracks.map(function(t){ return upSong(t) || { title: '' }; }));
    rows = plan.error ? [] : plan.tracks.map(function(t, n){ return { t: t, st: '', dup: upDup(t) || bd[n] || null }; });
  }
  var one = job ? job.one : upMode === 'one';
  if (!rows.length || (one && !job && !rows[0].dup)) { box.classList.add('hidden'); return; }
  var known = {}; arts.forEach(function(r){ known[r.name] = true; });
  box.appendChild(mk('p', 'mu-up-list-h', job ? T.listJob : T.listHead));
  var ol = mk('ol', 'mu-up-rows');
  rows.forEach(function(r){
    var t = r.t, li = mk('li', 'mu-up-row' + (r.st ? ' is-' + r.st : ''));
    li.setAttribute('data-i', String(t.file));
    var top = mk('div', 'mu-up-top');
    top.appendChild(mk('b', null, t.title));
    var who = mk('span', 'mu-up-who');
    if (t.artist) { who.textContent = t.artist; if (!known[t.artist]) who.appendChild(mk('span', 'mu-up-new', T.newArtist)); }
    else who.appendChild(mk('span', 'mu-up-none', T.noArtist));
    top.appendChild(who);
    if (r.st) top.appendChild(mk('span', 'mu-up-st', stText(r)));
    li.appendChild(top);
    if (r.st === 'up') {
      var bar = mk('div', 'mu-up-bar'), fill = mk('i');
      bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', String(r.pct));
      bar.setAttribute('aria-label', t.title);
      fill.style.width = r.pct + '%';
      bar.appendChild(fill); li.appendChild(bar);
    }
    if (r.st === 'fail') li.appendChild(mk('p', 'mu-up-why', T[r.why] || T.whyOther));
    if (!job && r.dup) {
      var d = r.dup;
      li.appendChild(mk('p', 'mu-up-dup', d.batch ? tr('dupBatch', { n: d.batch, title: d.title }) : tr(d.album ? 'dupAlbum' : 'dupSingle', { title: d.title, artist: d.artist || T.noArtist, album: d.album })));
      if (!one) {
        var lab = mk('label', 'mu-up-skip'), cb = mk('input');
        cb.type = 'checkbox'; cb.setAttribute('data-skip', String(t.file)); cb.checked = !!upSkip[t.file];
        lab.appendChild(cb); lab.appendChild(mk('span', null, T.skipThis));
        li.appendChild(lab);
      }
    }
    ol.appendChild(li);
  });
  box.appendChild(ol);
  if (!job && !one) upPairUi(box, plan);
  box.classList.remove('hidden');
}
/** 批量没对上的歌词 / 封面：每个文件一个下拉「配给哪首」（7.4「没配上的列出来手动对」）；手动配过的也留在这里，能改回来 */
function upPairUi(box, plan){
  var kinds = [['lrc', upFiles.lrc, T.pairLrc]];
  if (!plan.album) kinds.push(['cover', upFiles.cover, T.pairCover]);  /* 新建 / 已有专辑不按首配封面 */
  var items = [];
  kinds.forEach(function(k){
    var kind = k[0], auto = {};
    plan.tracks.forEach(function(t){ var v = t[kind]; if (v >= 0 && upPairs[kind][v] === undefined) auto[v] = true; });
    k[1].forEach(function(f, i){ if (!auto[i]) items.push({ kind: kind, i: i, name: f.name, label: k[2] }); });
  });
  if (!items.length) return;
  var sec = mk('div', 'mu-up-pair');
  sec.appendChild(mk('p', 'mu-up-pair-h', T.pairHead));
  items.forEach(function(it){
    var row = mk('label', 'mu-up-pair-row'), sel = mk('select', 'it-select');
    var name = mk('span', 'mu-up-pair-name', it.name);
    name.setAttribute('title', it.name);
    sel.setAttribute('data-pair', it.kind); sel.setAttribute('data-k', String(it.i)); sel.setAttribute('aria-label', tr('pairFor', { name: it.name }));
    var o0 = mk('option', null, T.pairNone); o0.value = '-1'; sel.appendChild(o0);
    plan.tracks.forEach(function(t, n){ var o = mk('option', null, tr('pairTrack', { n: n + 1, title: t.title })); o.value = String(t.file); sel.appendChild(o); });
    var v = upPairs[it.kind][it.i];
    sel.value = v === undefined ? '-1' : String(v);
    row.appendChild(mk('span', 'mu-up-pair-k', it.label)); row.appendChild(name); row.appendChild(sel);
    sec.appendChild(row);
  });
  box.appendChild(sec);
}
var upRaf = 0;
/** 进度事件很密：一帧最多重画一次 */
function upListSoon(){ if (upRaf) return; var f = G.requestAnimationFrame || function(cb){ return G.setTimeout(cb, 16); }; upRaf = f(function(){ upRaf = 0; upList(); }) || 1; }
$('#mu-up-list').addEventListener('change', function(e){
  var x = e.target;
  if (x.hasAttribute('data-skip')) { var n = Number(x.getAttribute('data-skip')); if (x.checked) upSkip[n] = true; else delete upSkip[n]; return; }
  var kind = x.getAttribute('data-pair');
  if (!kind) return;
  var k = Number(x.getAttribute('data-k')), v = Number(x.value), m = upPairs[kind];
  /* 一首只配一个：配给它的旧的先撤掉 */
  Object.keys(m).forEach(function(q){ if (m[q] === v) delete m[q]; });
  if (v >= 0) m[k] = v; else delete m[k];
  upList();
});
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
  upFiles = { audio: [], cover: [], lrc: [], tags: [], dur: [] };
  upPairs = { lrc: {}, cover: {} }; upSkip = {};
  if (!upDirty.name) $('#mu-up-name').value = '';
  if (!upDirty.artist) { $('#mu-up-artist').value = ''; $('#mu-up-artist').dispatchEvent(new Event('input')); }
  upFillAlbums(); upAudioName(); upLayout();
  upMsg('');
}
$('#mu-up-kind').addEventListener('click', function(e){ var b = e.target.closest('[data-kind]'); if (b && b.dataset.kind !== upMode) setUpMode(b.dataset.kind); });
$('#mu-up-album').addEventListener('change', function(){
  /* 不划 → 新建再回来：封面单选 / 多选会变，已选的封面先清掉 */
  $('#mu-up-cover').value = ''; upFiles.cover = []; upPairs.cover = {};
  upLayout(); upMajority();
});
$('#mu-up-name').addEventListener('input', function(e){ if (e.isTrusted) upDirty.name = true; if (!job) upList(); });
$('#mu-up-artist').addEventListener('input', function(e){ if (e.isTrusted) upDirty.artist = true; if (!job) upList(); });
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
/** 回到一张空表（打开上传窗、放弃任务时） */
function upReset(){
  $('#mu-up-form').reset();
  upDirty = { name: false, artist: false };
  upMsg('');
  setUpMode('one');
  upFormLock(false);
}
$('#mu-upload').addEventListener('click', function(){
  /* 有没传完的任务（关过窗）：回到它的状态，不重置 */
  if (!job) upReset();
  upSheet.open();
});
/** 选 / 拖进来音频（PR-b 拖放和选文件同一条路） */
function setAudio(list){
  var one = upMode === 'one', gen = ++upGen;
  upFiles.audio = sortByName(list).slice(0, one ? 1 : undefined);
  upFiles.tags = upFiles.audio.map(function(){ return null; });
  upFiles.dur = upFiles.audio.map(function(){ return 0; });
  upPairs = { lrc: {}, cover: {} }; upSkip = {};
  upAudioName(); upCoverName(); upPrefill(); upList(); upMajority();
  /* 读标签（尽力而为，永远 resolve）；读完再预填一次。换了文件 / 模式（gen 变了）就不管旧的 */
  Promise.all(upFiles.audio.map(function(f, i){
    return TAGS.readTags(f).then(function(g){ if (gen === upGen) upFiles.tags[i] = g; });
  })).then(function(){
    if (gen !== upGen) return;
    upCoverName(); upPrefill(); upList(); upMajority();
  });
  /* 时长（去重提醒「歌名 + 歌手 + 时长」用，上传时也带上）；读完再画一次 */
  Promise.all(upFiles.audio.map(function(f, i){
    return durationOf(f).then(function(d){ if (gen === upGen) upFiles.dur[i] = d; });
  })).then(function(){ if (gen === upGen && !job) upList(); });
}
function setCover(list){
  upFiles.cover = Array.prototype.slice.call(list || []).slice(0, $('#mu-up-cover').multiple ? undefined : 1);
  upPairs.cover = {};
  upCoverName(); upList();
}
function setLrc(list){
  upFiles.lrc = Array.prototype.slice.call(list || []).slice(0, upMode === 'one' ? 1 : undefined);
  upPairs.lrc = {};
  upLrcName(); upList();
}
$('#mu-up-audio').addEventListener('change', function(){ setAudio(this.files); });
$('#mu-up-cover').addEventListener('change', function(){ setCover(this.files); });
$('#mu-up-lrc').addEventListener('change', function(){ setLrc(this.files); });
/* 拖放（PR-b，九「拖放上传」）：文件拖进上传窗（含遮罩）就收，按类型分；传的时候不收。拖着的时候卡片上盖一层「松手加入」 */
var upSheetEl = upDlg.querySelector('.sgx-qp-sheet'), dragN = 0;
function dragHasFiles(e){ var t = e.dataTransfer && e.dataTransfer.types; return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0; }
function dragOff(){ dragN = 0; upSheetEl.classList.remove('is-drag'); }
upDlg.addEventListener('dragenter', function(e){ if (!dragHasFiles(e)) return; e.preventDefault(); if (job) return; dragN++; upSheetEl.classList.add('is-drag'); });
upDlg.addEventListener('dragover', function(e){ if (!dragHasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = job ? 'none' : 'copy'; });
upDlg.addEventListener('dragleave', function(e){ if (!dragHasFiles(e)) return; dragN = Math.max(0, dragN - 1); if (!dragN) dragOff(); });
upDlg.addEventListener('drop', function(e){ if (!dragHasFiles(e)) return; e.preventDefault(); dragOff(); if (!job) upDrop(e.dataTransfer.files); });
function upDrop(files){
  var k = dropKinds(files);
  if (upMode === 'one' && k.audio.length > 1) setUpMode('batch');
  if (k.audio.length) { $('#mu-up-audio').value = ''; setAudio(k.audio); }
  if (k.cover.length && !$('#mu-up-cover').disabled) { $('#mu-up-cover').value = ''; setCover(k.cover); }
  if (k.lrc.length) { $('#mu-up-lrc').value = ''; setLrc(k.lrc); }
  upMsg(k.other.length ? tr('dropOther', { n: k.other.length }) : '', !!k.other.length);
}
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
/** 传的时候表单锁住（文件、栏、分段都不能动）；解锁时按模式 / 目标专辑恢复变灰的栏 */
function upFormLock(on){
  doc.querySelectorAll('#mu-up-form input, #mu-up-form select, #mu-up-form button, #mu-up-kind button').forEach(function(x){ x.disabled = !!on; });
  if (!on) upLayout();
}
var upGoText = $('#mu-up-go').textContent;
/** 底部按钮：没任务 =「上传」；传的时候 =「上传中…」不能点；传完有失败 =「放弃剩下的」+「重试失败的（n）」 */
function upFoot(){
  var go = $('#mu-up-go'), ab = $('#mu-up-abandon');
  ab.classList.toggle('hidden', !job || job.running);
  ab.disabled = !!(job && job.running);
  if (!job) { go.textContent = upGoText; go.disabled = false; return; }
  go.disabled = job.running;
  go.textContent = job.running ? T.uploading : tr('retryN', { n: jobLeft() });
}
$('#mu-up-go').addEventListener('click', function(){
  if (job) { if (!job.running) jobRetry(); return; }
  /* 标签没读完就点了：等读完（readTags 永远 resolve，不会卡住） */
  var gen = upGen, btn = this;
  btn.disabled = true;
  Promise.all(upFiles.audio.map(function(f, i){ return upFiles.tags[i] ? null : TAGS.readTags(f).then(function(g){ if (gen === upGen) upFiles.tags[i] = g; }); })).then(function(){
    btn.disabled = false;
    var plan = upPlanNow();
    if (plan.error) return upMsg(plan.error === 'needSong' ? T.needSong : plan.error === 'needAlbumName' ? T.needAlbumName : plan.error === 'needAudio' ? T.needAudio : T.failed, true);
    for (var k = 0; k < upFiles.audio.length; k++) {
      var f = upFiles.audio[k];
      if (f.size > TRACK_MAX) return upMsg(T.tooBig(f.name), true);
      if (!audioType(f)) return upMsg(T.badType(f.name), true);
    }
    var j = jobNew(plan);
    if (!j.items.some(function(it){ return it.st === 'wait'; })) return upMsg(T.allSkipped, true);
    job = j;
    upFormLock(true);
    jobRun();
  }, function(){ btn.disabled = false; });
});
$('#mu-up-abandon').addEventListener('click', function(){ if (job && !job.running) jobAbandon(); });

/* ---------- 上传任务（PR-b） ----------
 * job = { plan, one, files / covers / lrcs / tags（这次的文件，表单锁着不会变）, albumId（新建专辑建过就记下，重试不再建）, albumCoverOk, albumWhy,
 *         items: [{ t: 计划里的这一首, st: 'wait' / 'up' / 'done' / 'fail' / 'skip', pct, why（失败原因文案键）,
 *                   rec（单曲记录 id，建过就记下）, coverOk, trackId（音频传上了）, editOk（歌手 / 歌词写上了）, dur }],
 *         running, stop（没进站：剩下的先不传）, q（建单曲记录排队，保证单曲区顺序和文件顺序一样） }
 * 每首按步骤走，做过的步骤记在 item 上；重试只把失败（和没进站时没轮到）的那几首放回等待，从断的那一步接着来。 */
function jobNew(plan){
  return { plan: plan, one: upMode === 'one', files: upFiles.audio, covers: upFiles.cover, lrcs: upFiles.lrc, tags: upFiles.tags,
    albumId: plan.album && plan.album.id || 0, albumCoverOk: !(plan.album && plan.album.add && plan.albumCover), albumWhy: '',
    items: plan.tracks.map(function(t){ return { t: t, st: upMode !== 'one' && upSkip[t.file] ? 'skip' : 'wait', pct: 0, why: '', rec: 0, coverOk: false, trackId: 0, editOk: false, dur: upFiles.dur[t.file] || 0 }; }),
    running: false, stop: false, q: Promise.resolve() };
}
/** 还要再传的：失败的 + 没轮到的 + 专辑封面没传上（算一个） */
function jobLeft(){ return job ? job.items.filter(function(it){ return it.st === 'fail' || it.st === 'wait'; }).length + (job.albumWhy ? 1 : 0) : 0; }
function jobFail(it, e){ it.st = 'fail'; it.why = upReason(e); it.pct = 0; }
/** 内嵌封面 → Blob（任务里的那份标签） */
function jobEmb(i){ var g = job.tags[i]; return g && g.picture ? new Blob([g.picture.bytes], { type: UP_IMG_MIME[g.picture.mime] || 'image/jpeg' }) : null; }
function coverUp(id, file){ return cropCover(file).then(function(b){ return req('POST', '/music/api/music-upload?album=' + id + '&kind=cover', b, b.type); }); }
/** 新建专辑：只建一次；专辑封面（选的没传上算失败、重试再传；内嵌的解不开就算了）。建不成 → 等着的每首都失败 */
function jobAlbum(){
  var p = job.plan;
  if (!p.album || !p.album.add) return Promise.resolve(true);
  var made = job.albumId ? Promise.resolve() : req('POST', '/music/api/music', { op: 'album.add', kind: 'album', title: p.album.add.title, artist: p.album.add.artist, year: p.album.add.year }).then(function(j){ job.albumId = j.id; });
  return made.then(function(){
    if (job.albumCoverOk) return true;
    var ac = p.albumCover, file = ac.pick !== undefined ? job.covers[ac.pick] : jobEmb(ac.embedded);
    if (!file) { job.albumCoverOk = true; return true; }
    upMsg(T.cover);
    return coverUp(job.albumId, file).then(function(){ job.albumCoverOk = true; job.albumWhy = ''; }, function(e){
      if (ac.pick === undefined && !(e && e.sgxLocked)) job.albumCoverOk = true; else job.albumWhy = e && e.sgxLocked ? 'whyLocked' : 'whyAlbumCover';
    }).then(function(){ upMsg(''); return true; });
  }, function(e){
    job.items.forEach(function(it){ if (it.st === 'wait') jobFail(it, e && e.sgxLocked ? e : { code: 'album' }); });
    if (e && e.sgxLocked) job.stop = true;
    return false;
  });
}
/** 这次任务已经占用的单曲记录 */
function jobTaken(){ var m = {}; job.items.forEach(function(it){ if (it.rec) m[it.rec] = true; }); return m; }
/** 一首：单曲记录（排队建；有能接着用的空记录就用它）→ 单曲封面 → 音频（XHR 进度）→ track.edit 歌手 / 歌词。做过的步骤跳过 */
function jobItem(it){
  var t = it.t, p = job.plan, f = job.files[t.file], q;
  it.st = 'up'; it.pct = 0; it.why = ''; upListSoon();
  if (p.album) q = Promise.resolve(job.albumId);
  else if (it.rec) q = Promise.resolve(it.rec);
  else {
    q = job.q.then(function(){
      var reuse = emptySingle(all, t.title, t.artist, jobTaken());
      return reuse || req('POST', '/music/api/music', { op: 'album.add', kind: 'single', title: t.title, artist: t.artist, year: p.singleYear }).then(function(j){ return j.id; });
    }).then(function(id){ it.rec = id; return id; });
    job.q = q.catch(function(){});
  }
  return q.then(function(id){
    if (p.album) it.coverOk = true;  /* 专辑里的曲目不设封面（7.6） */
    if (it.coverOk) return id;
    var file = t.cover >= 0 ? job.covers[t.cover] : t.embedded ? jobEmb(t.file) : null;
    if (!file) { it.coverOk = true; return id; }
    /* 选的封面没传上：先接着传音频，最后算这首失败（重试只补封面）；内嵌的解不开就算了 */
    return coverUp(id, file).then(function(){ it.coverOk = true; }, function(e){ if (e && e.sgxLocked) throw e; if (t.cover < 0) it.coverOk = true; }).then(function(){ return id; });
  }).then(function(id){
    if (it.trackId) return null;
    return (it.dur ? Promise.resolve(it.dur) : durationOf(f)).then(function(d){
      it.dur = d;
      var url = '/music/api/music-upload?album=' + id + '&kind=track&no=' + t.no + '&title=' + encodeURIComponent(t.title) + '&duration=' + d;
      return xhrUpload(url, f, audioType(f), function(pc){ if (pc !== it.pct) { it.pct = pc; upListSoon(); } });
    }).then(function(r){ it.trackId = r.id; it.pct = 100; });
  }).then(function(){
    if (it.editOk) return null;
    /* 曲目的歌手（写 artist_id）和歌词：一个 track.edit，有才发 */
    var body = { op: 'track.edit', id: it.trackId };
    if (t.artist) body.artist = t.artist;
    return (t.lrc >= 0 ? readText(job.lrcs[t.lrc]) : Promise.resolve(null)).then(function(text){
      if (text) body.lrc = text;
      if (Object.keys(body).length <= 2) { it.editOk = true; return null; }
      return req('POST', '/music/api/music', body).then(function(){ it.editOk = true; }, function(e){ throw e && e.sgxLocked ? e : { code: 'edit' }; });
    });
  }).then(function(){
    if (it.coverOk) it.st = 'done'; else jobFail(it, { code: 'cover' });
  }, function(e){ jobFail(it, e); if (e && e.sgxLocked) job.stop = true; }).then(upListSoon);
}
/** 一次同时 UP_CONC 首；没进站就停下（剩下的留在等待，进站后点重试接着传） */
function jobPool(){
  return new Promise(function(done){
    var active = 0;
    function next(){
      var it = job.stop ? null : job.items.filter(function(x){ return x.st === 'wait'; })[0];
      if (!it) { if (!active) done(); return; }
      active++;
      jobItem(it).then(function(){ active--; next(); });
    }
    for (var k = 0; k < UP_CONC; k++) next();
  });
}
/** 离开 / 刷新页面先问一下（Gray 定 4）：只在真在传的时候挂着，传完 / 停下就摘掉 */
function upBeforeUnload(e){ e.preventDefault(); e.returnValue = ''; return ''; }
var upGuarded = false;
function upGuard(on){
  if (!!on === upGuarded) return;
  upGuarded = !!on;
  if (on) G.addEventListener('beforeunload', upBeforeUnload); else G.removeEventListener('beforeunload', upBeforeUnload);
}
function jobRun(){
  job.running = true; job.stop = false;
  upGuard(true);
  upMsg(''); upFoot(); upList();
  return jobAlbum().then(function(ok){ return ok ? jobPool() : null; }).then(function(){
    job.running = false;
    upGuard(false);
    return req('GET', '/music/api/music').catch(function(){ return null; });
  }).then(function(j){
    /* 传上的那部分先在页面上显示出来（有失败也一样） */
    if (j) {
      coverVer = Date.now();
      var toSingles = !job.plan.album;
      setData(j.albums, toSingles ? 'single' : 'album');
      var i = albums.map(function(a){ return a.id; }).indexOf(job.albumId);
      renderCovers();
      if (toSingles) renderAlbum(); else select(i < 0 ? 0 : i, true);
    }
    var left = jobLeft();
    if (!left) { job = null; upDropPreview(); upFoot(); upSheet.close(); toast(T.saved); return; }
    var nf = job.items.filter(function(it){ return it.st === 'fail' || it.st === 'wait'; }).length;
    upMsg([nf ? tr('partialRetry', { n: nf }) : '', job.albumWhy ? T[job.albumWhy] : ''].filter(Boolean).join(' '), true);
    upFoot(); upList();
  });
}
/** 只重试失败的（和没进站时没轮到的）：从断的那一步接着来 */
function jobRetry(){
  job.items.forEach(function(it){ if (it.st === 'fail') { it.st = 'wait'; it.why = ''; } });
  jobRun();
}
/**
 * 放弃剩下的：关窗、清掉任务。传了一半留下的空记录不删——删空单曲 / 空专辑只有 album.del（root，要一次性票，一条一张），
 * 前端不为它多走 sudo；空单曲在单曲区照样显示、能删，下次传同名同歌手的单曲接着用它（emptySingle）；空的新专辑留着，可在「已有专辑」里接着传。
 */
function jobAbandon(){
  var singlesLeft = job.items.filter(function(it){ return it.rec && !it.trackId; }).length;
  var albumLeft = !!(job.plan.album && job.plan.album.add && job.albumId && !job.items.some(function(it){ return it.trackId; }));
  var name = albumLeft ? job.plan.album.add.title : '';
  job = null;
  upDropPreview(); upFoot(); upReset(); upSheet.close();
  var m = [singlesLeft ? tr('leftSingles', { n: singlesLeft }) : '', albumLeft ? tr('leftAlbum', { name: name }) : ''].filter(Boolean).join(' ');
  if (m) toast(m);
}

/* ---------- 导入后编辑（M3，音乐 v1.18 十二 M3 / 7.4 / 7.6） ----------
 * 曲目行 / 单曲行「⋯」→ #mu-ed-wrap：歌名、歌手（M4 之前只填文本，不联想）、所属专辑（只列 kind=album 按名排序，顶上「移出变单曲」）、歌词；
 *   单曲多一个封面、一个年份（专辑里的曲目不设封面，7.6；单曲选了划进专辑 → 封面不传、年份不发，跟专辑走）。所有改动一个 track.edit（后端一个 batch）：
 *   单曲改名 / 改年份由后端在同一个 batch 写进单曲记录（Gray 审 1、3）；换封面走 music-upload kind=cover。
 *   左下「删除」→ 确认卡片（同删除单曲）→ track.del（music-manage 档；单曲唯一一首 → 后端连空单曲记录和封面一起删）。
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
  return cropCover(file).then(function(b){ return req('POST', '/music/api/music-upload?album=' + albumId + '&kind=cover', b, b.type); }).then(function(){ coverVer = Date.now(); });
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
  return fetch('/music/api/music-play', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ album: albumId }) })
    .then(function(r){ return r.json(); })
    .then(function(j){
      var hit = j && j.ok && (j.tracks || []).filter(function(x){ return x.id === trackId; })[0];
      if (!hit || typeof hit.lrc !== 'string') throw new Error('lrc');
      return hit.lrc;
    });
}
function openTrackEdit(a, t){
  if (!canManage || !a || !t) return;
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
  (body ? req('POST', '/music/api/music', body) : Promise.resolve(null)).then(function(j){
    if (j) list = j.albums;
  }).then(function(){
    if (!cover) return null;
    edMsg(T.cover);
    return upCover(a.id, cover).then(function(){ return req('GET', '/music/api/music'); }).then(function(j3){ list = j3.albums; });
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
      run: function(){ return req('POST', '/music/api/music', { op: 'track.del', id: t.id }); },
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
  if (!a || !canManage) return;
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
  (edit ? req('POST', '/music/api/music', b) : Promise.resolve(null)).then(function(j){
    if (j) list = j.albums;
    if (!file) return null;
    aeMsg(T.cover);
    return upCover(a.id, file).then(function(){ return req('GET', '/music/api/music'); }).then(function(j2){ list = j2.albums; });
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
  bar.classList.toggle('hidden', !canManage || !has);
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
      return req('POST', '/music/api/music', item.body).then(function(j){ list = j.albums; }).catch(function(e){ if (e.sgxLocked) { locked = true; return; } fails.push(item.name + '：' + errText(e)); });
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
  $('#mu-ar-edit').classList.toggle('hidden', !canManage);
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
    var t = a.tracks[0];
    return '<li><button type="button" class="mu-single" data-as="' + i + '"' + (t ? '' : ' disabled') + '>'
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
/** 「有曲目收在「A」、「B」、「C」和另外 n 张专辑里」：最多链三张，多的说剩下几张（中英都是总数 − 已链） */
function relLine(rel){
  var shown = rel.slice(0, 3);
  var links = shown.map(function(a){ return htmlLine('arRelItem', 'a', '<a class="mu-ar-rel-a" href="./" data-rel="' + a.id + '">' + esc(a.title) + '</a>'); }).join(esc(T.arSep || ', '));
  if (rel.length > shown.length) links = htmlLine('arRelMore', 'albums', links, { n: rel.length - shown.length });
  return htmlLine('arRelOnly', 'albums', links, { n: rel.length });
}
$('#mu-ar-rel').addEventListener('click', function(e){
  var a = e.target.closest('a[data-rel]');
  if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  goArtist(0, { album: Number(a.dataset.rel) });
});
/* 歌手页：点专辑 → 回音乐页那张专辑；点单曲 → 这位歌手的单曲当播放列表交给播放器（同单曲区） */
$('#mu-ar-albums').addEventListener('click', function(e){
  var b = e.target.closest('[data-al]');
  if (b) goArtist(0, { album: Number(b.dataset.al) });
});
$('#mu-ar-singles').addEventListener('click', function(e){
  var b = e.target.closest('[data-as]');
  if (!b) return;
  if (viewOnly) return askSudo();
  playQueueOf(arWorks.singles, arWorks.singles[Number(b.dataset.as)]);
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
  if (!r || !canManage) return;
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
  (edit ? req('POST', '/music/api/music', b) : Promise.resolve(null)).then(function(j){
    if (j) list = j.albums;
    if (!file) return null;
    arMsg(T.avatarUp);
    return cropAvatar(file).then(function(blob){ return req('POST', '/music/api/music-upload?artist=' + r.id + '&kind=avatar', blob, 'image/jpeg'); })
      .then(function(){ coverVer = Date.now(); return req('GET', '/music/api/music'); }).then(function(j2){ list = j2.albums; });
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
  var get = UI && UI.sudoTicket ? UI.sudoTicket(line, { method: 'POST', path: '/music/api/music', action: body.op }) : Promise.resolve('');
  return get.then(function(t){ return req('POST', '/music/api/music', body, undefined, t); });
}
$('#mu-ar-merge').addEventListener('click', function(){
  if (!ar) return;
  var from = ar.r, into = artistById(Number($('#mu-ar-into').value));
  if (!into) return;
  arSheet.close(function(){ G.setTimeout(function(){
    askDel({ title: T.mergeTitle, msg: tr('mergeMsg', { from: from.name, to: into.name }), ok: T.mergeOk, done: T.merged, err: arErr,
      run: function(){ return rootOp({ op: 'artist.merge', id: from.id, into: into.id }, 'sudo curio music artist merge ' + from.id + ' ' + into.id); },
      after: function(){ goArtist(into.id); } });
  }, 0); });
});
$('#mu-ar-del').addEventListener('click', function(){
  if (!ar || ar.works > 0) return;
  var r = ar.r;
  arSheet.close(function(){ G.setTimeout(function(){
    askDel({ title: T.delArtistTitle, msg: tr('delArtist', { name: r.name }), err: arErr,
      run: function(){ return rootOp({ op: 'artist.del', id: r.id }, 'sudo curio music artist rm ' + r.id); },
      after: function(){ goArtist(0); } });
  }, 0); });
});

/* ---------- 启动 ---------- */
function done(){ doc.querySelectorAll('.it-loading').forEach(function(el){ el.classList.add('hidden'); }); }
/* ?album=<id> 直达（主页专辑格子）：只在音乐页本身生效，同时带 ?artist= 时歌手页优先；对不上专辑（没有 / 是单曲 / 编号不对）= 照常默认视图。
   只在打开时选一次（同点了那张封面，不自动播放），之后点别的专辑不改地址、不加历史（同原来） */
function deepAlbum(){
  var id = view ? 0 : albumOf(G.location && G.location.search);
  var i = id ? albums.map(function(a){ return a.id; }).indexOf(id) : -1;
  if (i >= 0) { cur = i; sec = 'album'; }
  return i >= 0;
}
req('GET', '/music/api/music').then(function(j){
  setData(j.albums);
  var deep = deepAlbum();
  canManage = !!j.canManage;
  done();
  $('#mu-app').classList.remove('hidden');
  $('#mu-upload').classList.toggle('hidden', !canManage);
  renderCovers();
  if (viewOnly) setViewOnly(true); else renderAlbum();
  if (deep) { var c = doc.querySelector('.mu-cover[data-i="' + cur + '"]'); if (c) c.scrollIntoView({ inline: 'center', block: 'nearest' }); }
}).catch(function(){
  done();
  var p = doc.querySelector('.it-loading'); if (p) { p.textContent = (T.loadFail || T.failed); p.classList.remove('hidden'); }
});
})();
