/* assets/js/daymark.js —— 日刻首页逻辑（浏览器 IIFE；node 测试时导出纯函数）。
 *
 * 三个分区（顺序固定；顶栏页名胶囊显示当前分区名）：余响 Echo（默认 = 首页）· 拾录 Trove · 百味 Flavors。
 *   hash：余响 = 无（看某一天 #d/<YYYY-MM-DD>），#trove，#flavors；百味里的分组 #flavors/c/<专题 id>、#flavors/a/<作者>。只用 replaceState，切分区不加历史。
 * - 余响（2026-11 对齐 PR-C2，设计稿 pg=day）：居中一句（今日一句 /api/today，当天锁定），上面「cat daymark/<日期>」和日期行「2026 · 11 · 08 · 星期日」。
 *   命令链：shuf -n1 再抽一句（从能看到的句子里随机抽：账号已登录全部、没登录公开），抽过或看别的日子时多一条 cat today 回到今日；
 *   能编辑（接口回 canWrite：账号已登录 + daymark.write）时抽到公开句子还多一条 set today 设为今日（PUT /api/today 改写今天那句，回到今日状态，toast 已设为今日；主站首页和锁屏跟着变）。
 *   13 格日期条（以正在看的那天为中心；今天主题色描边；还没到 / 那天没记下的灰掉）：点格子看那天记下的句子（/api/days，只读往前已锁定的日子）。
 *   下面三个终端窗：余响（最近几天的句子，点了看那天）· 拾录（最新三句）· 百味（专题 / 人物），窗标题进完整列表；再下面前后日两卡（明天是「明天见」）。
 *   长按复制（toast 已复制）；分享本页并入顶栏 NAVIGATE share（旧的右上角分享图标删掉）。
 * - 拾录：全部句子，新的在前；没有搜索。能编辑：页头命令「touch trove/ + 记一句」，点句子进编辑；私密句子带小锁（showPrivate：账号已登录）。
 * - 百味：先是自建专题（能编辑时多一张「＋ 新建」），再是按作者自动分组的「人物」；点进去是该组的句子（页内返回）。
 *   能编辑时在自建专题里可以上移 / 下移 / 移出句子、删专题。
 * - 不能编辑（canWrite=false）：余响命令链里多一条（#dm-signin，signinHint）：没登录 →「su · su 登录后可编辑」，点了打开顶栏终端、预填 su （2c）
 *   已以 v6 用户登录但不在 daymark-write → 无权限句（「未获账号授权 → 应用授权」那一层随应用授权删除，v6 P4）。
 * - 记一句（底部弹层）：顶部实时预览；句子；「＋ 加译文」；作者（自动补全 + 最近作者）；出处（类型 + 名字自动补全）；
 *   归入百味（多选 + 就地新建）；标签（回车 / 逗号成块，推荐已有标签）；随手一笔（只有账号已登录看得到）；公开开关。
 *
 * 数据：GET /api/quotes、GET /api/collections、GET /api/today、GET /api/days（往前几天）；写：POST/PUT/DELETE /api/quotes、/api/collections、PUT /api/today（账号会话 + daymark.write + 同源）。
 * 读接口公开（v5 S3）；写请求回 401 = 没进站 → 发 sgx:sudo（顶栏终端预填 su ）。纯函数导出给 tests/daymark/daymark.test.mjs。
 */
(function(){
"use strict";
var G = typeof globalThis !== 'undefined' ? globalThis : this;

/* ================= 纯函数 ================= */

var TABS = ['echo', 'trove', 'flavors'];
var SOURCE_TYPES = ['poetry', 'book', 'film', 'song', 'interview', 'mine'];
var MAX_TAGS = 8;

/** hash → 路由 {tab, group?:{kind:'c'|'a', key}}；认不出返回 null */
function parseHash(hash){
  var h = String(hash || '').replace(/^#/, '');
  if (!h) return { tab: 'echo' };
  var dm = /^d\/(\d{4}-\d{2}-\d{2})$/.exec(h);
  if (dm) return { tab: 'echo', day: dm[1] };
  var parts = h.split('/');
  var tab = parts[0];
  if (TABS.indexOf(tab) < 0) return null;
  if (tab === 'flavors' && (parts[1] === 'c' || parts[1] === 'a') && parts.length > 2) {
    var key;
    try { key = decodeURIComponent(parts.slice(2).join('/')); } catch (e) { return { tab: 'flavors' }; }
    if (key) return { tab: 'flavors', group: { kind: parts[1], key: key } };
  }
  return { tab: tab };
}

/** 路由 → hash */
function routeHash(r){
  if (r && r.tab === 'echo' && r.day) return '#d/' + r.day;
  if (!r || r.tab === 'echo') return '';
  if (r.tab === 'flavors' && r.group) return '#flavors/' + r.group.kind + '/' + encodeURIComponent(r.group.key);
  return '#' + r.tab;
}

/** 标签输入 → 标签数组（逗号、顿号、空格分隔；去 #、去重、最多 8 个、每个 20 字） */
function parseTagInput(s){
  var out = [];
  String(s || '').split(/[,，、\s]+/).forEach(function(t){
    t = t.replace(/^#+/, '').trim().slice(0, 20);
    if (t && out.indexOf(t) < 0 && out.length < MAX_TAGS) out.push(t);
  });
  return out;
}

/** 已有标签块 + 新输入的文字 → 新的标签块（保持顺序、去重、最多 8 个） */
function addTags(tags, input){
  var out = (tags || []).slice();
  parseTagInput(input).forEach(function(t){ if (out.indexOf(t) < 0 && out.length < MAX_TAGS) out.push(t); });
  return out;
}

/** 全部标签，按出现次数从多到少（同数按字母） */
function allTags(quotes){
  return countBy(quotes, function(q){ return q.tags || []; }).map(function(x){ return x.name; });
}

/** 按某个字段计数，次数多的在前，同数按字母；空值跳过 → [{name, count}] */
function countBy(quotes, pick){
  var n = {};
  (quotes || []).forEach(function(q){
    var v = pick(q);
    (Array.isArray(v) ? v : [v]).forEach(function(x){ x = String(x || '').trim(); if (x) n[x] = (n[x] || 0) + 1; });
  });
  return Object.keys(n).sort(function(a, b){ return n[b] - n[a] || (a < b ? -1 : a > b ? 1 : 0); })
    .map(function(k){ return { name: k, count: n[k] }; });
}

/** 百味 · 人物：每位作者一组（没写作者的不分组） */
function authorGroups(quotes){ return countBy(quotes, function(q){ return q.author; }); }

/** 最近用过的作者（按添加时间新→旧去重），最多 n 个 */
function recentAuthors(quotes, n){
  var out = [];
  (quotes || []).slice().sort(function(a, b){ return (b.created_at || 0) - (a.created_at || 0); }).forEach(function(q){
    var a = String(q.author || '').trim();
    if (a && out.indexOf(a) < 0 && out.length < (n || 6)) out.push(a);
  });
  return out;
}

/** 出处名字候选：给了类型就只要同类型的，常用的在前 */
function knownSources(quotes, type){
  return countBy((quotes || []).filter(function(q){ return !type || q.source_type === type; }), function(q){ return q.source; })
    .map(function(x){ return x.name; });
}

/** 自动补全：包含输入（不分大小写）的候选，开头就匹配的排前面；和输入完全一样的不出；最多 n 个 */
function suggest(list, input, n){
  var q = String(input || '').trim().toLowerCase();
  if (!q) return [];
  var head = [], mid = [];
  (list || []).forEach(function(s){
    var l = String(s).toLowerCase();
    if (l === q) return;
    var i = l.indexOf(q);
    if (i === 0) head.push(s); else if (i > 0) mid.push(s);
  });
  return head.concat(mid).slice(0, n || 5);
}

/** 再抽一句：随机一条，尽量不和现在这条相同；空列表返回 null */
function pickRandom(list, excludeId, rnd){
  var pool = (list || []).filter(function(q){ return q.id !== excludeId; });
  if (!pool.length) pool = list || [];
  if (!pool.length) return null;
  var r = typeof rnd === 'function' ? rnd() : Math.random();
  return pool[Math.min(pool.length - 1, Math.floor(r * pool.length))];
}

/** 「设为今日」显不显示：canWrite、抽过、抽到的是公开句子、而且不是今天这句（私密句子不出 /api/today，不让设） */
function canSetToday(canWrite, isDrawn, q, todayQuote){
  return !!(canWrite && isDrawn && q && q.visibility !== 'private' && !(todayQuote && todayQuote.id === q.id));
}

/**
 * 写请求的 401 是不是「锁定了」（要刷新去锁屏）：401 都是（同奇趣 curio.js）。
 * @param {number} status
 */
function isLockedReply(status){
  return status === 401;
}

/** 数组里第 i 项挪 delta 位（越界不动），返回新数组 */
function moveItem(arr, i, delta){
  var out = (arr || []).slice();
  var j = i + delta;
  if (i < 0 || i >= out.length || j < 0 || j >= out.length) return out;
  var x = out.splice(i, 1)[0];
  out.splice(j, 0, x);
  return out;
}

/** 百味分组里的句子：自建专题按专题顺序；人物按添加时间新→旧（quotes 已是新→旧） */
function groupQuotes(quotes, collections, group){
  if (!group) return [];
  if (group.kind === 'a') return (quotes || []).filter(function(q){ return q.author === group.key; });
  var c = (collections || []).filter(function(x){ return x.id === group.key; })[0];
  if (!c) return [];
  var by = {};
  (quotes || []).forEach(function(q){ by[q.id] = q; });
  return (c.quote_ids || []).map(function(id){ return by[id]; }).filter(Boolean);
}

/** 署名「作者 · 《出处》」：诗词 / 书 / 电影 / 歌加书名号（出处里已有书名号就原样用），访谈 / 自己 / 没选类型不加；英文 "Author · Source" */
/* 出处的书名格式按语言在字符串表 js.daymark.sourceTitle（英文「{s}」原样，中文「《{s}》」）；没给 = 原样 */
function attribution(q, titleTpl){
  var a = String((q && q.author) || '').trim();
  var s = String((q && q.source) || '').trim();
  var tpl = typeof titleTpl === 'string' && titleTpl.indexOf('{s}') >= 0 ? titleTpl : '{s}';
  if (s && tpl !== '{s}') {
    var t = q.source_type || '';
    /* 自己已经带书名号的（如「《查拉图斯特拉如是说》·序言 3」）原样用 */
    if (!/[《》]/.test(s) && (t === 'poetry' || t === 'book' || t === 'film' || t === 'song')) s = tpl.split('{s}').join(s);
  }
  return [a, s].filter(Boolean).join(' · ');
}

/** Intl 日期（坏语言代码退回英文） */
function intlDate(d, lang, opts){
  try { return new Intl.DateTimeFormat(lang || 'en', opts).format(d); } catch (e) { return new Intl.DateTimeFormat('en', opts).format(d); }
}

/** 今日的日期行：YYYY-MM-DD → 按页面语言交给 Intl（en "Tuesday, Oct 20"，zh「10月20日星期二」） @param {string} day @param {string} lang */
function fmtDay(day, lang){
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  if (!m) return '';
  var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return intlDate(d, lang, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * 抽到的句子的日期行：记下它的那天（北京时间）→ 字符串表 keptOn「Kept {d}」/「拾于 {d}」，日期按语言交给 Intl；没有时间 → fromTrove。
 * @param {number} ts @param {string} lang @param {(k:string, v?:object)=>string} tr
 */
function fmtKept(ts, lang, tr){
  if (!ts) return tr('fromTrove');
  var d = new Date(ts + 8 * 3600 * 1000);
  return tr('keptOn', { d: intlDate(d, lang, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) });
}

/** 'YYYY-MM-DD' 加 n 天（UTC 算） @param {string} day @param {number} n */
function addDay(day, n){
  var t = Date.parse(day + 'T00:00:00Z');
  if (isNaN(t)) return '';
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}
/** 余响的日期行（设计稿「2026 · 11 · 08 · 星期日」）：年 · 月 · 日 · 星期（星期按页面语言交给 Intl） @param {string} day @param {string} lang */
function dayDots(day, lang){
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  if (!m) return '';
  var wd = intlDate(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])), lang, { weekday: 'long', timeZone: 'UTC' });
  return [m[1], m[2], m[3], wd].join(' · ');
}
/**
 * 日期条：以 center 为中心的 n 格（默认 13）→ [{day, dd, today, future}]
 * @param {string} center @param {string} today @param {number} [n]
 */
function stripDays(center, today, n){
  n = n || 13;
  var half = Math.floor(n / 2), out = [];
  for (var i = -half; i < n - half; i++) {
    var d = addDay(center, i);
    if (d) out.push({ day: d, dd: d.slice(8, 10), today: d === today, future: !!today && d > today });
  }
  return out;
}
/** 前后日卡上的那句开头：最多 n 个字，长了加「……」 @param {string} text @param {number} [n] */
function snippet(text, n){
  var a = Array.from(String(text || '').replace(/\s+/g, ' ').trim());
  n = n || 14;
  return a.length > n ? a.slice(0, n).join('') + '……' : a.join('');
}

/** 复制 / 分享用的纯文本 @param {any} q @param {string} [titleTpl] 出处书名格式（同 attribution） */
function shareText(q, titleTpl){
  if (!q) return '';
  var a = attribution(q, titleTpl);
  return [q.text, q.trans, a ? '—— ' + a : ''].filter(Boolean).join('\n');
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

var pure = {
  readDict: readDict, makeTr: makeTr,
  TABS: TABS, SOURCE_TYPES: SOURCE_TYPES, parseHash: parseHash, routeHash: routeHash, parseTagInput: parseTagInput, addTags: addTags,
  allTags: allTags, authorGroups: authorGroups, recentAuthors: recentAuthors, knownSources: knownSources, suggest: suggest,
  pickRandom: pickRandom, canSetToday: canSetToday, isLockedReply: isLockedReply, moveItem: moveItem, groupQuotes: groupQuotes, attribution: attribution, fmtDay: fmtDay, fmtKept: fmtKept,
  shareText: shareText, addDay: addDay, dayDots: dayDots, stripDays: stripDays, snippet: snippet
};
if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }
G.SgxDaymark = pure;

/* ================= 页面 ================= */
var doc = G.document;
/* 界面文案（语言包化第二部分 2026-11-07）：页面里的 #sgx-i18n-daymark，模板从字符串表 data/daymark/i18n/<语言>.yaml 的 js.daymark 输出，
   已经是「英文表 ← 页面语言表」的合并（缺键回退英文）；本文件不再认识任何语言。带数字的文案走 tr（复数按 Intl.PluralRules）。 */
var lang = doc.documentElement.lang || 'en';
var T = readDict(doc, 'daymark');
var tr = makeTr(T, lang);
function sub(p){ var o = {}; for (var k in T) if (k.indexOf(p) === 0) o[k.slice(p.length)] = T[k]; return o; }
T.count = function(n){ return tr('count', { n: n }); };

var $ = function(s){ return doc.querySelector(s); };
var quotes = [];
var collections = [];
var canWrite = false;    /* 接口回的 canWrite：账号已登录 + daymark.write */
var showPrivate = false; /* 接口回的 showPrivate：账号已登录（私密句子、随手一笔） */
var loaded = false;
var today = { day: '', quote: null };
var echoQuote = null;
var drawn = false;
var view = '';           /* 余响正在看的那天（'' = 今天）；#d/<日期> */
var picks = {};          /* 往前几天记下的句子：日期 → 句子（null = 那天没记下 / 已删 / 私密）；/api/days */
var loadingDays = {};
var tab = 'echo';
var group = null;
var groupEditing = false;
var scrolls = { echo: 0, trove: 0, flavors: 0 };
var toastTimer = null;

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}
function reduced(){
  return doc.documentElement.classList.contains('reduced-motion') || !!(G.matchMedia && G.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
/** 请人进站：顶栏终端预填 su （topbar/topbar-panel.js 接 sgx:sudo，= common/js/auth/sudo.js SUDO_EVENT） */
function askSudo(){ try { doc.dispatchEvent(new CustomEvent('sgx:sudo')); } catch (e) {} }
function getJSON(url){
  return fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then(function(r){
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}
function send(method, url, body){
  return fetch(url, {
    method: method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(function(r){
    return r.json().catch(function(){ return {}; }).then(function(j){
      if (isLockedReply(r.status)) { askSudo(); throw Object.assign(new Error('locked'), { sgxLocked: true }); }
      if (!r.ok || !j.ok) throw Object.assign(new Error(j.error || ('HTTP ' + r.status)), { code: j.error });
      return j;
    });
  });
}
/** 写失败的提示：403 forbidden = v6 身份档不够（不在 daymark-write，或删整个专题不是 root）→ 无权限句，其余通用 */
function failText(e){ var c = e && e.code; return c === 'forbidden' && T.noPermission ? T.noPermission : T.failed; }
/**
 * 不能编辑时那一条（2c 起是 su 入口，data-sec-open）：没登录 → su；已以 v6 用户登录但不在写组 → 无权限句，仍是 su。
 */
function signinHint(){
  /* 2d：已经以 v6 用户登录（登录标记 sgx-id=1，同 identity/api.js hasMarker）、只是不在写组 → 命令仍是 su（缺组时提示 su），
     文字换成站内已上线的无权限句 noPermission「当前用户没有这个权限。」，不再说「su 登录后可编辑」 */
  if (v6SignedIn() && T.noPermission) return T.noPermission;
  /* 2c（v6 割接）：没登录 → 「su 登录后可编辑」（入口 su / data-sec-open / #sec 在模板里） */
  return T.signin;
}
/** 有没有 v6 登录标记（服务端随 sgx-session 写的 sgx-id=1；不含秘密） */
function v6SignedIn(){
  try { return /(?:^|;\s*)sgx-id=1(?:;|$)/.test(doc.cookie || ''); } catch (e) { return false; }
}
function toast(msg){
  var el = $('#bk-toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ el.classList.add('hidden'); }, 2200);
}
function haptic(){ try { if (G.navigator && typeof navigator.vibrate === 'function') navigator.vibrate(12); } catch (e) {} }
function copyText(s){
  function fallback(){
    var ta = doc.createElement('textarea');
    ta.value = s; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    doc.body.appendChild(ta); ta.select();
    var ok = false; try { ok = doc.execCommand('copy'); } catch (e) {}
    ta.remove();
    return ok ? Promise.resolve() : Promise.reject(new Error('copy'));
  }
  if (G.navigator && navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(s).catch(fallback);
  return fallback();
}
function copyQuote(q){ if (q) copyText(shareText(q, T.sourceTitle)).then(function(){ haptic(); toast(T.copied); }, function(){ toast(T.failed); }); }

/** 长按（≈550ms，手指不挪）触发 fn；触发后吞掉随后的那次点击 */
function onLongPress(el, fn){
  var timer = 0, x0 = 0, y0 = 0, fired = false;
  el.addEventListener('pointerdown', function(e){
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    fired = false; x0 = e.clientX; y0 = e.clientY;
    clearTimeout(timer);
    var target = e.target;
    timer = setTimeout(function(){ fired = true; fn(target); }, 550);
  });
  el.addEventListener('pointermove', function(e){ if (Math.abs(e.clientX - x0) > 10 || Math.abs(e.clientY - y0) > 10) clearTimeout(timer); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function(t){ el.addEventListener(t, function(){ clearTimeout(timer); }); });
  el.addEventListener('contextmenu', function(e){ e.preventDefault(); });
  el.addEventListener('click', function(e){ if (fired) { fired = false; e.preventDefault(); e.stopImmediatePropagation(); } }, true);
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

/* ---------- 句子的几种画法 ---------- */
var LOCK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
function bodyHTML(q){
  var a = attribution(q, T.sourceTitle);
  return '<p class="dm-text">' + esc(q.text) + '</p>'
    + (q.trans ? '<p class="dm-trans">' + esc(q.trans) + '</p>' : '')
    + (a ? '<p class="dm-attr">' + esc(a) + '</p>' : '');
}
function cardHTML(q, ctl){
  return '<article class="dm-card" data-id="' + esc(q.id) + '"' + (canWrite && !ctl ? ' tabindex="0" role="button"' : '') + '>'
    + (showPrivate && q.visibility === 'private' ? '<span class="dm-lock" role="img" aria-label="' + esc(T.priv) + '" title="' + esc(T.priv) + '">' + LOCK + '</span>' : '')
    + bodyHTML(q)
    + ((q.tags || []).length ? '<div class="dm-meta">' + q.tags.map(function(t){ return '<span class="dm-tag">#' + esc(t) + '</span>'; }).join('') + '</div>' : '')
    + (ctl || '')
    + '</article>';
}
function findQuote(id){ return quotes.filter(function(x){ return x.id === id; })[0] || null; }
function bindCards(box){
  box.querySelectorAll('.dm-card').forEach(function(card){
    var q = findQuote(card.dataset.id);
    onLongPress(card, function(){ copyQuote(findQuote(card.dataset.id)); });
    if (!canWrite) return;
    function act(e){
      if (e && e.target && e.target.closest && e.target.closest('[data-move],[data-remove]')) return;
      if (groupEditing && box.id === 'dm-g-list') return;
      var cur = findQuote(card.dataset.id);
      if (cur) openEdit(cur);
    }
    card.addEventListener('click', act);
    card.addEventListener('keydown', function(e){ if (e.key === 'Enter' && e.target === card) act(e); });
    void q;
  });
}

/* ---------- 余响 ---------- */
function shownDay(){ return view || today.day || ''; }
function renderEcho(){
  var q = echoQuote, d = shownDay(), past = !!(view && view !== today.day);
  $('#dm-cmd-day').textContent = drawn ? 'trove | shuf -n1' : (d || 'today');
  $('#dm-echo-day').textContent = drawn ? fmtKept(q && q.created_at, lang, tr) : dayDots(d, lang);
  var none = past ? (view > today.day ? T.notYet : (view in picks ? T.noDay : '')) : (loaded || today.day ? T.noToday : '');
  $('#dm-echo-body').innerHTML = q ? bodyHTML(q) : '<p class="dm-trans">' + esc(none) + '</p>';
  $('#dm-back-today').classList.toggle('hidden', !(drawn || past));
  $('#dm-set-today').classList.toggle('hidden', !canSetToday(canWrite, drawn, q, today.quote));
  renderStrip(); renderNx(); renderWindows();
}
/** 某天的句子：今天 = /api/today 那句；往前 = /api/days 记下的（undefined = 还没问到） */
function quoteOn(day){ return day === today.day ? today.quote : picks[day]; }
function renderStrip(){
  var box = $('#dm-dcal');
  if (!today.day) { box.innerHTML = ''; return; }
  var cur = drawn ? today.day : shownDay();
  box.innerHTML = stripDays(cur, today.day).map(function(c){
    var off = c.future || (!c.today && picks[c.day] === null);
    return '<button type="button" class="dm-dc' + (c.day === cur ? ' on' : '') + (c.today ? ' is-today' : '') + '" data-day="' + c.day + '" aria-label="' + esc(c.day) + '"'
      + (c.day === cur ? ' aria-current="date"' : '') + (off ? ' disabled' : '') + '>' + c.dd + '</button>';
  }).join('');
}
function renderNx(){
  var box = $('#dm-nx');
  if (!today.day) { box.innerHTML = ''; return; }
  var cur = drawn ? today.day : shownDay();
  var p = addDay(cur, -1), n = addDay(cur, 1);
  var pq = quoteOn(p), nq = quoteOn(n);
  var title = function(q, d){ return q ? snippet(q.text) : q === null ? T.noDay : d; };
  box.innerHTML = '<li><a class="sgx-nx-a" href="#d/' + p + '" data-day="' + p + '">‹ cat ' + p + '<b>' + esc(title(pq, p)) + '</b></a></li>'
    + (n > today.day
      ? '<li><span class="sgx-nx-a is-next is-off" aria-disabled="true">cat ' + n + ' ›<b>' + esc(T.tomorrow) + '</b></span></li>'
      : '<li><a class="sgx-nx-a is-next" href="' + (n === today.day ? '#' : '#d/' + n) + '" data-day="' + n + '">cat ' + n + ' ›<b>' + esc(title(nq, n)) + '</b></a></li>');
}
function li(href, k, text, attrs){ return '<a class="dm-li" href="' + href + '"' + (attrs || '') + '><i>' + esc(k) + '</i><span>' + esc(text) + '</span></a>'; }
function renderWindows(){
  /* 余响：今天 + 往前记下的（新→旧）前三条 */
  var days = Object.keys(picks).filter(function(d){ return picks[d]; }).sort().reverse();
  var rows = [];
  if (today.quote) rows.push(li('#', today.day.slice(5), today.quote.text));
  days.forEach(function(d){ if (rows.length < 3) rows.push(li('#d/' + d, d.slice(5), picks[d].text)); });
  $('#dm-w-echo').innerHTML = rows.join('') || '<p class="dm-li-none">' + esc(loaded ? T.noToday : '…') + '</p>';
  $('#dm-n-echo').textContent = String(days.length + (today.quote ? 1 : 0));
  /* 拾录：最新三句（出处类型当左边小字） */
  $('#dm-w-trove').innerHTML = quotes.slice(0, 3).map(function(q){ return li('#trove', ST_LABEL[q.source_type] || '·', q.text); }).join('') || '<p class="dm-li-none">' + esc(loaded ? T.emptyVisitor : '…') + '</p>';
  $('#dm-n-trove').textContent = loaded ? String(quotes.length) : '';
  /* 百味：专题在前、再是人物（左边小字 = 句数） */
  var groups = collections.map(function(c){ return { h: '#flavors/c/' + encodeURIComponent(c.id), n: groupQuotes(quotes, collections, { kind: 'c', key: c.id }).length, name: c.name }; })
    .concat(authorGroups(quotes).map(function(a){ return { h: '#flavors/a/' + encodeURIComponent(a.name), n: a.count, name: a.name }; }));
  $('#dm-w-flavors').innerHTML = groups.slice(0, 3).map(function(g){ return li(g.h, String(g.n), g.name); }).join('') || '<p class="dm-li-none">' + esc(loaded ? T.emptyVisitor : '…') + '</p>';
  $('#dm-n-flavors').textContent = loaded ? String(groups.length) : '';
}
/** 问 /api/days 补齐以 center 为中心那 13 天（只问今天以前、还没问过的） */
function ensureDays(center){
  if (!today.day) return;
  /* 测试构建（<html data-sgx-test-no-api>，CI 静态服务器没有接口）不问，免得 404 进控制台；e2e 要测时先设 window.__sgxDaymarkApi = true */
  if (G.document.documentElement.hasAttribute('data-sgx-test-no-api') && !G.__sgxDaymarkApi) return;
  var from = addDay(center, -6), to = addDay(center, 6);
  if (to >= today.day) to = addDay(today.day, -1);
  if (!from || from > to) return;
  var need = false;
  for (var d = from; d && d <= to; d = addDay(d, 1)) if (!(d in picks)) { need = true; break; }
  var key = from + '_' + to;
  if (!need || loadingDays[key]) return;
  loadingDays[key] = true;
  getJSON('/daymark/api/days?from=' + from + '&to=' + to).then(function(j){
    for (var x = from; x && x <= to; x = addDay(x, 1)) if (!(x in picks)) picks[x] = null;
    (j.days || []).forEach(function(r){ if (r && r.day) picks[r.day] = r.quote || null; });
    if (view && view !== today.day) echoQuote = quoteOn(view) || null;
    renderEcho();
  }, function(){ loadingDays[key] = false; });
}
/** 看某一天（'' 或今天 = 回到今天这句） */
function showDay(day){
  view = day && day !== today.day ? day : '';
  drawn = false;
  echoQuote = view ? (quoteOn(view) || null) : today.quote;
  renderEcho();
  ensureDays(view || today.day);
}
$('#dm-draw').addEventListener('click', function(){
  var q = pickRandom(quotes, echoQuote && echoQuote.id);
  if (!q) { toast(T.nothingToDraw); return; }
  echoQuote = q; drawn = true; view = '';
  if (tab === 'echo') writeHash();
  renderEcho();
});
$('#dm-back-today').addEventListener('click', function(){ go({ tab: 'echo' }); showDay(''); });
var settingToday = false;
$('#dm-set-today').addEventListener('click', function(){
  var q = echoQuote;
  if (settingToday || !canSetToday(canWrite, drawn, q, today.quote)) return;
  settingToday = true;
  send('PUT', '/daymark/api/today', { id: q.id }).then(function(j){
    today = { day: j.day, quote: j.quote };
    if (echoQuote === q) { echoQuote = j.quote; drawn = false; view = ''; }
    renderEcho(); haptic(); toast(T.setToday);
  }).catch(function(e){ if (!e.sgxLocked) toast(failText(e)); }).then(function(){ settingToday = false; });
});
$('#dm-dcal').addEventListener('click', function(e){
  var b = e.target.closest && e.target.closest('[data-day]');
  if (!b || b.disabled) return;
  go({ tab: 'echo', day: b.dataset.day === today.day ? '' : b.dataset.day });
});
onLongPress($('#dm-echo'), function(){ copyQuote(echoQuote); });

/* ---------- 拾录 ---------- */
function renderTrove(){
  $('#dm-loading').classList.toggle('hidden', loaded);
  var box = $('#dm-list');
  box.innerHTML = quotes.map(function(q){ return cardHTML(q); }).join('');
  bindCards(box);
  $('#dm-empty').textContent = canWrite ? T.emptyAdmin : T.emptyVisitor;
  $('#dm-empty').classList.toggle('hidden', !loaded || quotes.length > 0);
}

/* ---------- 百味 ---------- */
function renderFlavors(){
  var showCols = canWrite || collections.length > 0;
  $('#dm-cols-sec').classList.toggle('hidden', !showCols);
  $('#dm-cols').innerHTML = collections.map(function(c){
    var n = groupQuotes(quotes, collections, { kind: 'c', key: c.id }).length;
    return '<button type="button" class="dm-fcard" data-group="c" data-key="' + esc(c.id) + '">'
      + '<span class="dm-fcard-name">' + esc(c.name) + '</span>'
      + (c.intro ? '<span class="dm-fcard-intro">' + esc(c.intro) + '</span>' : '')
      + '<span class="dm-fcard-count">' + esc(T.count(n)) + '</span></button>';
  }).join('') + (canWrite ? '<button type="button" class="dm-fcard dm-fcard-new" id="dm-col-new"><span class="dm-fcard-plus" aria-hidden="true">' + T.plus + '</span><span class="dm-fcard-name">' + esc(T.newCol) + '</span></button>' : '');
  var authors = authorGroups(quotes);
  $('#dm-authors-sec').classList.toggle('hidden', !authors.length);
  $('#dm-authors').innerHTML = authors.map(function(a){
    return '<button type="button" class="dm-fcard dm-fcard-person" data-group="a" data-key="' + esc(a.name) + '">'
      + '<span class="dm-fcard-name">' + esc(a.name) + '</span><span class="dm-fcard-count">' + esc(T.count(a.count)) + '</span></button>';
  }).join('');
  $('#dm-fl-empty').classList.toggle('hidden', !loaded || showCols || authors.length > 0);
  $('#dm-fl-empty').textContent = T.emptyVisitor;
  doc.querySelectorAll('#dm-fl-home [data-group]').forEach(function(b){
    b.addEventListener('click', function(){ go({ tab: 'flavors', group: { kind: b.dataset.group, key: b.dataset.key } }); });
  });
  var nb = $('#dm-col-new');
  if (nb) nb.addEventListener('click', function(){ openNewCollection(); });
  renderGroup();
}
function currentCollection(){
  return group && group.kind === 'c' ? collections.filter(function(c){ return c.id === group.key; })[0] || null : null;
}
function renderGroup(){
  var inGroup = !!group;
  $('#dm-fl-home').classList.toggle('hidden', inGroup);
  $('#dm-fl-group').classList.toggle('hidden', !inGroup);
  if (!inGroup) return;
  var col = currentCollection();
  var list = groupQuotes(quotes, collections, group);
  var title = group.kind === 'c' ? (col ? col.name : '') : group.key;
  $('#dm-g-title').textContent = title;
  $('#dm-g-intro').textContent = col && col.intro ? col.intro : '';
  $('#dm-g-intro').classList.toggle('hidden', !(col && col.intro));
  $('#dm-g-count').textContent = T.count(list.length);
  var canEdit = canWrite && !!col;
  if (!canEdit) groupEditing = false;
  $('#dm-g-tools').classList.toggle('hidden', !canEdit);
  $('#dm-g-edit').textContent = groupEditing ? T.done : T.edit2;
  $('#dm-g-edit').setAttribute('aria-pressed', groupEditing ? 'true' : 'false');
  $('#dm-g-del').classList.toggle('hidden', !groupEditing);
  var box = $('#dm-g-list');
  box.classList.toggle('is-editing', groupEditing);
  box.innerHTML = list.map(function(q, i){
    var ctl = groupEditing ? '<div class="dm-reorder">'
      + '<button type="button" class="dm-rbtn" data-move="-1" data-i="' + i + '" aria-label="' + esc(T.up) + '"' + (i === 0 ? ' disabled' : '') + '><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 14l6-6 6 6"/></svg></button>'
      + '<button type="button" class="dm-rbtn" data-move="1" data-i="' + i + '" aria-label="' + esc(T.down) + '"' + (i === list.length - 1 ? ' disabled' : '') + '><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 10l6 6 6-6"/></svg></button>'
      + '<button type="button" class="dm-rbtn dm-rbtn-x" data-remove="' + i + '" aria-label="' + esc(T.remove) + '"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'
      + '</div>' : '';
    return cardHTML(q, ctl);
  }).join('');
  $('#dm-g-empty').classList.toggle('hidden', list.length > 0);
  $('#dm-g-empty').textContent = T.groupEmpty;
  bindCards(box);
  box.querySelectorAll('[data-move]').forEach(function(b){
    b.addEventListener('click', function(e){ e.stopPropagation(); reorder(moveItem(list.map(function(q){ return q.id; }), +b.dataset.i, +b.dataset.move)); });
  });
  box.querySelectorAll('[data-remove]').forEach(function(b){
    b.addEventListener('click', function(e){
      e.stopPropagation();
      var ids = list.map(function(q){ return q.id; });
      ids.splice(+b.dataset.remove, 1);
      reorder(ids, T.removed);
    });
  });
}
function reorder(ids, msg){
  var col = currentCollection(); if (!col) return;
  var before = col.quote_ids.slice();
  /* 账号未登录看不到的私密句子也在专题里：showPrivate 时 quote_ids 就是全部，直接用 */
  col.quote_ids = ids;
  syncQuoteCollections();
  renderGroup();
  send('PUT', '/daymark/api/collections?id=' + encodeURIComponent(col.id), { quote_ids: ids }).then(function(j){
    col.quote_ids = j.collection.quote_ids; syncQuoteCollections();
    if (msg) toast(msg);
  }).catch(function(e){
    if (e.sgxLocked) return;
    col.quote_ids = before; syncQuoteCollections(); renderGroup(); toast(failText(e));
  });
}
/** 专题的 quote_ids 改了之后，句子上的 collections 跟着改（编辑器里的「归入百味」读它） */
function syncQuoteCollections(){
  quotes.forEach(function(q){
    q.collections = collections.filter(function(c){ return c.quote_ids.indexOf(q.id) >= 0; }).map(function(c){ return c.id; });
  });
}
$('#dm-fl-back').addEventListener('click', function(){ go({ tab: 'flavors' }); });
$('#dm-g-edit').addEventListener('click', function(){ groupEditing = !groupEditing; renderGroup(); });
$('#dm-g-del').addEventListener('click', function(){
  var col = currentCollection(); if (!col) return;
  ask(T.delCol, T.del, function(){
    send('DELETE', '/daymark/api/collections?id=' + encodeURIComponent(col.id)).then(function(){
      collections = collections.filter(function(c){ return c.id !== col.id; });
      syncQuoteCollections(); groupEditing = false;
      go({ tab: 'flavors' }); toast(T.deleted);
    }).catch(function(e){ if (!e.sgxLocked) toast(failText(e)); });
  });
});

/* 新建专题（百味里的「＋ 新建」卡）：名字 + 一句话简介 */
function openNewCollection(){
  $('#c-name').value = ''; $('#c-intro').value = '';
  $('#col-err').classList.add('hidden');
  openOverlay('col-wrap');
  setTimeout(function(){ $('#c-name').focus(); }, 60);
}
function createCollection(name, intro){
  return send('POST', '/daymark/api/collections', { name: name, intro: intro || '' }).then(function(j){
    collections.push(j.collection);
    return j.collection;
  });
}
$('#col-save').addEventListener('click', function(){
  var name = $('#c-name').value.trim();
  if (!name) { $('#col-err').textContent = T.needName; $('#col-err').classList.remove('hidden'); $('#c-name').focus(); return; }
  createCollection(name, $('#c-intro').value.trim()).then(function(c){
    closeOverlay('col-wrap'); renderFlavors(); haptic(); toast(T.colCreated);
    go({ tab: 'flavors', group: { kind: 'c', key: c.id } });
  }).catch(function(e){ if (!e.sgxLocked) { $('#col-err').textContent = failText(e); $('#col-err').classList.remove('hidden'); } });
});

/* ---------- 页签 ---------- */
/* 页名胶囊 + 首页分区入口（P4-3 PR-4b：顶栏不再有分区页签）：切到第 i 个分区时胶囊显示 data-sgx-titles[i]（第 0 个 = 站名），
   分区入口（[data-sgx-entries]，首页正文的目录）只在第 0 个分区（余响 = 首页本身）显示 */
function syncTitle(i){
  var t = doc.querySelector('.sgx-tb-title[data-sgx-titles]');
  if (t) { try { var names = JSON.parse(t.getAttribute('data-sgx-titles')); if (names[i]) t.textContent = names[i]; } catch (e) {} }
  var ents = doc.querySelector('[data-sgx-entries]');
  if (ents) ents.hidden = i !== 0;
}
function writeHash(){
  var h = routeHash({ tab: tab, group: tab === 'flavors' ? group : null, day: tab === 'echo' && !drawn ? view : '' });
  var url = G.location.pathname + G.location.search + h;
  if (url !== G.location.pathname + G.location.search + G.location.hash) { try { history.replaceState(history.state, '', url); } catch (e) {} }
}
function setTab(next, opts){
  opts = opts || {};
  var i = TABS.indexOf(next); if (i < 0) return;
  if (!opts.initial) scrolls[tab] = G.scrollY;
  var changed = next !== tab;
  tab = next;
  TABS.forEach(function(id){
    var p = doc.getElementById('dm-pane-' + id);
    if (id === next) { p.hidden = false; p.removeAttribute('inert'); } else { p.hidden = true; p.setAttribute('inert', ''); }
  });
  syncTitle(i);
  doc.documentElement.setAttribute('data-dm-active', next);
  $('#dm-fab').classList.toggle('hidden', !(canWrite && next === 'trove'));
  writeHash();
  if (changed && !opts.initial) G.scrollTo({ top: scrolls[next] || 0, behavior: 'auto' });
}
function go(r, opts){
  opts = opts || {};
  if (r.tab === 'echo' && (r.day || '') !== view && !opts.initial) { setTab('echo', opts); showDay(r.day || ''); writeHash(); return; }
  if (r.tab === 'echo' && opts.initial) view = r.day || '';
  var g = r.tab === 'flavors' ? (r.group || null) : group;
  var groupChanged = r.tab === 'flavors' && JSON.stringify(g) !== JSON.stringify(group);
  if (r.tab === 'flavors') { group = g; if (groupChanged) groupEditing = false; renderGroup(); }
  setTab(r.tab, opts);
  if (groupChanged && !opts.initial) G.scrollTo({ top: 0, behavior: 'auto' });
}
G.addEventListener('hashchange', function(){ var r = parseHash(G.location.hash); if (r) go(r); });
/* 左右滑切页签（竖着滑照常滚动；在弹层、按钮行里不算） */
(function(){
  var panes = $('#dm-panes'), x0 = 0, y0 = 0, t0 = 0, on = false;
  panes.addEventListener('touchstart', function(e){
    if (e.touches.length !== 1) { on = false; return; }
    on = true; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  panes.addEventListener('touchend', function(e){
    if (!on) return; on = false;
    var t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.6 || Date.now() - t0 > 700) return;
    var i = TABS.indexOf(tab) + (dx < 0 ? 1 : -1);
    if (i >= 0 && i < TABS.length) setTab(TABS[i]);
  }, { passive: true });
})();

/* ---------- 记一句 / 编辑 ---------- */
var editing = null;
var ed = { tags: [], cols: [], stype: '' };
/* 出处类型名：字符串表 js.daymark.st_<类型> */
var ST_LABEL = sub('st_');

function edQuote(){
  return { text: $('#f-text').value.trim(), trans: $('#f-trans').value.trim(), author: $('#f-author').value.trim(), source: $('#f-source').value.trim(), source_type: ed.stype };
}
function renderPreview(){
  var q = edQuote();
  $('#ed-preview-body').innerHTML = q.text ? bodyHTML(q) : '<p class="dm-preview-ph">' + esc(T.previewPh) + '</p>';
}
function renderStype(){
  $('#f-stype').innerHTML = SOURCE_TYPES.map(function(t){
    return '<button type="button" class="dm-chip" data-st="' + t + '" aria-pressed="' + (ed.stype === t) + '">' + esc(ST_LABEL[t]) + '</button>';
  }).join('');
  $('#f-stype').querySelectorAll('[data-st]').forEach(function(b){
    b.addEventListener('click', function(){ ed.stype = ed.stype === b.dataset.st ? '' : b.dataset.st; renderStype(); renderPreview(); });
  });
}
function renderRecent(){
  var list = recentAuthors(quotes, 6);
  var box = $('#f-author-recent');
  box.classList.toggle('hidden', !list.length);
  box.innerHTML = list.map(function(a){ return '<button type="button" class="dm-chip dm-chip-sm" data-author="' + esc(a) + '">' + esc(a) + '</button>'; }).join('');
  box.querySelectorAll('[data-author]').forEach(function(b){
    b.addEventListener('click', function(){ $('#f-author').value = b.dataset.author; hideAc('#f-author-ac'); renderPreview(); });
  });
}
function renderCols(){
  var box = $('#f-cols');
  box.innerHTML = collections.map(function(c){
    return '<button type="button" class="dm-chip" data-col="' + esc(c.id) + '" aria-pressed="' + (ed.cols.indexOf(c.id) >= 0) + '">' + esc(c.name) + '</button>';
  }).join('') + '<button type="button" class="dm-chip dm-chip-new" id="f-col-new">' + T.plus + ' ' + esc(T.newCol) + '</button>';
  box.querySelectorAll('[data-col]').forEach(function(b){
    b.addEventListener('click', function(){
      var id = b.dataset.col, i = ed.cols.indexOf(id);
      if (i >= 0) ed.cols.splice(i, 1); else ed.cols.push(id);
      renderCols();
    });
  });
  $('#f-col-new').addEventListener('click', function(){
    $('#f-col-new-row').classList.remove('hidden');
    $('#f-col-name').value = '';
    $('#f-col-name').focus();
  });
}
function addInlineCol(){
  var name = $('#f-col-name').value.trim();
  if (!name) { $('#f-col-name').focus(); return; }
  createCollection(name, '').then(function(c){
    ed.cols.push(c.id);
    $('#f-col-new-row').classList.add('hidden');
    renderCols(); renderFlavors(); haptic();
  }).catch(function(e){ if (!e.sgxLocked) toast(failText(e)); });
}
$('#f-col-add').addEventListener('click', addInlineCol);
$('#f-col-name').addEventListener('keydown', function(e){ if (e.key === 'Enter') { e.preventDefault(); addInlineCol(); } });

function renderTags(){
  var box = $('#f-tagchips');
  box.innerHTML = ed.tags.map(function(t, i){
    return '<span class="dm-tagchip">#' + esc(t) + '<button type="button" data-untag="' + i + '" aria-label="' + esc(tr('untag', { t: t })) + '">×</button></span>';
  }).join('');
  box.querySelectorAll('[data-untag]').forEach(function(b){
    b.addEventListener('click', function(){ ed.tags.splice(+b.dataset.untag, 1); renderTags(); $('#f-tag-input').focus(); });
  });
  var q = $('#f-tag-input').value.replace(/^#+/, '').trim().toLowerCase();
  var sugg = allTags(quotes).filter(function(t){ return ed.tags.indexOf(t) < 0 && (!q || t.toLowerCase().indexOf(q) >= 0); }).slice(0, 8);
  var sb = $('#f-tag-sugg');
  sb.classList.toggle('hidden', !sugg.length || ed.tags.length >= MAX_TAGS);
  sb.innerHTML = sugg.map(function(t){ return '<button type="button" class="dm-chip dm-chip-sm" data-addtag="' + esc(t) + '">#' + esc(t) + '</button>'; }).join('');
  sb.querySelectorAll('[data-addtag]').forEach(function(b){
    b.addEventListener('click', function(){ ed.tags = addTags(ed.tags, b.dataset.addtag); $('#f-tag-input').value = ''; renderTags(); });
  });
  $('#f-tag-input').classList.toggle('hidden', ed.tags.length >= MAX_TAGS);
}
function commitTagInput(){
  var inp = $('#f-tag-input');
  if (!inp.value.trim()) return false;
  ed.tags = addTags(ed.tags, inp.value);
  inp.value = '';
  renderTags();
  return true;
}
$('#f-tag-input').addEventListener('keydown', function(e){
  if (e.key === 'Enter' || e.key === ',' || e.key === '，') { e.preventDefault(); commitTagInput(); }
  else if (e.key === 'Backspace' && !e.target.value && ed.tags.length) { ed.tags.pop(); renderTags(); }
});
$('#f-tag-input').addEventListener('input', function(e){
  /* 手机输入法常常不发 keydown：输入里出现逗号 / 顿号就成块 */
  if (/[,，、]/.test(e.target.value)) commitTagInput(); else renderTags();
});
$('#f-tag-input').addEventListener('blur', function(){ commitTagInput(); });
$('#f-tagbox').addEventListener('click', function(e){ if (e.target === e.currentTarget || e.target.id === 'f-tagchips') $('#f-tag-input').focus(); });

/* 自动补全下拉（作者 / 出处） */
function hideAc(sel){ var el = $(sel); el.classList.add('hidden'); el.innerHTML = ''; }
function bindAc(inputSel, listSel, source){
  var inp = $(inputSel), box = $(listSel);
  function show(){
    var items = suggest(source(), inp.value, 5);
    box.classList.toggle('hidden', !items.length);
    box.innerHTML = items.map(function(s){ return '<button type="button" role="option" class="dm-ac-item">' + esc(s) + '</button>'; }).join('');
    box.querySelectorAll('.dm-ac-item').forEach(function(b){
      b.addEventListener('pointerdown', function(e){ e.preventDefault(); });
      b.addEventListener('click', function(){ inp.value = b.textContent; hideAc(listSel); renderPreview(); });
    });
  }
  inp.addEventListener('input', function(){ show(); renderPreview(); });
  inp.addEventListener('focus', show);
  inp.addEventListener('blur', function(){ setTimeout(function(){ hideAc(listSel); }, 150); });
  inp.addEventListener('keydown', function(e){ if (e.key === 'Escape' && !box.classList.contains('hidden')) { e.stopPropagation(); hideAc(listSel); } });
}
bindAc('#f-author', '#f-author-ac', function(){ return authorGroups(quotes).map(function(a){ return a.name; }); });
bindAc('#f-source', '#f-source-ac', function(){ return knownSources(quotes, ed.stype); });
$('#f-text').addEventListener('input', renderPreview);
$('#f-trans').addEventListener('input', renderPreview);
function showTrans(on){
  $('#f-trans-wrap').classList.toggle('hidden', !on);
  $('#f-trans-toggle').classList.toggle('hidden', on);
}
$('#f-trans-toggle').addEventListener('click', function(){ showTrans(true); $('#f-trans').focus(); });

function openEdit(q){
  editing = q || null;
  $('#edit-title').textContent = q ? T.edit : T.add;
  $('#f-text').value = q ? q.text : '';
  $('#f-trans').value = q ? q.trans : '';
  showTrans(!!(q && q.trans));
  $('#f-author').value = q ? q.author : '';
  $('#f-source').value = q ? q.source : '';
  $('#f-note').value = q ? (q.note || '') : '';
  $('#f-public').checked = q ? q.visibility !== 'private' : true;
  $('#f-tag-input').value = '';
  $('#f-col-new-row').classList.add('hidden');
  ed = { tags: q ? (q.tags || []).slice() : [], cols: q ? (q.collections || []).slice() : (group && group.kind === 'c' && tab === 'flavors' ? [group.key] : []), stype: q ? (q.source_type || '') : '' };
  hideAc('#f-author-ac'); hideAc('#f-source-ac');
  renderStype(); renderRecent(); renderCols(); renderTags(); renderPreview();
  $('#edit-del').classList.toggle('hidden', !q);
  $('#edit-err').classList.add('hidden');
  $('#edit-form').scrollTop = 0;
  openOverlay('edit-wrap');
  setTimeout(function(){ if (!q) $('#f-text').focus(); }, 60);
}
function formBody(){
  commitTagInput();
  return {
    text: $('#f-text').value, trans: $('#f-trans').value, author: $('#f-author').value, source: $('#f-source').value,
    source_type: ed.stype, tags: ed.tags.slice(), visibility: $('#f-public').checked ? 'public' : 'private',
    note: $('#f-note').value, collections: ed.cols.filter(function(id){ return collections.some(function(c){ return c.id === id; }); }),
  };
}
function reloadCollections(){
  return getJSON('/daymark/api/collections').then(function(j){ collections = j.collections || []; syncQuoteCollections(); renderFlavors(); }, function(){});
}
var saving = false;
$('#edit-save').addEventListener('click', function(){
  if (saving) return;
  var body = formBody();
  if (!body.text.trim()) { $('#edit-err').textContent = T.needText; $('#edit-err').classList.remove('hidden'); $('#f-text').focus(); return; }
  saving = true;
  var was = editing;
  var p = was ? send('PUT', '/daymark/api/quotes?id=' + encodeURIComponent(was.id), body) : send('POST', '/daymark/api/quotes', body);
  p.then(function(j){
    if (was) quotes = quotes.map(function(x){ return x.id === j.quote.id ? j.quote : x; });
    else quotes.unshift(j.quote);
    if (echoQuote && echoQuote.id === j.quote.id) echoQuote = j.quote;
    closeOverlay('edit-wrap');
    renderAll(); haptic(); toast(T.kept);
    reloadCollections();
    if (!was || (today.quote && today.quote.id === j.quote.id)) loadToday();
  }).catch(function(e){
    if (e.sgxLocked) return;
    $('#edit-err').textContent = failText(e); $('#edit-err').classList.remove('hidden');
  }).then(function(){ saving = false; });
});
$('#edit-del').addEventListener('click', function(){
  var q = editing; if (!q) return;
  ask(T.delQuote, T.del, function(){
    send('DELETE', '/daymark/api/quotes?id=' + encodeURIComponent(q.id)).then(function(){
      quotes = quotes.filter(function(x){ return x.id !== q.id; });
      collections.forEach(function(c){ c.quote_ids = c.quote_ids.filter(function(id){ return id !== q.id; }); });
      if (echoQuote && echoQuote.id === q.id) { echoQuote = today.quote; drawn = false; }
      closeOverlay('edit-wrap');
      renderAll(); toast(T.deleted); loadToday();
    }).catch(function(e){ if (!e.sgxLocked) toast(failText(e)); });
  });
});
$('#dm-fab').addEventListener('click', function(){ openEdit(null); });

/* ---------- 启动 ---------- */
function renderAll(){ renderEcho(); renderTrove(); renderFlavors(); }
function loadToday(){
  return getJSON('/daymark/api/today').then(function(j){
    var wasToday = !drawn && !view;
    today = { day: j.day, quote: j.quote };
    if (view === today.day) view = '';
    if (wasToday) echoQuote = j.quote;
    renderEcho();
    ensureDays(view || today.day);
  }, function(e){ if (!e.sgxLocked) renderEcho(); });
}
function boot(){
  var r = parseHash(G.location.hash) || { tab: 'echo' };
  go(r, { initial: true });
  renderEcho();
  loadToday();
  Promise.all([getJSON('/daymark/api/quotes'), getJSON('/daymark/api/collections').catch(function(e){ if (e && e.sgxLocked) throw e; return { collections: [] }; })]).then(function(res){
    canWrite = !!res[0].canWrite;
    showPrivate = !!res[0].showPrivate;
    quotes = res[0].quotes || [];
    collections = res[1].collections || [];
    if (showPrivate) syncQuoteCollections();
    loaded = true;
    doc.documentElement.classList.toggle('dm-can-write', canWrite);
    var h = canWrite ? null : signinHint();
    doc.querySelectorAll('[data-dm-signin]').forEach(function(hint){
      hint.classList.toggle('hidden', canWrite);
      if (h) { var t = hint.querySelector('[data-signin-text]'); if (t) t.textContent = h; }
    });
    renderAll();
    setTab(tab, { initial: true });
  }).catch(function(e){
    if (e && e.sgxLocked) return;
    $('#dm-loading').textContent = T.failed;
  });
}
boot();
})();
