/**
 * @fileoverview 顶栏快捷面板（#sgx-qp，One UI 快捷面板式；2026-10-21 v6：从顶栏底下落下的覆盖层）：
 *   顶栏右圆（滑块图标 .sgx-tb-quick，2026-10-22 从长条右端挪到右圆）打开，面板从顶栏底下钻出来、落在顶栏下方盖住正文，正文不动；
 *   顶栏一直在最上面（不被遮罩压暗），图标开着时是按下态（aria-expanded="true"），再点关闭。
 * - 非模态 <dialog>（modal-sheet.js modal:false → show()）：不进顶层，z-index 在顶栏下面；dialog 本身就是遮罩（只盖顶栏下沿以下）。
 * - 开合 / 系统返回 / Esc / bfcache 走 modal-sheet.js（与导航抽屉同一个状态机：data-state closed/opening/open/closing、历史哨兵）。
 * - 点遮罩（面板以外）关闭；点顶栏上别的按钮 / 链接（九宫格、搜索、头像、长条空白）：先关面板（哨兵出栈）再执行那一下。
 * - 焦点：打开时进面板（.sgx-qp-sheet autofocus）；关上时如果焦点还在面板里（或掉到 body），还给快捷面板图标。
 *   Tab / Shift+Tab 在「快捷面板图标 + 面板里的控件」之间循环（非模态不会 inert 页面，自己圈住），图标仍可用键盘关面板。
 * - 2026-10-24 PR4：顶部标题和齿轮（全部设置）删除，面板直接从磁贴开始；设置入口在顶栏三栏的「设置」。
 * - 只放设置里已有的项，写法与设置页完全相同（lib/prefs.js、lib/lock-now.js 是两边共用的 setter），
 *   所以面板和设置页写同一个 localStorage key、互相即时同步（features.on 订阅重绘）。
 * - 语言：切到另一种语言（显式 zh / en），关面板后 replace 到对应语言的同一页（与设置页选语言一致，不留历史）。
 * - 立即锁定：关面板后弹出与安全页相同的「立即锁定？」确认层。
 * - 2026-10-21：减弱动效、字体大小不再放面板里（只在设置页）；行标题右端「恢复默认」（[data-qp-reset]）= 选默认色板
 *   （2026-10-23 PR-G 起 dustyblue；同一个 setPalette，自定义主题色也一起清掉）；已是默认且没有自定义色时 aria-disabled 置灰、点了不动，不隐藏（免得跳版）。
 *   PR-G：22 套七色调色板一个网格（不再分单色 / 撞色两行），色块和设置页同一种光晕方块（.pal-tile）。
 */
import { on as featOn } from '../lib/features.js';
import { loadI18n } from '../lib/i18n.js';
import { sgxReplace } from '../lib/diag-jumptrace.js';
import { confirmLockNow } from '../lib/lock-now.js';
import {
  themeMode,
  isDark,
  setTheme,
  toggleFollowSystem,
  palette,
  setPalette,
  DEFAULT_PALETTE,
  layoutPref,
  layoutNarrow,
  setLayout,
  setLang,
} from '../lib/prefs.js';
import { accent } from '../lib/accent.js';
import { modalSheet } from './modal-sheet.js';

/** 面板滑下 / 收起时长（与 input.css .sgx-qp-sheet 的 transition 一致） */
const QP_MS = 240;

export function initQuickPanel() {
  const btn = /** @type {HTMLElement|null} */ (document.querySelector('.sgx-tb-quick'));
  const dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('sgx-qp'));
  if (!btn || !dlg || typeof dlg.show !== 'function') return;
  const sheet = /** @type {HTMLElement|null} */ (dlg.querySelector('.sgx-qp-sheet'));
  const T = loadI18n('sgx-i18n-core');
  const en = document.documentElement.lang === 'en';

  /** @param {string} id */
  function tile(id) {
    return /** @type {HTMLElement|null} */ (dlg.querySelector('[data-qp="' + id + '"]'));
  }
  /** 开关磁贴：aria-pressed + 状态文案（开 / 关） @param {string} id @param {boolean} on */
  function paintToggle(id, on) {
    const el = tile(id);
    if (!el) return;
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    const st = el.querySelector('[data-qp-state]');
    if (st) st.textContent = on ? T.t('qpOn') : T.t('qpOff');
  }
  /** @param {string} id @param {string} v @param {boolean} [narrow] */
  function paintSeg(id, v, narrow) {
    dlg.querySelectorAll('[data-qp-seg="' + id + '"] button').forEach(function (b) {
      const bv = b.getAttribute('data-v');
      b.setAttribute('aria-pressed', bv === v ? 'true' : 'false');
      /* 布局：不够 DeX（宽 < 840 或高 < 500）时 DeX 置灰（与设置页一致，偏好保留，回到大屏再生效） */
      if (id === 'layout') {
        if (bv === 'dex' && narrow) {
          b.setAttribute('disabled', 'disabled');
          b.setAttribute('title', T.t('qpLargeOnly'));
        } else {
          b.removeAttribute('disabled');
          b.removeAttribute('title');
        }
      }
    });
  }
  function paint() {
    paintToggle('dark', isDark());
    paintToggle('system', themeMode() === 'system');
    const p = palette();
    dlg.querySelectorAll('[data-qp-palette]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-qp-palette') === p ? 'true' : 'false');
    });
    const rs = dlg.querySelector('[data-qp-reset]');
    if (rs) rs.setAttribute('aria-disabled', p === DEFAULT_PALETTE && !accent() ? 'true' : 'false');
    paintSeg('layout', layoutPref(), layoutNarrow());
    const lang = tile('lang');
    if (lang) lang.setAttribute('aria-label', T.t('qpLangTo'));
  }

  const ms = modalSheet(dlg, btn, {
    ms: QP_MS,
    stateKey: 'sgxQp',
    modal: false,
    onOpen: paint,
    onClosed: function () {
      const a = document.activeElement;
      if (!a || a === document.body || dlg.contains(a)) {
        try {
          btn.focus({ preventScroll: true });
        } catch (e) {}
      }
    },
  });

  /* 面板开着时点顶栏上别的东西：先关面板（等哨兵出栈）再补点一下，免得跳转和 history.back() 打架 */
  const topbar = document.querySelector('.sgx-topbar');
  if (topbar) {
    topbar.addEventListener('click', function (e) {
      if (!ms.isShown()) return;
      const t = /** @type {Element|null} */ (e.target);
      if (!t || btn.contains(t)) return;
      e.preventDefault();
      e.stopPropagation();
      const act = /** @type {HTMLElement|null} */ (t.closest('a[href], button'));
      ms.close(act ? function () {
        act.click();
      } : undefined);
    }, true);
  }

  /* Tab 圈在「快捷面板图标 + 面板控件」里 */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab' || !ms.isShown()) return;
    const list = [btn].concat(Array.from(dlg.querySelectorAll('a[href], button:not([disabled])')).filter(function (el) {
      return /** @type {HTMLElement} */ (el).offsetParent !== null;
    }));
    const i = list.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    const n = list.length;
    const next = i < 0 ? (e.shiftKey ? n - 1 : 1 % n) : (i + (e.shiftKey ? n - 1 : 1)) % n;
    e.preventDefault();
    try {
      /** @type {HTMLElement} */ (list[next]).focus();
    } catch (err) {}
  });

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (ms.isOpen()) ms.close();
    else ms.open();
  });

  dlg.addEventListener('click', function (e) {
    const t = /** @type {Element|null} */ (e.target);
    if (!t) return;
    /* 点遮罩（面板以外）关闭 */
    if (!sheet || !sheet.contains(t)) {
      ms.close();
      return;
    }
    const tl = /** @type {HTMLElement|null} */ (t.closest('[data-qp]'));
    if (tl) {
      const id = tl.getAttribute('data-qp');
      if (id === 'dark') setTheme(isDark() ? 'light' : 'dark');
      else if (id === 'system') toggleFollowSystem();
      else if (id === 'lang') {
        const url = setLang(en ? 'zh' : 'en');
        ms.close(function () {
          sgxReplace(url);
        });
        return;
      } else if (id === 'lock') {
        ms.close(confirmLockNow);
        return;
      }
      paint();
      return;
    }
    const rs = t.closest('[data-qp-reset]');
    if (rs) {
      /* 恢复默认：与点色块同一条路（setPalette 会顺手清掉自定义主题色）；已是默认时不动 */
      if (rs.getAttribute('aria-disabled') !== 'true') setPalette(DEFAULT_PALETTE);
      paint();
      return;
    }
    const sw = t.closest('[data-qp-palette]');
    if (sw) {
      setPalette(sw.getAttribute('data-qp-palette') || DEFAULT_PALETTE);
      paint();
      return;
    }
    const sb = /** @type {HTMLButtonElement|null} */ (t.closest('[data-qp-seg] button'));
    if (sb && !sb.disabled) {
      const seg = sb.closest('[data-qp-seg]');
      const id = seg ? seg.getAttribute('data-qp-seg') : '';
      const v = sb.getAttribute('data-v') || '';
      if (id === 'layout') setLayout(v);
      paint();
      return;
    }
  });

  /* 设置页（或别的标签页）改了同一项：面板开着时即时重绘 */
  const repaint = function () {
    if (ms.isOpen()) paint();
  };
  ['theme-mode', 'palette', 'layout'].forEach(function (id) {
    featOn(id, repaint);
  });
  window.addEventListener('sgx-theme-changed', repaint);
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    (mq.addEventListener || mq.addListener).call(mq, 'change', function () {
      /* 跟随系统时系统深浅色变了（theme.js 已重应用），等它应用完再重绘 */
      window.setTimeout(repaint, 0);
    });
  } catch (e) {}
}
