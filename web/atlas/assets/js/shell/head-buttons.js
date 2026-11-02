/**
 * @fileoverview 顶栏（通版，三个站同一套，2026-10-22 v8）：两个圆 + 一个长条：
 *   九宫格圆（导航抽屉）| 长条（只有当前页名，屏幕居中）| 右圆（每站自己的按钮：主站 = 快捷面板 .sgx-tb-quick，见 quick-panel.js）。
 * - 长条里的页名由 baseof.html 服务端写好（主页「首页」/ Home）。长条里不放图标；搜索只从抽屉底栏的搜索框进，没有独立的搜索页。
 * - 头像在导航抽屉头（字标右边，.sgx-drawer-me，链到账号页）。
 * - 导航抽屉（#sgx-drawer，Gmail Android 式左侧抽屉，<dialog> 模态）：九宫格打开；
 *   点遮罩 / 系统返回 / Esc 关闭。打开时 push 一条同 URL 的历史哨兵，系统返回只关抽屉不离开页面。
 * - 抽屉底栏的搜索框（#sgx-drawer-search）：点它在这次点击里同步打开原地搜索层（search-host.js → 共享组件 search-layer.js）：
 *   抽屉立刻关上（modalSheet.handoff，哨兵交给搜索层），它的复制件原地淡出，搜索框变形成底部搜索栏并聚焦（键盘马上弹）；
 *   不跳页、顶栏不动。搜索层代码在按下九宫格 / 打开抽屉时就开始加载。
 */
import { sgxNavigate } from '../lib/diag-jumptrace.js';
import { modalSheet } from './modal-sheet.js';
import { initQuickPanel } from './quick-panel.js';
import { openSearch, prefetchSearch } from './search-host.js';

/** 抽屉滑入 / 滑出时长（与 input.css .sgx-drawer-sheet 的 transition 一致） */
const DRAWER_MS = 220;
/* 抽屉开合状态机（data-state closed/opening/open/closing、历史哨兵、作废旧 rAF / 计时器）在 modal-sheet.js，
 * 顶栏快捷面板（quick-panel.js）用同一份。 */

function initDrawer() {
  const btn = /** @type {HTMLElement|null} */ (document.querySelector('.sgx-tb-nav'));
  const dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('sgx-drawer'));
  if (!btn || !dlg || typeof dlg.showModal !== 'function') return;
  const sheet = dlg.querySelector('.sgx-drawer-sheet');
  const ms = modalSheet(dlg, btn, { ms: DRAWER_MS, stateKey: 'sgxDrawer', onOpen: prefetch });
  /* 搜索层代码：按下九宫格 / 打开抽屉 / 按下搜索框时就开始取，点搜索框时已经在了 */
  function prefetch() {
    prefetchSearch().catch(function () {});
  }
  btn.addEventListener('pointerdown', prefetch, { passive: true });
  const pillEl = dlg.querySelector('a.sgx-drawer-search');
  if (pillEl) pillEl.addEventListener('pointerdown', prefetch, { passive: true });

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
      /* 抽屉底栏搜索框：同步打开原地搜索层（抽屉交接给它，不跳页） */
      if (a.classList.contains('sgx-drawer-search')) {
        openSearch({ from: a, ghost: dlg, handoff: ms.handoff });
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
 * 访客：抽屉头的头像只是装饰 —— 去掉链接（点了没反应、不跳转、键盘也聚焦不到）。
 * 会话角色由 L1 注入 <html data-sgx-role>；锁屏未解锁时没有角色，头像保持原样（锁屏盖住它）。
 * CSS 另有 html[data-sgx-role="visitor"] .sgx-drawer-me { pointer-events:none } 兜底（JS 跑之前）。
 */
export function initVisitorAvatar() {
  if (document.documentElement.getAttribute('data-sgx-role') !== 'visitor') return;
  const me = document.querySelector('.sgx-drawer-me');
  if (!me) return;
  me.removeAttribute('href');
  me.setAttribute('aria-disabled', 'true');
  me.setAttribute('tabindex', '-1');
  me.removeAttribute('aria-label');
  me.setAttribute('aria-hidden', 'true');
}

export function initHeadButtons() {
  initDrawer();
  initQuickPanel();
  initVisitorAvatar();
}
