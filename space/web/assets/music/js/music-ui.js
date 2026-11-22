/* assets/music/js/music-ui.js —— 音乐页的几样小部件（浏览器 IIFE，挂 window.SgxMusicUI；node 测试时导出纯函数）。
 * 打磨 6.2（搬家设计稿 v1.1 §六，第 3 步留下的技术债 3.1 第 3 条）：音乐页原先整份借奇趣的 curio/js/curio.js（window.SgxCurioUI），
 * 真正用到的只有四样，拆到这里，音乐页不再加载 curio.js（奇趣各页照旧用 curio.js，那边一行不动）：
 *   - ask(msg, okLabel, fn)：确认框（#confirm-wrap，标记在 partials/music/common.html，外观同奇趣那个：bk-overlay / bk-panel，样式仍在奇趣 main.css）；
 *     取消 / 点遮罩（data-close="confirm"）/ Esc 关，确定先关再调 fn。
 *   - toast(msg)：提示条（#bk-toast），2.4 秒后藏起。
 *   - sudo()：请人进站，发 sgx:sudo（topbar/panel.js 接，顶栏终端预填 su ；= common/js/auth/sudo.js SUDO_EVENT）。
 *   - sudoTicket(line, grant)：D-3 a′「先验后发票」：当前身份是 root → 直接发（空票）；否则在 window 上登记待办
 *     （键名 __sgxSudoGrant，同 common/js/auth/sudo.js SUDO_GRANT_KEY）并预填终端 sudo 行，回车验过后终端交回一次性票。
 * 行为和 curio.js 里的同名几段逐行一致（只是不再顺带启动奇趣「发现」页的部件、页头 tab 的「›」等音乐页用不上的东西）。
 */
(function(){
"use strict";
var G = typeof globalThis !== 'undefined' ? globalThis : this;

/** 提示条停留多久（毫秒，同 curio.js） */
var TOAST_MS = 2400;
/** 待办票登记在 window 上的键名（同 common/js/auth/sudo.js SUDO_GRANT_KEY / curio.js） */
var SUDO_GRANT_KEY = '__sgxSudoGrant';

/**
 * 当前身份是不是 root（POST /api/identity whoami；出错当不是）
 * @param {(url: string, init: any) => Promise<any>} f fetch
 * @returns {Promise<boolean>}
 */
function whoIsRoot(f){
  return f('/api/identity', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: '{"action":"whoami"}' })
    .then(function(r){ return r.json(); }).then(function(j){ return !!(j && j.user && j.user.root); }, function(){ return false; });
}
/**
 * 领一次性票：root → 空串；否则登记待办、预填终端 sudo 行，等终端交回票（没回车就一直等，下次点会顶掉这笔待办）
 * @param {any} g 全局（window） @param {any} doc @param {string} line 终端里预填的 sudo 行 @param {any} grant {method, path, action}
 * @returns {Promise<string>}
 */
function sudoTicketOf(g, doc, line, grant){
  return whoIsRoot(g.fetch.bind(g)).then(function(root){
    if (root) return '';
    return new Promise(function(resolve){
      g[SUDO_GRANT_KEY] = { line: line, grant: grant, done: resolve, at: Date.now() };
      try { doc.dispatchEvent(new CustomEvent('sgx:sudo', { detail: { line: line } })); } catch (e) {}
    });
  });
}

var pure = { TOAST_MS: TOAST_MS, SUDO_GRANT_KEY: SUDO_GRANT_KEY, whoIsRoot: whoIsRoot, sudoTicketOf: sudoTicketOf };
if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

var doc = G.document;
var $ = function(s){ return doc.querySelector(s); };

function sudo(){ try { doc.dispatchEvent(new CustomEvent('sgx:sudo')); } catch (e) {} }

var toastTimer = null;
function toast(msg){
  var el = $('#bk-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ el.classList.add('hidden'); }, TOAST_MS);
}

/* ---------- 确认框（同 curio.js 的 openOverlay / closeOverlay / ask） ---------- */
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
var cancelBtn = $('#confirm-cancel'), okBtn = $('#confirm-ok');
if (cancelBtn) cancelBtn.addEventListener('click', function(){ confirmFn = null; closeOverlay('confirm-wrap'); });
if (okBtn) okBtn.addEventListener('click', function(){ var f = confirmFn; confirmFn = null; closeOverlay('confirm-wrap'); if (f) f(); });

G.SgxMusicUI = {
  ask: function(m, l, f){ ask(m, l, f); },
  toast: function(m){ toast(m); },
  sudo: sudo,
  sudoTicket: function(line, grant){ return sudoTicketOf(G, doc, line, grant); },
};
})();
