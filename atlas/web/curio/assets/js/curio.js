/* assets/js/curio.js —— 奇趣「发现」子页逻辑 + 各子页共用的确认框 / 提示条 / 弹层开关 / 页底一行（浏览器 IIFE；node 测试时导出纯函数）。
 *
 * - P4-3 奇趣拆页起「发现」是独立子页 /curio/finds/（中文 /curio/zh/finds/）：分类筛选条（全部 + 每个分类，hash #c/<分类 id>，只用 replaceState）。
 *   设备 / 游戏 / 电影子页也加载本文件，只用 window.SgxCurioUI（没有 #cu-list 时后面「发现」的部件不启动）。
 *   顶栏没有搜索栏（2026-10-22 起）；filterCats 仍支持搜索词，留给以后。
 * - 按分类分组的格子：图标（/api/icon?id=，R2 缓存；取不到显示首字母方块）、名字、简介；私密的带小锁（只有账号已登录看得到私密的）。
 *   点格子在新标签页打开网址。
 * - 能编辑（接口回 canWrite：账号已登录 + 作用域 curio.write）：右下角「收藏」新建；长按格子（或键盘 Enter 以外的 E 键）编辑；分类条右边「⋯」：管理分类 / 导入浏览器书签 / 导出书签。
 *   编辑弹层：网址（「自动填写」抓标题、简介、图标）、名字、英文名和英文简介、简介、分类（可就地新建）、自定义图标、仅自己可见、上移 / 下移、删除。
 * - 不能编辑（canWrite=false）：编辑入口换成页底一行（#cu-signin，signinHint）：
 *   没登录账号 →「登录账号后可编辑」，链到 /account/?return=<本页>（P3-1 同意流程：登录完先判授权，没授权弹同意卡片，完了回本页）；
 *   已登录但奇趣没有 curio.write（在 账号 › 应用授权 取消过）→「奇趣未获账号授权」，链到 /account/apps/。写接口回 403 scope 也提示这一句。
 *   写接口回 401 account / 403 scope 时也提示这一句；导入回 401 reauth（要账号复验）时提示去账号页验证一次再回来导入（P3-1 前的简版）。
 * - 中英文：名字、简介各两份，当前语言那份为空时显示另一份。
 *
 * 数据：GET /api/links；写：POST /api/links {op}、POST /api/import（原文）；GET /api/preview；导出是 /api/export 的下载链接。
 * 读请求走 sgxLockSync.apiFetch（401 = 锁定 → 刷新去锁屏）；写请求只有 401 unauthorized 才当锁定（401 account / reauth 是账号的事，不刷新）。纯函数导出给 tests/curio/curio.test.mjs。
 */
(function(){
"use strict";
var G = typeof globalThis !== 'undefined' ? globalThis : this;

/* ================= 纯函数 ================= */

/**
 * 收藏的名字 / 简介是内容（库里 name_zh / name_en 两列，不是界面文案）：取页面语言那份，空就先用英文、再用随便哪份有字的。
 * @param {Record<string,string>|null} pair @param {string} lang 页面语言代码
 */
function pick(pair, lang){
  if (!pair) return '';
  if (pair[lang]) return pair[lang];
  if (pair.en) return pair.en;
  for (var k in pair) if (pair[k]) return pair[k];
  return '';
}
/** 内容的两列（CONTENT_LANGS = 库里的列）：页面语言是其中之一就它在前，否则英文在前（英文是源） @param {string} lang @returns {string[]} [主, 另一份] */
var CONTENT_LANGS = ['en', 'zh'];
function contentLangs(lang){
  var a = CONTENT_LANGS.indexOf(lang) >= 0 ? lang : 'en';
  return [a].concat(CONTENT_LANGS.filter(function(x){ return x !== a; }));
}
/** 按 contentLangs 的顺序把两个输入值放进内容对象 @param {string} lang @param {string} a 主语言那份 @param {string} b 另一份 */
function contentPair(lang, a, b){
  var ls = contentLangs(lang), o = {};
  o[ls[0]] = a; o[ls[1]] = b;
  return o;
}

/** 网址的域名（去 www.），坏网址返回原文 */
function hostOf(url){
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return String(url || ''); }
}

/** 首字母方块里的字：名字第一个字（字母大写），没有就用域名 */
function initial(name, url){
  var s = String(name || '').trim() || hostOf(url);
  var ch = Array.from(s)[0] || '?';
  return ch.toUpperCase();
}

/** hash → 选中的分类 id（0 = 全部） */
function parseHash(hash){
  var m = /^#c\/(\d+)$/.exec(String(hash || ''));
  return m ? Number(m[1]) : 0;
}
function catHash(id){ return id ? '#c/' + id : ''; }

/**
 * 筛选：cat 为 0 是全部；q 按空白切成多个词，每个词都要出现在名字（两种语言）、简介（两种语言）或网址里。
 * 返回新的分类数组（不改原数组）。有搜索词时只留有命中的分类；没有搜索词时空分类也保留（账号已登录要能看到、往里加；没登录拿到的本来就没有空分类）。
 */
function filterCats(cats, q, cat){
  var words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  var out = [];
  (cats || []).forEach(function(c){
    if (cat && c.id !== cat) return;
    var links = (c.links || []).filter(function(l){
      if (!words.length) return true;
      var hay = [l.name && l.name.zh, l.name && l.name.en, l.desc && l.desc.zh, l.desc && l.desc.en, l.url].join(' ').toLowerCase();
      return words.every(function(w){ return hay.indexOf(w) >= 0; });
    });
    if (links.length || !words.length) out.push({ id: c.id, name: c.name, private: c.private, links: links });
  });
  return out;
}

/** 数一共多少条 */
function countLinks(cats){
  return (cats || []).reduce(function(n, c){ return n + (c.links || []).length; }, 0);
}

/** 把 id 在列表里往前 / 往后挪一位，返回新的 id 数组；挪不动返回 null */
function moveId(ids, id, dir){
  var i = ids.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return null;
  var out = ids.slice();
  out[i] = ids[j]; out[j] = id;
  return out;
}

/** 输入的网址补协议：没写 http(s):// 的当 https；空返回 '' */
function normalizeUrl(s){
  s = String(s || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try {
    var u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch (e) { return ''; }
}

/**
 * 写请求的 401 是不是「锁定了」（要刷新去锁屏）：401 account（没登录账号）/ 401 reauth（要账号复验）不是，其余 401 都是。
 * @param {number} status @param {string} code
 */
function isLockedReply(status, code){
  return status === 401 && code !== 'account' && code !== 'reauth';
}

/** 导入结果的一句话（文案在字符串表 js.curio.imp*） @param {{added:number, cats_added:number, skipped:number}} r @param {(k:string, v?:object)=>string} tr */
function importSummary(r, tr){
  return tr('impAdded', { n: r.added }) + (r.cats_added ? tr('impCats', { n: r.cats_added }) : '') + (r.skipped ? tr('impSkipped', { n: r.skipped }) : '') + tr('impEnd');
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
  /* 先拷一份原始文案：调用方会把带数字的键改挂成函数（T.count = function(n){ return tr('count', …) }），
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

var pure = { readDict: readDict, makeTr: makeTr, pick: pick, hostOf: hostOf, initial: initial, parseHash: parseHash, catHash: catHash, filterCats: filterCats, countLinks: countLinks, moveId: moveId, normalizeUrl: normalizeUrl, importSummary: importSummary, contentLangs: contentLangs, contentPair: contentPair, isLockedReply: isLockedReply };
if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }
G.SgxCurio = pure;

/* ================= 页面 ================= */
var doc = G.document;
/* 界面文案（语言包化第二部分 2026-11-07）：页面里的 #sgx-i18n-curio，模板从字符串表 data/i18n/<语言>.yaml 的 js.curio 输出，
   已经是「英文表 ← 页面语言表」的合并（缺键回退英文）；本文件不再认识任何语言。带数字的文案走 tr（复数按 Intl.PluralRules）。 */
var lang = doc.documentElement.lang || 'en';
var T = readDict(doc, 'curio');
var tr = makeTr(T, lang);
T.count = function(n){ return tr('count', { n: n }); };

var $ = function(s){ return doc.querySelector(s); };
var cats = [];
var canWrite = false;    /* 接口回的 canWrite：账号已登录 + curio.write */
var showPrivate = false; /* 接口回的 showPrivate：账号已登录（看得到私密的） */
var loaded = false;
var cat = 0;
var query = '';
var editing = null; /* 正在编辑的收藏（null = 新建） */
var editCat = 0;
var toastTimer = null;

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}
function getJSON(url){
  var f = G.sgxLockSync ? G.sgxLockSync.apiFetch : function(u, o){ return fetch(u, o); };
  return f(url, { credentials: 'same-origin', cache: 'no-store' }).then(function(r){
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}
function send(url, body, type){
  return fetch(url, {
    method: 'POST', credentials: 'same-origin', redirect: 'manual',
    headers: { 'Content-Type': type || 'application/json' },
    body: type ? body : JSON.stringify(body),
  }).then(function(r){
    if (r.type === 'opaqueredirect') { G.location.reload(); throw Object.assign(new Error('locked'), { sgxLocked: true }); }
    return r.json().catch(function(){ return {}; }).then(function(j){
      if (isLockedReply(r.status, j.error)) { G.location.reload(); throw Object.assign(new Error('locked'), { sgxLocked: true }); }
      if (!r.ok || !j.ok) throw Object.assign(new Error(j.error || ('HTTP ' + r.status)), { code: j.error });
      return j;
    });
  });
}
function op(body){ return send('/curio/api/links', body).then(function(j){ cats = j.cats || []; render(); return j; }); }
function toast(msg){
  var el = $('#bk-toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ el.classList.add('hidden'); }, 2400);
}
function errText(e){
  var c = e && e.code;
  return c === 'duplicate' ? T.dup : c === 'not-empty' ? T.notEmpty : c === 'bad-url' ? T.needUrl : c === 'bad-name' ? T.needName
    : c === 'not-bookmarks' ? T.notBookmarks : c === 'empty' ? T.emptyFile : c === 'too-large' ? T.tooLarge : c === 'limit' ? T.limit : c === 'backup' ? T.backup
    : c === 'account' ? T.needAccount : c === 'scope' ? T.noScopeErr : c === 'reauth' ? T.needReauth : T.failed;
}

/** P4-3 PR-4c：语言路径由模板（sgx-lang-path.html）算好放在 #cu-signin 的 data-*，本文件是经典脚本，不手写语言前缀 @param {string} attr @param {string} fallback */
function pagePath(attr, fallback){
  var el = doc && doc.getElementById('cu-signin');
  return (el && el.getAttribute(attr)) || fallback;
}
/**
 * 不能编辑时页底那一行（P3-1）：没登录账号 → 登录（带 ?return= 回本页，走同意流程）；已登录没授权 → 去 账号 › 应用授权。
 * @param {boolean} loggedIn 接口回的 showPrivate（= 有账号会话）
 * @returns {{text: string, href: string}}
 */
function signinHint(loggedIn){
  var acct = pagePath('data-acct', 'https://styrigx.com/account/');
  if (loggedIn) return { text: T.noScope, href: acct + 'apps/' };
  var here = G.location.pathname + G.location.search + G.location.hash;
  return { text: T.signin, href: acct + '?return=' + encodeURIComponent(here) };
}

/** 长按（≈550ms，手指不挪）触发 fn；触发后吞掉随后的那次点击（不打开网址） */
function onLongPress(root, sel, fn){
  var timer = 0, x0 = 0, y0 = 0, fired = false;
  root.addEventListener('pointerdown', function(e){
    var el = e.target.closest && e.target.closest(sel);
    if (!el || (e.pointerType === 'mouse' && e.button !== 0)) return;
    fired = false; x0 = e.clientX; y0 = e.clientY;
    clearTimeout(timer);
    timer = setTimeout(function(){ fired = true; fn(el); }, 550);
  });
  root.addEventListener('pointermove', function(e){ if (Math.abs(e.clientX - x0) > 10 || Math.abs(e.clientY - y0) > 10) clearTimeout(timer); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function(t){ root.addEventListener(t, function(){ clearTimeout(timer); }); });
  root.addEventListener('contextmenu', function(e){ if (canWrite && e.target.closest && e.target.closest(sel)) e.preventDefault(); });
  root.addEventListener('click', function(e){ if (fired) { fired = false; e.preventDefault(); e.stopImmediatePropagation(); } }, true);
}

/* ---------- 弹层 ---------- */
function openOverlay(id){ var el = doc.getElementById(id); if (!el) return; el.classList.add('open'); doc.body.style.overflow = 'hidden'; }
function closeOverlay(id){
  var el = doc.getElementById(id); if (!el) return;
  el.classList.remove('open');
  if (!doc.querySelector('.bk-overlay.open')) doc.body.style.overflow = '';
}
doc.querySelectorAll('[data-close]').forEach(function(b){ b.addEventListener('click', function(){ closeOverlay(b.dataset.close + '-wrap'); }); });
doc.addEventListener('keydown', function(e){
  if (e.key !== 'Escape') return;
  var open = doc.querySelectorAll('.bk-overlay.open');
  if (open.length) closeOverlay(open[open.length - 1].id);
});
var confirmFn = null;
function ask(msg, okLabel, fn){
  $('#confirm-msg').textContent = msg;
  $('#confirm-ok').textContent = okLabel;
  confirmFn = fn;
  openOverlay('confirm-wrap');
}
$('#confirm-cancel').addEventListener('click', function(){ confirmFn = null; closeOverlay('confirm-wrap'); });
$('#confirm-ok').addEventListener('click', function(){ var f = confirmFn; confirmFn = null; closeOverlay('confirm-wrap'); if (f) f(); });
/* 设备 / 游戏页签（curio-items.js）共用确认框、提示条、弹层开关 */
/** 页底那一行（#cu-signin）：能编辑就藏起来；不能编辑时按有没有账号会话换字和链接（各子页共用，curio-items.js / curio-movies.js 也调） */
function applySignin(can, loggedIn){
  var hint = $('#cu-signin');
  if (!hint) return;
  hint.classList.toggle('hidden', !!can);
  var a = hint.querySelector('a');
  if (a && !can) { var h = signinHint(loggedIn); a.textContent = h.text; a.setAttribute('href', h.href); }
}
G.SgxCurioUI = { ask: function(m, l, f){ ask(m, l, f); }, toast: function(m){ toast(m); }, openOverlay: openOverlay, closeOverlay: closeOverlay, signin: applySignin };
/* P4-3 奇趣拆页：下面是「发现」子页（/curio/finds/）自己的部件；别的子页只用上面的确认框 / 提示条 / 弹层开关 / 页底一行 */
if (!doc.getElementById('cu-list')) return;

/* ---------- 画 ---------- */
var LOCK = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
function findLink(id){
  for (var i = 0; i < cats.length; i++) for (var j = 0; j < cats[i].links.length; j++) if (cats[i].links[j].id === id) return { cat: cats[i], link: cats[i].links[j] };
  return null;
}
function tileHTML(l, c){
  var name = pick(l.name, lang) || hostOf(l.url);
  var desc = pick(l.desc, lang) || hostOf(l.url);
  var locked = showPrivate && (l.private || c.private);
  return '<a class="cu-tile" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer" data-id="' + l.id + '" title="' + esc(desc + ' · ' + l.url) + '">'
    + '<span class="cu-ic"><span class="cu-ic-letter" aria-hidden="true">' + esc(initial(name, l.url)) + '</span>'
    + '<img src="/curio/api/icon?id=' + l.id + '" alt="" width="48" height="48" loading="lazy" decoding="async" onerror="this.remove()"></span>'
    + '<span class="cu-name">' + esc(name) + '</span>'
    + (locked ? '<span class="cu-lock" role="img" aria-label="' + esc(T.priv) + '" title="' + esc(T.priv) + '">' + LOCK + '</span>' : '')
    + '</a>';
}
function renderChips(){
  var html = '<button type="button" role="tab" class="cu-chip" aria-selected="' + (cat === 0) + '" data-cat="0">' + esc(T.all) + '</button>';
  cats.forEach(function(c){
    if (!showPrivate && !c.links.length) return;
    html += '<button type="button" role="tab" class="cu-chip" aria-selected="' + (cat === c.id) + '" data-cat="' + c.id + '">'
      + (showPrivate && c.private ? '<span class="cu-chip-lock">' + LOCK + '</span>' : '') + esc(pick(c.name, lang)) + '</button>';
  });
  $('#cu-chips').innerHTML = html;
  var sel = $('#cu-chips [aria-selected="true"]');
  if (sel && sel.scrollIntoView && cat) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function render(){
  if (cat && !cats.some(function(c){ return c.id === cat; })) cat = 0;
  renderChips();
  var shown = filterCats(cats, query, cat);
  var list = $('#cu-list');
  list.innerHTML = shown.map(function(c){
    return '<section class="cu-sec" data-cat="' + c.id + '"><h2 class="cu-sec-h"><span>' + esc(pick(c.name, lang)) + '</span>'
      + (showPrivate && c.private ? '<span class="cu-lock-inline" title="' + esc(T.priv) + '">' + LOCK + '</span>' : '')
      + '<span class="cu-sec-n">' + esc(T.count(c.links.length)) + '</span></h2>'
      + '<div class="cu-grid">' + c.links.map(function(l){ return tileHTML(l, c); }).join('') + '</div></section>';
  }).join('');
  var empty = $('#cu-empty');
  var none = loaded && !countLinks(shown);
  empty.textContent = query ? T.noMatch : canWrite ? T.emptyAdmin : T.emptyVisitor;
  empty.classList.toggle('hidden', !none);
}

/* ---------- 筛选 ---------- */
$('#cu-chips').addEventListener('click', function(e){
  var b = e.target.closest('[data-cat]');
  if (!b) return;
  cat = Number(b.dataset.cat) || 0;
  try { G.history.replaceState(null, '', G.location.pathname + G.location.search + catHash(cat)); } catch (err) {}
  render();
  G.scrollTo({ top: 0, behavior: 'auto' });
});
/* ---------- 编辑 ---------- */
function setErr(msg){ var el = $('#edit-err'); el.textContent = msg || ''; el.classList.toggle('hidden', !msg); }
function renderCatPicker(){
  $('#f-cats').innerHTML = cats.map(function(c){
    return '<button type="button" role="radio" class="cu-chip cu-chip-sm" aria-checked="' + (editCat === c.id) + '" data-cat="' + c.id + '">' + esc(pick(c.name, lang)) + '</button>';
  }).join('');
}
$('#f-cats').addEventListener('click', function(e){
  var b = e.target.closest('[data-cat]');
  if (!b) return;
  editCat = Number(b.dataset.cat);
  renderCatPicker();
});
function openEdit(link, inCat){
  editing = link;
  var cl = contentLangs(lang), en1 = cl[0], en2 = cl[1];
  $('#edit-title').textContent = link ? T.edit : T.add;
  $('#f-url').value = link ? link.url : '';
  $('#f-name').value = link ? (link.name[en1] || '') : '';
  $('#f-desc').value = link ? (link.desc[en1] || '') : '';
  $('#f-name2').value = link ? (link.name[en2] || '') : '';
  $('#f-desc2').value = link ? (link.desc[en2] || '') : '';
  var hasSecond = !!(link && (link.name[en2] || link.desc[en2]));
  $('#f-en-wrap').classList.toggle('hidden', !hasSecond);
  $('#f-en-toggle').classList.toggle('hidden', hasSecond);
  $('#f-icon').value = link ? (link.icon || '') : '';
  $('#f-icon-wrap').classList.toggle('hidden', !(link && link.icon));
  $('#f-icon-toggle').classList.toggle('hidden', !!(link && link.icon));
  $('#f-private').checked = !!(link && link.private);
  editCat = inCat || cat || (cats[0] && cats[0].id) || 0;
  $('#f-cat-name').value = '';
  renderCatPicker();
  $('#f-move').classList.toggle('hidden', !link);
  $('#edit-del').classList.toggle('hidden', !link);
  setErr('');
  openOverlay('edit-wrap');
  if (!link) setTimeout(function(){ $('#f-url').focus(); }, 50);
}
$('#f-en-toggle').addEventListener('click', function(){ $('#f-en-wrap').classList.remove('hidden'); $('#f-en-toggle').classList.add('hidden'); $('#f-name2').focus(); });
$('#f-icon-toggle').addEventListener('click', function(){ $('#f-icon-wrap').classList.remove('hidden'); $('#f-icon-toggle').classList.add('hidden'); $('#f-icon').focus(); });
$('#f-fill').addEventListener('click', function(){
  var url = normalizeUrl($('#f-url').value);
  if (!url) { setErr(T.needUrl); return; }
  $('#f-url').value = url;
  var btn = $('#f-fill');
  btn.disabled = true; btn.dataset.label = btn.dataset.label || btn.textContent; btn.textContent = T.filling;
  setErr('');
  fetch('/curio/api/preview?url=' + encodeURIComponent(url), { credentials: 'same-origin', redirect: 'manual' }).then(function(r){ return r.json(); }).then(function(j){
    if (!j.ok) { setErr(T.fillFail); return; }
    if (!$('#f-name').value && j.title) $('#f-name').value = j.title;
    if (!$('#f-desc').value && j.desc) $('#f-desc').value = j.desc;
    if (j.url && j.url !== url) $('#f-url').value = j.url;
  }).catch(function(){ setErr(T.fillFail); }).then(function(){ btn.disabled = false; btn.textContent = btn.dataset.label; });
});
$('#f-cat-add').addEventListener('click', function(){
  var name = $('#f-cat-name').value.trim();
  if (!name) return;
  var before = cats.map(function(c){ return c.id; });
  op({ op: 'cat.add', name: contentPair(lang, name, '') }).then(function(){
    var nc = cats.filter(function(c){ return before.indexOf(c.id) < 0; })[0];
    if (nc) editCat = nc.id;
    $('#f-cat-name').value = '';
    renderCatPicker();
  }).catch(function(e){ if (!e.sgxLocked) setErr(errText(e)); });
});
$('#edit-save').addEventListener('click', function(){
  var url = normalizeUrl($('#f-url').value);
  if (!url) { setErr(T.needUrl); return; }
  var a = $('#f-name').value.trim(), b = $('#f-name2').value.trim();
  if (!a && !b) { setErr(T.needName); return; }
  if (!editCat) { setErr(T.needCat); return; }
  var name = contentPair(lang, a, b);
  var desc = contentPair(lang, $('#f-desc').value.trim(), $('#f-desc2').value.trim());
  var body = { url: url, name: name, desc: desc, icon: $('#f-icon').value.trim() ? normalizeUrl($('#f-icon').value) : '', private: $('#f-private').checked };
  if (editing) { body.op = 'link.edit'; body.id = editing.id; body.cat = editCat; } else { body.op = 'link.add'; body.cat = editCat; }
  var btn = $('#edit-save');
  btn.disabled = true;
  op(body).then(function(){ closeOverlay('edit-wrap'); toast(T.saved); }).catch(function(e){ if (!e.sgxLocked) setErr(errText(e)); }).then(function(){ btn.disabled = false; });
});
$('#edit-del').addEventListener('click', function(){
  if (!editing) return;
  var id = editing.id;
  ask(T.delLink, T.del, function(){
    op({ op: 'link.del', id: id }).then(function(){ closeOverlay('edit-wrap'); toast(T.deleted); }).catch(function(e){ if (!e.sgxLocked) toast(errText(e)); });
  });
});
function moveLink(dir){
  if (!editing) return;
  var hit = findLink(editing.id);
  if (!hit) return;
  var ids = moveId(hit.cat.links.map(function(l){ return l.id; }), editing.id, dir);
  if (!ids) return;
  op({ op: 'link.order', cat: hit.cat.id, ids: ids }).catch(function(e){ if (!e.sgxLocked) toast(errText(e)); });
}
$('#f-up').addEventListener('click', function(){ moveLink(-1); });
$('#f-down').addEventListener('click', function(){ moveLink(1); });
$('#cu-fab').addEventListener('click', function(){ openEdit(null); });

/* 能编辑：长按格子编辑；键盘：格子上按 E 编辑 */
onLongPress($('#cu-list'), '.cu-tile', function(el){
  if (!canWrite) return;
  var hit = findLink(Number(el.dataset.id));
  if (hit) { try { navigator.vibrate && navigator.vibrate(12); } catch (e) {} openEdit(hit.link, hit.cat.id); }
});
$('#cu-list').addEventListener('keydown', function(e){
  if (!canWrite || (e.key !== 'e' && e.key !== 'E')) return;
  var el = e.target.closest && e.target.closest('.cu-tile');
  var hit = el && findLink(Number(el.dataset.id));
  if (hit) { e.preventDefault(); openEdit(hit.link, hit.cat.id); }
});

/* ---------- 菜单 / 分类 / 导入 ---------- */
$('#cu-menu-btn').addEventListener('click', function(){ openOverlay('menu-wrap'); });
$('#menu-cats').addEventListener('click', function(){ closeOverlay('menu-wrap'); renderCatsSheet(); openOverlay('cats-wrap'); });
$('#menu-import').addEventListener('click', function(){ closeOverlay('menu-wrap'); resetImport(); openOverlay('import-wrap'); });
$('#menu-export').addEventListener('click', function(){ closeOverlay('menu-wrap'); });

function renderCatsSheet(){
  var ids = cats.map(function(c){ return c.id; });
  $('#cats-list').innerHTML = cats.map(function(c, i){
    return '<div class="cu-catrow" data-id="' + c.id + '">'
      + '<input type="text" maxlength="80" value="' + esc(pick(c.name, lang)) + '" aria-label="' + esc(pick(c.name, lang)) + '">'
      + '<span class="cu-catrow-n">' + c.links.length + '</span>'
      + '<button type="button" class="cu-rbtn" data-act="priv" aria-pressed="' + !!c.private + '" title="' + esc(c.private ? T.makePublic : T.makePrivate) + '" aria-label="' + esc(T.makePrivate) + '">' + LOCK + '</button>'
      + '<button type="button" class="cu-rbtn" data-act="up" aria-label="' + esc(T.up) + '"' + (i === 0 ? ' disabled' : '') + '><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg></button>'
      + '<button type="button" class="cu-rbtn" data-act="down" aria-label="' + esc(T.down) + '"' + (i === ids.length - 1 ? ' disabled' : '') + '><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>'
      + '<button type="button" class="cu-rbtn cu-rbtn-x" data-act="del" aria-label="' + esc(T.del) + '"' + (c.links.length ? ' disabled' : '') + '><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'
      + '</div>';
  }).join('');
}
function catOp(body){ return op(body).then(renderCatsSheet).catch(function(e){ if (!e.sgxLocked) toast(errText(e)); }); }
$('#cats-list').addEventListener('click', function(e){
  var b = e.target.closest('[data-act]');
  if (!b) return;
  var id = Number(b.closest('[data-id]').dataset.id);
  var c = cats.filter(function(x){ return x.id === id; })[0];
  if (!c) return;
  var act = b.dataset.act;
  if (act === 'priv') catOp({ op: 'cat.edit', id: id, private: !c.private });
  else if (act === 'up' || act === 'down') { var ids = moveId(cats.map(function(x){ return x.id; }), id, act === 'up' ? -1 : 1); if (ids) catOp({ op: 'cat.order', ids: ids }); }
  else if (act === 'del') ask(T.delCat, T.del, function(){ catOp({ op: 'cat.del', id: id }); });
});
$('#cats-list').addEventListener('change', function(e){
  var input = e.target;
  if (input.tagName !== 'INPUT') return;
  var id = Number(input.closest('[data-id]').dataset.id);
  var c = cats.filter(function(x){ return x.id === id; })[0];
  var v = input.value.trim();
  if (!c || !v || v === pick(c.name, lang)) { if (c) input.value = pick(c.name, lang); return; }
  var name = Object.assign({}, c.name);
  name[contentLangs(lang)[0]] = v;
  catOp({ op: 'cat.edit', id: id, name: name });
});
$('#cats-add').addEventListener('click', function(){
  var v = $('#cats-new').value.trim();
  if (!v) return;
  catOp({ op: 'cat.add', name: contentPair(lang, v, '') }).then(function(){ $('#cats-new').value = ''; });
});

var impFile = null;
function impMsg(text, bad, link){
  var el = $('#imp-msg');
  el.textContent = text || '';
  if (text && link) {
    /* 要账号复验（401 reauth）：提示后面带一个去账号页的链接（P3-1 前的简版） */
    var a = doc.createElement('a');
    a.href = link.href; a.textContent = link.label; a.className = 'underline font-bold ml-1';
    el.appendChild(a);
  }
  el.classList.toggle('hidden', !text); el.classList.toggle('text-m-error', !!bad);
}
/** 账号页「安全与隐私」（每次进都要验证账号，验过 3 分钟内导入不再要求复验） */
function reauthLink(){ return { href: pagePath('data-acct-sec', '/account/security/'), label: T.verifyNow }; }
function resetImport(){
  impFile = null;
  $('#imp-file').value = '';
  var nameEl = $('#imp-file-name');
  nameEl.textContent = nameEl.dataset.ph || nameEl.textContent;
  nameEl.dataset.ph = nameEl.textContent;
  $('#imp-go').disabled = true;
  impMsg('');
}
$('#imp-file').addEventListener('change', function(){
  impFile = this.files && this.files[0] || null;
  var nameEl = $('#imp-file-name');
  nameEl.dataset.ph = nameEl.dataset.ph || nameEl.textContent;
  nameEl.textContent = impFile ? impFile.name : nameEl.dataset.ph;
  $('#imp-go').disabled = !impFile;
  impMsg('');
});
$('#imp-go').addEventListener('click', function(){
  if (!impFile) return;
  var btn = $('#imp-go');
  btn.disabled = true;
  impMsg(T.importing);
  impFile.text().then(function(text){
    return send('/curio/api/import' + ($('#imp-private').checked ? '' : '?private=0'), text, 'text/html');
  }).then(function(j){
    cats = j.cats || [];
    render();
    impMsg(importSummary(j, tr));
    impFile = null;
  }).catch(function(e){ if (!e.sgxLocked) { impMsg(errText(e), true, e.code === 'reauth' ? reauthLink() : null); btn.disabled = false; } });
});

/* ---------- 启动 ---------- */
function boot(){
  cat = parseHash(G.location.hash);
  getJSON('/curio/api/links').then(function(j){
    canWrite = !!j.canWrite;
    showPrivate = !!j.showPrivate;
    cats = j.cats || [];
    loaded = true;
    doc.documentElement.classList.toggle('cu-can-write', canWrite);
    $('#cu-fab').classList.toggle('hidden', !canWrite);
    $('#cu-menu-btn').classList.toggle('hidden', !canWrite);
    applySignin(canWrite, showPrivate);
    $('#cu-loading').classList.add('hidden');
    render();
  }).catch(function(e){
    if (e && e.sgxLocked) return;
    $('#cu-loading').textContent = T.failed;
  });
}
boot();
})();
