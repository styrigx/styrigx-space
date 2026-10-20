/**
 * @fileoverview 顶栏（通版，2026-10-20，全站同一套，左右对称 2 + 1 + 2）：
 *   九宫格圆（导航抽屉）+ 搜索圆 | 长条（只显示当前页名，屏幕居中，不可点）| 快捷面板圆 + 头像圆。
 * - 长条里的页名由 baseof.html 服务端写好（主页「首页」/ Home），不再有 Styrigx ↔ 小标题的滚动切换。
 * - 搜索圆（#sgx-tb-search）：进全网搜索页 /search/（普通链接，沿用站内切页过渡）；已经在全网搜索页上时
 *   不重新加载，只聚焦底部搜索输入框（保持搜索页原来的输入行为）。
 * - 没有 ‹ 返回和页面 ⋮：页面操作都在正文里。快捷面板圆（.sgx-tb-quick）见 quick-panel.js。
 * - 导航抽屉（#sgx-drawer，Gmail Android 式左侧抽屉，<dialog> 模态）：九宫格打开；
 *   点遮罩 / 系统返回 / Esc 关闭。打开时 push 一条同 URL 的历史哨兵，系统返回只关抽屉不离开页面。
 */
import { sgxNavigate } from '../lib/diag-jumptrace.js';
import { modalSheet } from './modal-sheet.js';
import { initQuickPanel } from './quick-panel.js';

/** 抽屉滑入 / 滑出时长（与 input.css .sgx-drawer-sheet 的 transition 一致） */
const DRAWER_MS = 220;

/*
 * 抽屉开合状态机（data-state closed/opening/open/closing、历史哨兵、作废旧 rAF / 计时器）在 modal-sheet.js，
 * 顶栏快捷面板（quick-panel.js）用同一份。
 */
function initDrawer() {
  const btn = /** @type {HTMLElement|null} */ (document.querySelector('.sgx-tb-nav'));
  const dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('sgx-drawer'));
  if (!btn || !dlg || typeof dlg.showModal !== 'function') return;
  const sheet = dlg.querySelector('.sgx-drawer-sheet');
  const ms = modalSheet(dlg, btn, { ms: DRAWER_MS, stateKey: 'sgxDrawer' });

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (ms.isOpen()) ms.close();
    else ms.open();
  });
  /* 点遮罩（<dialog> 本身、抽屉面板以外的区域）关闭 */
  dlg.addEventListener('click', function (e) {
    const t = /** @type {Element|null} */ (e.target);
    if (!t) return;
    if (sheet && sheet.contains(t)) {
      const a = /** @type {HTMLAnchorElement|null} */ (t.closest ? t.closest('a.sgx-drawer-item') : null);
      if (!a) return;
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      /* 当前页只关闭抽屉；其他项关完（哨兵出栈后）再跳转 */
      if (a.getAttribute('aria-current') === 'page') ms.close();
      else {
        const href = a.href;
        ms.close(function () {
          sgxNavigate(href);
        });
      }
      return;
    }
    ms.close();
  });
}

/* 搜索圆：在全网搜索页上点它只聚焦底部输入框（不重新加载）；其他页照常走链接进 /search/ */
function initSearchBtn() {
  const btn = /** @type {HTMLAnchorElement|null} */ (document.getElementById('sgx-tb-search'));
  if (!btn) return;
  btn.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('sgx-cap-input-brwsearch'));
    if (!input) return;
    e.preventDefault();
    try {
      input.focus({ preventScroll: true });
    } catch (err) {}
  });
}

export function initHeadButtons() {
  initDrawer();
  initSearchBtn();
  initQuickPanel();
}
