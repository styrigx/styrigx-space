/* assets/js/curio.js —— 奇趣「发现」子页逻辑 + 各子页共用的确认框 / 提示条 / 弹层开关 / 页底一行（浏览器 IIFE；node 测试时导出纯函数）。
 *
 * - 「发现」= 奇趣首页 /curio/ 和 /curio/finds/（中文 /curio/zh/…；2026-11 对齐 PR-C2 起同一份内容）：分类 chips（全部 + 每个分类，hash #c/<分类 id>，只用 replaceState）。
 *   设备 / 游戏 / 电影 / 音乐子页也加载本文件，只用 window.SgxCurioUI（没有 #cu-list 时后面「发现」的部件不启动）。
 *   grep / 排序 / 分页在 curio-list.js（只动画好的卡片）；filterCats 的搜索词留给以后。
 * - 封面卡（设计稿 .cc）：封面位放站点图标（/api/icon?id=，R2 缓存；取不到显示首字母方块）、「finds · 域名」、名字、#分类；私密的带小锁（只有账号已登录看得到私密的）。
 *   点卡片在新标签页打开网址。
 * - 能编辑（接口回 canWrite：账号已登录 + 作用域 curio.write）：页头命令链「收藏 / 管理分类 / 导入书签 / 导出书签」；长按卡片（或键盘 E 键）编辑。
 *   编辑弹层：网址（「自动填写」抓标题、简介、图标）、名字、英文名和英文简介、简介、分类（可就地新建）、自定义图标、仅自己可见、上移 / 下移、删除。
 * - 不能编辑（canWrite=false）：命令链里只有一条「sudo login」（#cu-signin，signinHint）：
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
  if (!can) {
    var h = signinHint(loggedIn), t = hint.querySelector('[data-signin-text]');
    if (t) t.textContent = h.text;
    hint.setAttribute('href', h.href);
  }
}

/* ---------- 条目页（2026-11 对齐 PR-C2，设计稿 pg=citem；取代旧的详情弹层）：设备 / 游戏 / 电影子页的 ?id=<编号> ----------
   列表（页头、tab、命令链、分区面板）和条目页（#cu-item）二选一显示；点卡片 pushState，返回键 popstate 回到列表。 */
var ITEM_IMG = '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5-8 8.5"/></svg>';
/** 地址里的条目编号（?id=）；没有 / 不对返回 0 */
function itemIdOf(search){ var m = /[?&]id=(\d+)(?:&|$)/.exec(String(search || '')); return m ? Number(m[1]) : 0; }
/** 名字 → 面包屑里的文件名（小写、空白变 -、去掉路径符号；中文原样） */
function slugOf(name){ return String(name || '').trim().toLowerCase().replace(/[\/\\?#%*:|"<>]+/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'item'; }
function listParts(){ return doc.querySelectorAll('#cu-main > .sgx-ph, #cu-tabs, #cu-cmds, #cu-main > .cu-pane'); }
function showList(){
  var it = $('#cu-item'); if (it) { it.hidden = true; it.innerHTML = ''; }
  listParts().forEach(function(el){ el.hidden = false; });
}
/**
 * 画条目页：o = {dir 分区目录名（devices / games / movies）, name, img（封面 HTML，可空）, meta（「devices · 在用 · 收入于 2024-03」）,
 *   spec [[标签, 值 HTML]], prose（短评，纯文字）, edit {k, d, fn}（能编辑时）, prev / next {href, k, title}（next 为空就不画右卡）}
 */
function showItem(o){
  var it = $('#cu-item'); if (!it) return;
  listParts().forEach(function(el){ el.hidden = true; });
  var nx = function(x, right){
    if (!x) return '<li></li>';
    return '<li><a class="sgx-nx-a' + (right ? ' is-next' : '') + '" href="' + esc(x.href) + '"' + (x.ext ? ' target="_blank" rel="noopener"' : '') + (x.id ? ' data-item="' + x.id + '"' : '') + '>'
      + (right ? esc(x.k) + ' ›' : '‹ ' + esc(x.k)) + '<b>' + esc(x.title) + '</b></a></li>';
  };
  it.innerHTML = '<p class="sgx-crumb" translate="no"><span class="sgx-pr">$</span>cat ~/curio/' + esc(o.dir) + '/' + esc(slugOf(o.name)) + '</p>'
    + '<div class="sgx-item"><div class="sgx-item-im">' + (o.img || ITEM_IMG) + '</div><div class="sgx-item-b">'
    + '<p class="sgx-item-m">' + esc(o.meta || '') + '</p><h1 class="sgx-item-t">' + esc(o.name) + '</h1>'
    + (o.spec && o.spec.length ? '<dl class="sgx-spec">' + o.spec.map(function(r){ return '<div><dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd></div>'; }).join('') + '</dl>' : '')
    + (o.prose ? '<p class="sgx-item-p">' + esc(o.prose) + '</p>' : '')
    + (o.edit ? '<div class="sgx-cmds"><button type="button" class="sgx-cmd" data-item-edit><span class="sgx-cmd-k" translate="no">' + esc(o.edit.k) + '</span><i>' + esc(o.edit.d) + '</i></button></div>' : '')
    + '<ul class="sgx-nx">' + nx(o.prev, false) + nx(o.next, true) + '</ul>'
    + '</div></div>';
  it.hidden = false;
  var eb = it.querySelector('[data-item-edit]');
  if (eb && o.edit) eb.addEventListener('click', o.edit.fn);
}
/** 去某个条目（0 = 回列表）：改地址（pushState）并通知本页脚本重画 */
function goItem(id, replace){
  var url = G.location.pathname + (id ? '?id=' + id : '') + G.location.hash;
  try { G.history[replace ? 'replaceState' : 'pushState']({ cuItem: id }, '', url); } catch (e) {}
  G.scrollTo({ top: 0, behavior: 'auto' });
  if (itemRoute) itemRoute(id);
}
var itemRoute = null;
/** 本页脚本登记路由：fn(id)（id = 0 时回列表）；卡片 / 条目页里带 data-item 的链接点了走这里（新标签页 / 修饰键照常） */
function onItemRoute(fn){
  itemRoute = fn;
  G.addEventListener('popstate', function(){ fn(itemIdOf(G.location.search)); });
  doc.addEventListener('click', function(e){
    var a = e.target.closest && e.target.closest('a[data-item]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    goItem(Number(a.getAttribute('data-item')) || 0);
  });
}
G.SgxCurioUI = { ask: function(m, l, f){ ask(m, l, f); }, toast: function(m){ toast(m); }, openOverlay: openOverlay, closeOverlay: closeOverlay, signin: applySignin,
  itemId: function(){ return itemIdOf(G.location.search); }, showItem: showItem, showList: showList, goItem: goItem, onItemRoute: onItemRoute, slug: slugOf };
/* 页头 tab 的「音乐」仅本人可见，默认被 CSS 藏着；不在音乐页时问 /curio/api/access（进门即可，只回布尔），
   music = true 才给 <html> 加 .cu-music-ok。没权限、出错都保持藏着。 */
/* 直接打开 / 刷新条目页：列表先藏起来，等本页脚本拿到数据再画条目（免得先闪一下列表） */
if (itemIdOf(G.location.search) && doc.getElementById('cu-item')) listParts().forEach(function(el){ el.hidden = true; });
var musicSeg = doc.querySelector('#cu-tabs [data-ctab="music"]');
if (musicSeg && !musicSeg.hasAttribute('aria-current') && typeof fetch === 'function') {
  fetch('/curio/api/access', { credentials: 'same-origin', cache: 'no-store' }).then(function(r){
    return r.ok ? r.json() : null;
  }).then(function(j){
    if (j && j.ok && j.music === true) doc.documentElement.classList.add('cu-music-ok');
  }).catch(function(){});
}
/* P4-3 奇趣拆页：下面是「发现」子页（/curio/finds/）自己的部件；别的子页只用上面的确认框 / 提示条 / 弹层开关 / 页底一行 */
if (!doc.getElementById('cu-list')) return;

/* ---------- 画 ---------- */
var LOCK = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
function findLink(id){
  for (var i = 0; i < cats.length; i++) for (var j = 0; j < cats[i].links.length; j++) if (cats[i].links[j].id === id) return { cat: cats[i], link: cats[i].links[j] };
  return null;
}
/** 封面卡（设计稿 .cc）：封面位 = 站点图标（取不到是首字母），「finds · 域名」/ 名字 / #分类；data-q 给 grep，data-s-* 给排序 */
function cardHTML(l, c, i){
  var name = pick(l.name, lang) || hostOf(l.url);
  var desc = pick(l.desc, lang);
  var cname = pick(c.name, lang);
  var locked = showPrivate && (l.private || c.private);
  var q = [l.name && l.name.zh, l.name && l.name.en, l.desc && l.desc.zh, l.desc && l.desc.en, hostOf(l.url), cname].join(' ');
  return '<a class="sgx-cc cu-cc" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer" data-id="' + l.id + '" title="' + esc((desc ? desc + ' · ' : '') + l.url) + '"'
    + ' data-q="' + esc(q) + '" data-ord="' + i + '" data-s-recent="' + l.id + '" data-s-order="' + i + '" data-s-name="' + esc(name) + '">'
    + '<span class="sgx-cc-im"><span class="cu-ic"><span class="cu-ic-letter" aria-hidden="true">' + esc(initial(name, l.url)) + '</span>'
    + '<img src="/curio/api/icon?id=' + l.id + '" alt="" width="48" height="48" loading="lazy" decoding="async" onerror="this.remove()"></span></span>'
    + '<span class="sgx-cc-ci"><span class="sgx-cc-m" translate="no">finds · ' + esc(hostOf(l.url)) + '</span>'
    + '<span class="sgx-cc-t"><span class="cu-name">' + esc(name) + '</span>'
    + (locked ? '<span class="cu-lock" role="img" aria-label="' + esc(T.priv) + '" title="' + esc(T.priv) + '">' + LOCK + '</span>' : '') + '</span>'
    + '<span class="sgx-cc-k">#' + esc(cname) + '</span></span>'
    + '</a>';
}
function renderChips(){
  var html = '<button type="button" role="tab" class="sgx-chip" aria-selected="' + (cat === 0) + '" data-cat="0">' + esc(T.all) + ' <i>' + countLinks(cats) + '</i></button>';
  cats.forEach(function(c){
    if (!showPrivate && !c.links.length) return;
    html += '<button type="button" role="tab" class="sgx-chip" aria-selected="' + (cat === c.id) + '" data-cat="' + c.id + '">'
      + (showPrivate && c.private ? '<span class="cu-chip-lock">' + LOCK + '</span>' : '') + esc(pick(c.name, lang)) + ' <i>' + c.links.length + '</i></button>';
  });
  $('#cu-chips').innerHTML = html;
}
function render(){
  if (cat && !cats.some(function(c){ return c.id === cat; })) cat = 0;
  renderChips();
  var shown = filterCats(cats, query, cat);
  var list = $('#cu-list'), i = 0, html = '';
  shown.forEach(function(c){ c.links.forEach(function(l){ html += cardHTML(l, c, i++); }); });
  list.innerHTML = html;
  var empty = $('#cu-empty');
  var none = loaded && !countLinks(shown);
  empty.textContent = query ? T.noMatch : canWrite ? T.emptyAdmin : T.emptyVisitor;
  empty.classList.toggle('hidden', !none);
  if (loaded && G.SgxCurioList) G.SgxCurioList.count('finds', countLinks(cats));
}

/* ---------- 筛选 ---------- */
$('#cu-chips').addEventListener('click', function(e){
  var b = e.target.closest('[data-cat]');
  if (!b) return;
  cat = Number(b.dataset.cat) || 0;
  try { G.history.replaceState(null, '', G.location.pathname + G.location.search + catHash(cat)); } catch (err) {}
  render();
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

/* 能编辑：长按卡片编辑；键盘：卡片上按 E 编辑 */
onLongPress($('#cu-list'), '.cu-cc', function(el){
  if (!canWrite) return;
  var hit = findLink(Number(el.dataset.id));
  if (hit) { try { navigator.vibrate && navigator.vibrate(12); } catch (e) {} openEdit(hit.link, hit.cat.id); }
});
$('#cu-list').addEventListener('keydown', function(e){
  if (!canWrite || (e.key !== 'e' && e.key !== 'E')) return;
  var el = e.target.closest && e.target.closest('.cu-cc');
  var hit = el && findLink(Number(el.dataset.id));
  if (hit) { e.preventDefault(); openEdit(hit.link, hit.cat.id); }
});

/* ---------- 管理分类 / 导入（页头命令链；导出是命令链里的下载链接） ---------- */
$('#menu-cats').addEventListener('click', function(){ renderCatsSheet(); openOverlay('cats-wrap'); });
$('#menu-import').addEventListener('click', function(){ resetImport(); openOverlay('import-wrap'); });

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
    ['#cu-fab', '#menu-cats', '#menu-import', '#menu-export'].forEach(function(id){ $(id).classList.toggle('hidden', !canWrite); });
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
