/* assets/js/curio-movies.js —— 奇趣「电影」子页（P4-3 奇趣拆页：/curio/movies/；浏览器 IIFE；node 测试时导出纯函数）。
 *
 * 卡片：海报（2:3，没有就显示胶片图标）、片名、年份 · 导演、评分。默认顺序 = 接口的（最近看的在前）。
 * 点卡片 → 详情（原名、年份、导演、观看日期、评分、短评）；能编辑时详情左上角「编辑」。
 * 能编辑（接口回 canWrite：账号会话 + curio.write）：右下角「电影」新建；编辑弹层里删除（要确认）。无权限只读，看不到添加按钮。
 * 海报：借 curio-items.js 的裁剪 + 照片状态（window.SgxCurioPhoto.box('mv', 'movie')：2:3 取景框，长边 ≤1600、webp），保存后再传 /curio/api/photo?kind=movie。
 * 确认框、提示条、弹层开关、页底一行借 curio.js 的（window.SgxCurioUI）。
 * 数据：GET /curio/api/movies；写：POST /curio/api/movies {op: movie.add | movie.edit | movie.del}。
 */
(function(){
"use strict";
var G = typeof globalThis !== 'undefined' ? globalThis : this;

/** 卡片副标题：年份 · 导演（都没有就空） */
function movieSub(m){
  return [m && m.year ? String(m.year) : '', m && m.director].filter(Boolean).join(' · ');
}
/** 表单里的年份 → 接口要的值：空 = 0；不是 1880–2100 的整数返回 null */
function parseYear(v){
  var s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  var n = Number(s);
  return Number.isInteger(n) && n >= 1880 && n <= 2100 ? n : null;
}
var pure = { movieSub: movieSub, parseYear: parseYear };
if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

var doc = G.document;
if (!doc.getElementById('mv-list')) return;
var isEn = doc.documentElement.lang === 'en';
var UI = G.SgxCurioUI, PH = G.SgxCurioPhoto;
var $ = function(s){ return doc.querySelector(s); };
var T = isEn ? {
  add: 'Add a movie', edit: 'Edit movie', empty: 'No movies yet.', emptyAdmin: 'No movies yet. Tap "Movie" to add one.',
  needTitle: 'Give it a title.', badYear: 'Check the year.', badDate: 'Check the date.', saved: 'Saved.', deleted: 'Deleted.', failed: 'Something went wrong. Please try again.',
  photoFail: 'Saved, but the poster didn\'t upload.', del: 'Delete', delMovie: 'Delete this movie?',
  original: 'Original title', year: 'Year', director: 'Director', watched: 'Watched', rating: 'My rating', review: 'A line or two', stars: function(n){ return n + ' out of 5'; }
} : {
  add: '添加电影', edit: '编辑电影', empty: '这里还空着。', emptyAdmin: '还没有电影。点「电影」添加第一部。',
  needTitle: '填一下片名。', badYear: '年份不对，检查一下。', badDate: '日期不对，检查一下。', saved: '已保存', deleted: '已删除', failed: '出了点问题，请再试一次。',
  photoFail: '已保存，但海报没传上去。', del: '删除', delMovie: '确定删除这部电影吗？',
  original: '原名', year: '年份', director: '导演', watched: '观看日期', rating: '我的评分', review: '短评', stars: function(n){ return n + ' 星'; }
};
var FILM = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M7.5 4.5v15M16.5 4.5v15M3.5 9h4M3.5 15h4M16.5 9h4M16.5 15h4"/></svg>';
function starSvg(n){ return '<svg viewBox="0 0 24 24" width="' + n + '" height="' + n + '" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="currentColor"/></svg>'; }

var movies = [], canWrite = false, showPrivate = false, loaded = false, editing = null, rating = 0, viewing = 0;
var ver = {};
var photo = PH ? PH.box('mv', 'movie') : null;

function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function toast(m){ if (UI) UI.toast(m); }
function posterUrl(id){ return '/curio/api/photo?kind=movie&id=' + id + (ver[id] ? '&v=' + ver[id] : ''); }
function find(id){ return movies.filter(function(m){ return m.id === id; })[0] || null; }
function getJSON(url){
  var f = G.sgxLockSync ? G.sgxLockSync.apiFetch : function(u, o){ return fetch(u, o); };
  return f(url, { credentials: 'same-origin', cache: 'no-store' }).then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
}
function op(body){
  return PH.send('POST', '/curio/api/movies', body).then(function(j){ movies = j.movies || []; render(); return j; });
}
function errText(e){
  var c = e && e.code || '';
  if (c === 'bad-title') return T.needTitle;
  if (c === 'bad-year') return T.badYear;
  if (c === 'bad-watched-at') return T.badDate;
  return PH ? PH.errText(e) : T.failed;
}
function stars(n, size){
  if (!n) return '';
  var s = '';
  for (var i = 1; i <= 5; i++) s += '<span class="it-star' + (i <= n ? ' on' : '') + '">' + starSvg(size || 16) + '</span>';
  return '<span class="it-stars-ro" role="img" aria-label="' + esc(T.stars(n)) + '">' + s + '</span>';
}
function card(m){
  var sub = movieSub(m);
  return '<button type="button" class="it-card it-card--movie" data-movie="' + m.id + '">'
    + '<span class="it-media it-media--poster">' + (m.poster ? '<img src="' + posterUrl(m.id) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()">' : '') + '<span class="it-media-ic">' + FILM + '</span></span>'
    + '<span class="it-body"><span class="it-name">' + esc(m.title) + '</span>'
    + (sub ? '<span class="it-sub">' + esc(sub) + '</span>' : '')
    + (m.rating ? '<span class="it-row">' + stars(m.rating) + '</span>' : '')
    + '</span></button>';
}
function render(){
  $('#mv-list').innerHTML = movies.map(card).join('');
  var e = $('#mv-empty');
  e.textContent = canWrite ? T.emptyAdmin : T.empty;
  e.classList.toggle('hidden', !loaded || movies.length > 0);
}

/* ---------- 详情 ---------- */
function para(label, v){ return v ? '<div class="it-dl"><div class="it-dt">' + esc(label) + '</div><div class="it-dd">' + esc(v).replace(/\n/g, '<br>') + '</div></div>' : ''; }
function view(m){
  viewing = m.id;
  var html = '<div class="it-hero it-hero--poster">' + (m.poster ? '<img src="' + posterUrl(m.id) + '" alt="">' : '<span class="it-media-ic">' + FILM + '</span>') + '</div>'
    + (m.rating ? '<p class="it-hero-sub">' + stars(m.rating, 18) + '</p>' : '')
    + para(T.original, m.original_title) + para(T.year, m.year ? String(m.year) : '') + para(T.director, m.director)
    + para(T.watched, m.watched_at) + para(T.review, m.review);
  $('#it-view-title').textContent = m.title;
  $('#it-view-body').innerHTML = html;
  $('#it-view-body').scrollTop = 0;
  $('#it-view-edit').classList.toggle('hidden', !canWrite);
  if (UI) UI.openOverlay('it-view-wrap');
}
$('#mv-list').addEventListener('click', function(e){ var b = e.target.closest('[data-movie]'); var m = b && find(Number(b.dataset.movie)); if (m) view(m); });
$('#it-view-edit').addEventListener('click', function(){
  var m = viewing && find(viewing);
  if (!m) return;
  if (UI) UI.closeOverlay('it-view-wrap');
  openEdit(m);
});

/* ---------- 编辑 ---------- */
function renderRating(){
  var h = '';
  for (var i = 1; i <= 5; i++) h += '<button type="button" role="radio" class="it-star-btn' + (i <= rating ? ' on' : '') + '" aria-checked="' + (i === rating) + '" aria-label="' + esc(T.stars(i)) + '" data-r="' + i + '">' + starSvg(28) + '</button>';
  $('#mv-rating').innerHTML = h;
}
$('#mv-rating').addEventListener('click', function(e){ var b = e.target.closest('[data-r]'); if (!b) return; var n = Number(b.dataset.r); rating = n === rating ? 0 : n; renderRating(); });
function setErr(m){ var el = $('#mv-err'); el.textContent = m || ''; el.classList.toggle('hidden', !m); }
function openEdit(m){
  editing = m || null;
  $('#mv-edit-title').textContent = m ? T.edit : T.add;
  $('#mv-title').value = m ? m.title : '';
  $('#mv-original').value = m ? m.original_title : '';
  $('#mv-year').value = m && m.year ? String(m.year) : '';
  $('#mv-director').value = m ? m.director : '';
  $('#mv-watched').value = m ? m.watched_at : '';
  $('#mv-review').value = m ? m.review : '';
  rating = m ? m.rating : 0;
  renderRating();
  if (photo) photo.reset(m || {}, !!(m && m.poster));
  $('#mv-del').classList.toggle('hidden', !m);
  setErr('');
  if (UI) UI.openOverlay('mv-edit-wrap');
  if (!m) setTimeout(function(){ $('#mv-title').focus(); }, 50);
}
$('#mv-fab').addEventListener('click', function(){ openEdit(null); });
$('#mv-save').addEventListener('click', function(){
  var title = $('#mv-title').value.trim();
  if (!title) return setErr(T.needTitle);
  var year = parseYear($('#mv-year').value);
  if (year === null) return setErr(T.badYear);
  var body = {
    title: title, original_title: $('#mv-original').value, year: year, director: $('#mv-director').value,
    watched_at: $('#mv-watched').value, rating: rating, review: $('#mv-review').value,
  };
  body.op = editing ? 'movie.edit' : 'movie.add';
  if (editing) body.id = editing.id;
  var btn = $('#mv-save'); btn.disabled = true;
  op(body).then(function(j){
    var id = editing ? editing.id : j.id;
    return (photo ? photo.commit(id) : Promise.resolve(false)).then(function(bad){
      var m = find(id);
      if (m && !bad && photo) { ver[id] = Date.now(); }
      return getJSON('/curio/api/movies').then(function(k){ movies = k.movies || movies; render(); }, function(){}).then(function(){
        if (UI) UI.closeOverlay('mv-edit-wrap');
        toast(bad ? T.photoFail : T.saved);
      });
    });
  }).catch(function(e){ if (!e.sgxLocked) setErr(errText(e)); }).then(function(){ btn.disabled = false; });
});
$('#mv-del').addEventListener('click', function(){
  if (!editing || !UI) return;
  var id = editing.id;
  UI.ask(T.delMovie, T.del, function(){ op({ op: 'movie.del', id: id }).then(function(){ UI.closeOverlay('mv-edit-wrap'); toast(T.deleted); }).catch(function(e){ if (!e.sgxLocked) toast(errText(e)); }); });
});

/* ---------- 启动 ---------- */
getJSON('/curio/api/movies').then(function(j){
  canWrite = !!j.canWrite; showPrivate = !!j.showPrivate; movies = j.movies || []; loaded = true;
  $('#mv-fab').classList.toggle('hidden', !canWrite);
  if (UI && UI.signin) UI.signin(canWrite, showPrivate);
  doc.querySelectorAll('.it-loading').forEach(function(el){ el.classList.add('hidden'); });
  render();
}).catch(function(e){
  if (e && e.sgxLocked) return;
  doc.querySelectorAll('.it-loading').forEach(function(el){ el.textContent = T.failed; });
});
})();
