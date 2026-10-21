/**
 * @fileoverview 顶栏（通版，2026-10-20 v5，全站同一套）：两个圆 + 一个长条：
 *   九宫格圆（导航抽屉）| 长条（搜索图标 · 当前页名 · 快捷面板图标，屏幕居中）| 头像圆。
 * - 长条里的页名由 baseof.html 服务端写好（主页「首页」/ Home），不再有 Styrigx ↔ 小标题的滚动切换。
 * - 长条左端搜索图标（#sgx-tb-search）：进全网搜索页 /search/（普通链接，沿用站内切页过渡）；已经在全网搜索页上时
 *   不重新加载，只聚焦底部搜索输入框（保持搜索页原来的输入行为）。
 * - 没有 ‹ 返回和页面 ⋮：页面操作都在正文里。长条右端快捷面板图标（.sgx-tb-quick）见 quick-panel.js。
 * - 导航抽屉（#sgx-drawer，Gmail Android 式左侧抽屉，<dialog> 模态）：九宫格打开；
 *   点遮罩 / 系统返回 / Esc 关闭。打开时 push 一条同 URL 的历史哨兵，系统返回只关抽屉不离开页面。
 * - 抽屉底栏的搜索框长条（#sgx-drawer-search，2026-10-21 v7：钉在抽屉底部，AI 搜索图标 + 「搜索」居中）：和长条搜索图标同一个地址。
 *   点它：整个抽屉原地淡出（.is-fading，只改 opacity、不改宽度不滑出，遮罩一起淡掉，CSS 见 input.css「抽屉淡出」），
 *   淡完（FADE_MS）关上 <dialog> 并退掉抽屉的历史哨兵（不把抽屉开着的状态留在历史里），再跳搜索页，
 *   并在 sessionStorage 记 sgx-search-from-drawer=1，搜索页据此首帧挂 .sgx-from-drawer：内容淡入、底部搜索栏从左下方随键盘升起。
 *   已经在全网搜索页上：同样原地淡出，然后底栏做同一个升起动画（.sgx-bar-pop）并聚焦输入框（不跳转）。
 *   减弱动效：不淡出、不做动画，直接跳 / 直接关并聚焦。
 */
import { sgxNavigate } from '../lib/diag-jumptrace.js';
import { modalSheet } from './modal-sheet.js';
import { initQuickPanel } from './quick-panel.js';
import { reducedMotion } from '../lib/util.js';

/** 抽屉滑入 / 滑出时长（与 input.css .sgx-drawer-sheet 的 transition 一致） */
const DRAWER_MS = 220;
/** 点抽屉搜索框后抽屉原地淡出的时长（与 input.css --sgx-drawer-fade-ms 一致） */
const FADE_MS = 200;
/** 搜索页读取的「从抽屉进来」标记 */
export const FROM_DRAWER_KEY = 'sgx-search-from-drawer';

/* 抽屉开合状态机（data-state closed/opening/open/closing、历史哨兵、作废旧 rAF / 计时器）在 modal-sheet.js，
 * 顶栏快捷面板（quick-panel.js）用同一份。 */

/** 全网搜索页底部输入框（只在 /search/ 上有） */
function searchInput() {
  return /** @type {HTMLInputElement|null} */ (document.getElementById('sgx-cap-input-brwsearch'));
}
/** @param {HTMLInputElement} input */
function focusSearch(input) {
  try {
    input.focus({ preventScroll: true });
  } catch (err) {}
}
/**
 * 搜索页底栏从左下方升起（.sgx-bar-pop，和从抽屉进搜索页的入场同一个动画）并聚焦输入框；减弱动效只聚焦。
 * @param {HTMLInputElement} input
 */
function popSearch(input) {
  const bar = /** @type {HTMLElement|null} */ (input.closest('.sgx-cap-bar'));
  if (bar && !reducedMotion()) {
    const barIn = bar.querySelector('.sgx-cap-bar-in');
    bar.classList.remove('sgx-bar-pop');
    void bar.offsetWidth;
    bar.classList.add('sgx-bar-pop');
    if (barIn) {
      barIn.addEventListener('animationend', function () {
        bar.classList.remove('sgx-bar-pop');
      }, { once: true });
    }
  }
  focusSearch(input);
}

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
      const a = /** @type {HTMLAnchorElement|null} */ (t.closest ? t.closest('a.sgx-drawer-item, a.sgx-drawer-search') : null);
      if (!a) return;
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      /* 抽屉底栏搜索框：原地淡出后进搜索页；在全网搜索页上淡出后底栏升起并聚焦 */
      if (a.classList.contains('sgx-drawer-search')) {
        fadeToSearch(dlg, ms, a.href);
        return;
      }
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

/**
 * 抽屉原地淡出 → 全网搜索页（已在搜索页上：不跳转，底栏升起并聚焦）。
 * @param {HTMLDialogElement} dlg
 * @param {import('./modal-sheet.js').ModalSheet} ms
 * @param {string} href
 */
function fadeToSearch(dlg, ms, href) {
  if (dlg.classList.contains('is-fading')) return;
  const input = searchInput();
  const after = input
    ? function () {
      /* 在哨兵出栈的 popstate 里：等这次分发完再聚焦（胶囊自己的 popstate 兜底会把刚聚焦的输入框 blur 掉） */
      window.setTimeout(function () { popSearch(input); }, 0);
    }
    : function () { sgxNavigate(href); };
  if (!input) {
    try {
      sessionStorage.setItem(FROM_DRAWER_KEY, '1');
    } catch (e) {}
  }
  /* 减弱动效：照常关（无动画）后跳转 / 聚焦 */
  if (reducedMotion()) {
    ms.close(after);
    return;
  }
  dlg.classList.add('is-fading');
  window.setTimeout(function () {
    /* 淡完：先摘掉 is-open（没有可等的滑出，close() 立刻关上 <dialog>），再退哨兵；哨兵出栈后执行 after */
    dlg.classList.remove('is-open');
    ms.close(function () {
      dlg.classList.remove('is-fading');
      after();
    });
  }, FADE_MS);
}

/* 长条搜索图标：在全网搜索页上点它只聚焦底部输入框（不重新加载）；其他页照常走链接进 /search/ */
function initSearchBtn() {
  const btn = /** @type {HTMLAnchorElement|null} */ (document.getElementById('sgx-tb-search'));
  if (!btn) return;
  btn.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const input = searchInput();
    if (!input) return;
    e.preventDefault();
    focusSearch(input);
  });
}

/**
 * 访客：右上角头像只是装饰 —— 去掉链接（点了没反应、不跳转、键盘也聚焦不到）。
 * 会话角色由 L1 注入 <html data-sgx-role>；锁屏未解锁时没有角色，头像保持原样（锁屏盖住它）。
 * CSS 另有 html[data-sgx-role="visitor"] .sgx-tb-me { pointer-events:none } 兜底（JS 跑之前）。
 */
export function initVisitorAvatar() {
  if (document.documentElement.getAttribute('data-sgx-role') !== 'visitor') return;
  const me = document.querySelector('.sgx-tb-me');
  if (!me) return;
  me.removeAttribute('href');
  me.setAttribute('aria-disabled', 'true');
  me.setAttribute('tabindex', '-1');
  me.removeAttribute('aria-label');
  me.setAttribute('aria-hidden', 'true');
}

export function initHeadButtons() {
  initDrawer();
  initSearchBtn();
  initQuickPanel();
  initVisitorAvatar();
}
