/* assets/curio/js/curio-music-tags.js —— 音乐上传预填（M2 PR-a，音乐分层方案 v1.19 7.4 / 十二 M2 第 1 条；浏览器 IIFE，node 测试时导出）。
 *
 * 只在浏览器里读，不碰后端，不加依赖（自己写的轻量读标签）：
 *   - mp3：ID3v2.3 / 2.4 的 TIT2（歌名）、TPE1（歌手）、APIC（内嵌封面）；文字编码 0–3（0 = ISO-8859-1，实际常见 GBK / UTF-8 冒充，见 guessText）；
 *     整签 / 逐帧去同步（unsync）、扩展头、2.4 少数写成普通 32 位的帧长都尽量认；压缩 / 加密的帧跳过。ID3v2.2（TT2 / TP1 / PIC）顺手认。
 *     ID3v2 没有歌名 / 歌手时退回文件末尾 128 字节的 ID3v1。
 *   - flac：Vorbis 注释 TITLE / ARTIST、PICTURE 块（内嵌封面）；文件前面另挂了 ID3v2 的也认（Vorbis 优先）。
 *   - 尽力而为：读不出来就空着，从不抛错、不拦上传（readTags 永远 resolve）。
 * 预填规则（prefill）：每一栏标签优先，标签没有这一栏再用文件名（7.4：「没 ID3 标签、歌名只能从文件名取时」才清理文件名）。
 * 文件名清理（7.4，Gray 2026-11-13）：去格式后缀 → 去末尾方括号标签（[mqms2]）→ 按第一个「 - 」拆，前面歌手、后面歌名；没有「 - 」整段当歌名。
 * 新建专辑的歌手默认取多数（十二 M2 第 5 条）：majorityArtist，平票取第一首的歌手。
 */
(function(){
"use strict";
var G = typeof globalThis !== 'undefined' ? globalThis : this;

/** 读标签最多读这么多（ID3v2 整签 / 一个 Vorbis 块）；内嵌封面最多 8 MB（更大的不要，存的时候也要压到 3 MB 以下） */
var MAX_TAG = 16 * 1024 * 1024, MAX_PIC = 8 * 1024 * 1024;
/** 单行字段上限（同 _music.js MUSIC_LIMITS.short） */
var SHORT = 120;

/* ---------- 文件名（7.4） ---------- */
/** 单行字段清理：控制字符换空格、连续空白并成一个、去首尾（同后端 artistName / 单行字段的存法） */
function oneLine(s){ return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\ufeff]/g, ' ').replace(/\s+/g, ' ').trim(); }
/**
 * 清理文件名：去掉路径、格式后缀（.mp3、.flac 等）、末尾的方括号标签（可连着几个，如 QQ 音乐下载带的 [mqms2]）。
 * 「周杰伦 - 那天下雨了 [mqms2].flac」→「周杰伦 - 那天下雨了」。整段都是方括号的不去（不然就空了）。
 */
function cleanName(name){
  var s = String(name == null ? '' : name).replace(/^.*[\\/]/, '');
  s = s.replace(/\.[^.\s]{1,5}$/, '');
  var t = oneLine(s.replace(/(\s*\[[^\[\]]*\])+\s*$/, ''));
  return t || oneLine(s);
}
/** 按第一个「 - 」拆：前面歌手、后面歌名；没有（或拆出来一边是空的）→ 整段当歌名、歌手空 */
function splitArtistTitle(clean){
  var s = oneLine(clean), i = s.indexOf(' - ');
  if (i > 0) {
    var a = s.slice(0, i).trim(), t = s.slice(i + 3).trim();
    if (a && t) return { artist: a, title: t };
  }
  return { artist: '', title: s };
}
/**
 * 文件名 → {no, artist, title}：清理 → 去开头的曲序 → 拆歌手 / 歌名。
 * 曲序（沿用原来专辑上传的 trackFromName）：「01 - 」「01.」「01_」这类带符号的总去掉；只隔一个空格的「01 晴天」只在批量传时当曲序
 * （单首时「7 Rings」不该变成「Rings」）。没有曲序 no = fallback。
 */
function fromFileName(name, opts){
  var o = opts || {}, s = cleanName(name), no = o.fallback == null ? 0 : o.fallback;
  var m = /^(\d{1,3})\s*[-._)\]]\s*(\S.*)$/.exec(s) || (o.batch ? /^(\d{1,3})\s+(\S.*)$/.exec(s) : null);
  if (m) { no = Number(m[1]); s = m[2]; }
  var p = splitArtistTitle(s);
  return { no: no, artist: p.artist.slice(0, SHORT), title: p.title.slice(0, SHORT) };
}

/* ---------- 文字解码 ---------- */
function latin1(b){ var s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; }
function tryDecode(label, b){ try { return new G.TextDecoder(label, { fatal: true }).decode(b); } catch (e) { return null; } }
/**
 * 编码 0（规定是 ISO-8859-1）和 ID3v1（没规定）：实际上中文下载站常把 GBK、有的工具把 UTF-8 写进来。
 * 全是 ASCII → 原样；是合法 UTF-8 → UTF-8；是合法 GBK 且解出汉字 → GBK；都不是 → ISO-8859-1。
 */
function guessText(b){
  var hi = false;
  for (var i = 0; i < b.length; i++) if (b[i] >= 0x80) { hi = true; break; }
  if (!hi) return latin1(b);
  var u = tryDecode('utf-8', b);
  if (u !== null) return u;
  var g = tryDecode('gbk', b);
  if (g !== null && /[\u3400-\u9fff]/.test(g)) return g;
  return latin1(b);
}
/** UTF-16（le = 小端）：按码元拼，代理对自然成对 */
function utf16(b, le){
  var s = '';
  for (var i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  return s;
}
/** ID3v2 文字编码 0–3 → 字符串（不去结尾 \0，调用方按 \0 取第一个值） */
function decodeText(enc, b){
  if (enc === 1) {
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return utf16(b.subarray(2), true);
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return utf16(b.subarray(2), false);
    return utf16(b, true);  /* 没 BOM（不合规）：按最常见的小端 */
  }
  if (enc === 2) return utf16(b, false);
  if (enc === 3) { var u = tryDecode('utf-8', b); return u !== null ? u : new G.TextDecoder('utf-8').decode(b); }
  return guessText(b);
}
/** 文字帧的值：多个值（2.4 用 \0 分隔）取第一个非空的；去 BOM、单行清理 */
function textValue(enc, b){
  var parts = decodeText(enc, b).replace(/\ufeff/g, '').split('\u0000');
  for (var i = 0; i < parts.length; i++) { var v = oneLine(parts[i]); if (v) return v.slice(0, SHORT); }
  return '';
}

/* ---------- ID3v2 ---------- */
function ascii(b, p, n){ var s = ''; for (var i = 0; i < n && p + i < b.length; i++) s += String.fromCharCode(b[p + i]); return s; }
function syncsafe(b, p){ return ((b[p] & 0x7f) << 21) | ((b[p + 1] & 0x7f) << 14) | ((b[p + 2] & 0x7f) << 7) | (b[p + 3] & 0x7f); }
function be32(b, p){ return ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3]; }
function le32(b, p){ return ((b[p + 3] << 24) >>> 0) + (b[p + 2] << 16) + (b[p + 1] << 8) + b[p]; }
/** 去同步：FF 00 → FF */
function deunsync(b){
  var out = new Uint8Array(b.length), n = 0;
  for (var i = 0; i < b.length; i++) { out[n++] = b[i]; if (b[i] === 0xff && b[i + 1] === 0x00) i++; }
  return out.subarray(0, n);
}
/** 图片类型：声明的不认就看头几个字节 */
function imageMime(m, bytes){
  m = String(m || '').toLowerCase().trim();
  if (m === 'image/jpg' || m === 'jpg' || m === 'jpeg') m = 'image/jpeg';
  if (m === 'png') m = 'image/png';
  if (/^image\/(jpeg|png|webp|gif|bmp)$/.test(m)) return m;
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length > 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return '';
}
/** 找文字结尾（编码 1 / 2 是两个 0 字节、按两字节对齐），返回结尾后的下标；找不到 -1 */
function termEnd(d, p, enc){
  if (enc === 1 || enc === 2) { for (var i = p; i + 1 < d.length; i += 2) if (d[i] === 0 && d[i + 1] === 0) return i + 2; return -1; }
  for (var j = p; j < d.length; j++) if (d[j] === 0) return j + 1;
  return -1;
}
/** APIC（2.3 / 2.4）/ PIC（2.2）→ {mime, type, bytes}；坏的 / 外链（-->）null */
function parsePicture(d, v22){
  if (d.length < 4) return null;
  var enc = d[0], p = 1, mime;
  if (v22) { mime = ascii(d, 1, 3); p = 4; }
  else { var e = termEnd(d, 1, 0); if (e < 0) return null; mime = ascii(d, 1, e - 2); p = e; }
  if (mime === '-->') return null;
  var type = d[p++], e2 = termEnd(d, p, enc);
  if (e2 < 0) return null;
  var bytes = d.subarray(e2);
  var m = imageMime(mime, bytes);
  if (!m || !bytes.length) return null;
  return { mime: m, type: type, bytes: bytes };
}
/** 前封面（类型 3）优先，否则第一张 */
function betterPic(cur, pic){ if (!pic) return cur; if (!cur) return pic; return cur.type !== 3 && pic.type === 3 ? pic : cur; }
var FRAME_ID = /^[A-Z0-9]{4}$/;
/**
 * ID3v2 整签（从 "ID3" 开头）→ {title, artist, picture}；不是 / 坏了 null。从不抛错。
 * 版本 2.2 / 2.3 / 2.4；标签头的去同步、扩展头；帧的压缩 / 加密（跳过）、分组字节、2.4 的逐帧去同步和数据长度。
 */
function parseId3v2(buf){
  try {
    var b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (b.length < 10 || ascii(b, 0, 3) !== 'ID3') return null;
    var ver = b[3], flags = b[5];
    if (ver < 2 || ver > 4) return null;
    var body = b.subarray(10, Math.min(b.length, 10 + syncsafe(b, 6)));
    if (ver < 4 && (flags & 0x80)) body = deunsync(body);  /* 2.2 / 2.3：整签去同步；2.4 逐帧（见下） */
    var pos = 0, out = { title: '', artist: '', picture: null };
    if (ver > 2 && (flags & 0x40) && body.length >= 4) pos = ver === 3 ? 4 + be32(body, 0) : syncsafe(body, 0);
    var v22 = ver === 2, hdr = v22 ? 6 : 10;
    var validAt = function(p){ return p === body.length || (p + hdr <= body.length && (body[p] === 0 || FRAME_ID.test(ascii(body, p, 4)))); };
    for (var guard = 0; guard < 4096 && pos + hdr <= body.length; guard++) {
      if (body[pos] === 0) break;  /* 填充 */
      var id = ascii(body, pos, v22 ? 3 : 4), size;
      if (!(v22 ? /^[A-Z0-9]{3}$/ : FRAME_ID).test(id)) break;
      if (v22) size = (body[pos + 3] << 16) | (body[pos + 4] << 8) | body[pos + 5];
      else if (ver === 3) size = be32(body, pos + 4);
      else {
        /* 2.4 规定帧长是 syncsafe；有的工具写成普通 32 位：有高位的字节必是普通的；两种读法不同时看哪种后面接得上下一帧 */
        var plain = be32(body, pos + 4), safe = syncsafe(body, pos + 4);
        var hasHigh = (body[pos + 4] | body[pos + 5] | body[pos + 6] | body[pos + 7]) & 0x80;
        size = hasHigh ? plain : safe;
        if (!hasHigh && plain !== safe && !validAt(pos + 10 + safe) && validAt(pos + 10 + plain)) size = plain;
      }
      var fl = v22 ? 0 : body[pos + 9];
      var start = pos + hdr, end = Math.min(body.length, start + size);
      pos = start + size;
      var d = body.subarray(start, end), skip = false;
      if (ver === 3) {
        if (fl & 0xc0) skip = true;           /* 压缩 / 加密 */
        else if (fl & 0x20) d = d.subarray(1); /* 分组字节 */
      } else if (ver === 4) {
        if (fl & 0x0c) skip = true;            /* 压缩 / 加密 */
        else {
          if (fl & 0x40) d = d.subarray(1);    /* 分组字节 */
          if (fl & 0x01) d = d.subarray(4);    /* 数据长度 */
          if ((fl & 0x02) || (flags & 0x80)) d = deunsync(d);
        }
      }
      if (skip || !d.length) continue;
      if ((id === 'TIT2' || id === 'TT2') && !out.title) out.title = textValue(d[0], d.subarray(1));
      else if ((id === 'TPE1' || id === 'TP1') && !out.artist) out.artist = textValue(d[0], d.subarray(1));
      else if (id === 'APIC' || id === 'PIC') { if (d.length <= MAX_PIC + 1024) out.picture = betterPic(out.picture, parsePicture(d, v22)); }
    }
    return out;
  } catch (e) { return null; }
}
/** 整个标签占多少字节（含头、可能有的尾）：b 是文件开头至少 10 字节；不是 ID3v2 → 0 */
function id3v2Size(b){
  if (!b || b.length < 10 || ascii(b, 0, 3) !== 'ID3') return 0;
  return 10 + syncsafe(b, 6) + (b[3] === 4 && (b[5] & 0x10) ? 10 : 0);
}

/* ---------- ID3v1 ---------- */
function v1Field(b){
  var n = b.length;
  while (n > 0 && (b[n - 1] === 0 || b[n - 1] === 0x20)) n--;
  var z = Array.prototype.indexOf.call(b.subarray(0, n), 0);
  return oneLine(guessText(b.subarray(0, z < 0 ? n : z)));
}
/** 文件末尾 128 字节 → {title, artist}；不是 ID3v1 null */
function parseId3v1(tail){
  try {
    var b = tail instanceof Uint8Array ? tail : new Uint8Array(tail);
    if (b.length < 128) return null;
    b = b.subarray(b.length - 128);
    if (ascii(b, 0, 3) !== 'TAG') return null;
    return { title: v1Field(b.subarray(3, 33)), artist: v1Field(b.subarray(33, 63)) };
  } catch (e) { return null; }
}

/* ---------- FLAC ---------- */
/** VORBIS_COMMENT 块（不含 4 字节块头）→ {title, artist}（键不分大小写，取第一个） */
function parseVorbis(d){
  var out = { title: '', artist: '' };
  try {
    if (d.length < 8) return out;
    var p = 4 + le32(d, 0);
    if (p + 4 > d.length) return out;
    var n = le32(d, p); p += 4;
    var dec = new G.TextDecoder('utf-8');
    for (var i = 0; i < n && i < 10000 && p + 4 <= d.length; i++) {
      var len = le32(d, p); p += 4;
      if (p + len > d.length) break;
      var s = dec.decode(d.subarray(p, p + len)); p += len;
      var eq = s.indexOf('=');
      if (eq < 1) continue;
      var k = s.slice(0, eq).toUpperCase(), v = oneLine(s.slice(eq + 1)).slice(0, SHORT);
      if (k === 'TITLE' && !out.title) out.title = v;
      else if (k === 'ARTIST' && !out.artist) out.artist = v;
    }
  } catch (e) { /* 坏块：读到哪算哪 */ }
  return out;
}
/** PICTURE 块（不含块头）→ {mime, type, bytes}；坏的 null */
function parseFlacPicture(d){
  try {
    var p = 0, type = be32(d, p); p += 4;
    var ml = be32(d, p); p += 4; var mime = ascii(d, p, ml); p += ml;
    var dl = be32(d, p); p += 4 + dl + 16;
    var len = be32(d, p); p += 4;
    if (p + len > d.length || !len) return null;
    var bytes = d.subarray(p, p + len), m = imageMime(mime, bytes);
    return m ? { mime: m, type: type, bytes: bytes } : null;
  } catch (e) { return null; }
}
/** 整个 flac（或开头够长的一段，从 "fLaC" 开始）→ {title, artist, picture}；不是 null。测试和小文件用；浏览器里读文件走 readTags（按块读） */
function parseFlac(buf){
  try {
    var b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (ascii(b, 0, 4) !== 'fLaC') return null;
    var p = 4, out = { title: '', artist: '', picture: null };
    for (var guard = 0; guard < 128 && p + 4 <= b.length; guard++) {
      var last = b[p] & 0x80, type = b[p] & 0x7f, len = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
      var d = b.subarray(p + 4, Math.min(b.length, p + 4 + len));
      if (type === 4) { var c = parseVorbis(d); out.title = out.title || c.title; out.artist = out.artist || c.artist; }
      else if (type === 6) out.picture = betterPic(out.picture, parseFlacPicture(d));
      p += 4 + len;
      if (last) break;
    }
    return out;
  } catch (e) { return null; }
}

/* ---------- 读文件（浏览器 File / Blob） ---------- */
function readRange(file, start, len){
  if (start >= file.size || len <= 0) return Promise.resolve(new Uint8Array(0));
  return file.slice(start, Math.min(file.size, start + len)).arrayBuffer().then(function(ab){ return new Uint8Array(ab); });
}
/** flac 按块读：只读块头和 VORBIS_COMMENT / PICTURE 块（大文件也不整个读进来） */
function readFlac(file, off){
  var out = { title: '', artist: '', picture: null }, p = off + 4, n = 0;
  function step(){
    if (n++ >= 128 || p + 4 > file.size) return Promise.resolve(out);
    return readRange(file, p, 4).then(function(h){
      if (h.length < 4) return out;
      var last = h[0] & 0x80, type = h[0] & 0x7f, len = (h[1] << 16) | (h[2] << 8) | h[3], at = p + 4;
      p = at + len;
      var want = (type === 4 && len <= MAX_TAG) || (type === 6 && len <= MAX_PIC && !(out.picture && out.picture.type === 3));
      var next = function(){ return last ? out : step(); };
      if (!want) return next();
      return readRange(file, at, len).then(function(d){
        if (type === 4) { var c = parseVorbis(d); out.title = out.title || c.title; out.artist = out.artist || c.artist; }
        else out.picture = betterPic(out.picture, parseFlacPicture(d));
        return next();
      });
    });
  }
  return step();
}
/**
 * 读一个音频文件的标签 → Promise<{title, artist, picture}>（picture = {mime, type, bytes} 或 null）。
 * 永远 resolve：读不出来就是空的，不拦上传。flac 的 Vorbis 注释优先于前面挂的 ID3v2；mp3 的 ID3v2 缺的栏再看 ID3v1。
 */
function readTags(file){
  var empty = { title: '', artist: '', picture: null };
  if (!file || typeof file.slice !== 'function' || !(file.size > 0)) return Promise.resolve(empty);
  var res = { title: '', artist: '', picture: null }, off = 0;
  function take(r){ if (!r) return; res.title = res.title || r.title || ''; res.artist = res.artist || r.artist || ''; res.picture = betterPic(res.picture, r.picture || null); }
  return readRange(file, 0, 10).then(function(head){
    var size = id3v2Size(head);
    if (!size) return null;
    off = size;
    return readRange(file, 0, Math.min(size, MAX_TAG)).then(parseId3v2);
  }).then(function(id3){
    return readRange(file, off, 4).then(function(m){
      if (ascii(m, 0, 4) === 'fLaC') return readFlac(file, off).then(function(fl){ take(fl); take(id3); });
      take(id3);
      if (res.title && res.artist || file.size < 128 + off) return null;
      return readRange(file, file.size - 128, 128).then(function(t){ take(parseId3v1(t)); });
    });
  }).then(function(){ return res; }, function(){ return res.title || res.artist || res.picture ? res : empty; });
}

/* ---------- 预填 ---------- */
/**
 * 一个文件的预填 → {no, title, artist}：每一栏标签优先，没有再用文件名（清理 + 拆歌手）；歌名再没有就用清理后的文件名整段。
 * opts.batch：批量传（「01 晴天」这种只隔空格的开头数字也当曲序）；opts.fallback：没有曲序时的曲序。
 */
function prefill(fileName, tags, opts){
  var f = fromFileName(fileName, opts), t = tags || {};
  var title = oneLine(t.title).slice(0, SHORT), artist = oneLine(t.artist).slice(0, SHORT);
  return { no: f.no, title: title || f.title, artist: artist || f.artist };
}
/**
 * 新建专辑的歌手默认（十二 M2 第 5 条）：这批里出现最多的歌手（空的不算）；平票取第一首的歌手
 * （= 平票的几位里，按曲目顺序最先出现的那位）。都没有 ''。
 */
function majorityArtist(list){
  var count = {}, order = [], best = '', top = 0;
  (list || []).forEach(function(a){
    var k = oneLine(a);
    if (!k) return;
    if (!count[k]) { count[k] = 0; order.push(k); }
    count[k]++;
  });
  order.forEach(function(k){ if (count[k] > top) { top = count[k]; best = k; } });
  return best;
}

var api = { MAX_TAG: MAX_TAG, MAX_PIC: MAX_PIC, cleanName: cleanName, splitArtistTitle: splitArtistTitle, fromFileName: fromFileName, guessText: guessText, decodeText: decodeText,
  parseId3v2: parseId3v2, id3v2Size: id3v2Size, parseId3v1: parseId3v1, parseFlac: parseFlac, readTags: readTags, prefill: prefill, majorityArtist: majorityArtist };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else G.SgxMusicTags = api;
})();
