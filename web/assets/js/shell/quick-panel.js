/**
 * @fileoverview 顶栏快捷面板（#sgx-qp，One UI 快捷面板式）：顶栏长条右端滑块图标 .sgx-tb-quick 打开，从顶部滑下。
 * - 开合 / 系统返回 / Esc / bfcache 走 modal-sheet.js（与导航抽屉同一个状态机：data-state closed/opening/open/closing）。
 * - 点遮罩（面板以外）关闭。
 * - 只放设置里已有的项，写法与设置页完全相同（lib/prefs.js、lib/lock-now.js 是两边共用的 setter），
 *   所以面板和设置页写同一个 localStorage key、互相即时同步（features.on 订阅重绘）。
 * - 语言：切到另一种语言（显式 zh / en），关面板后 replace 到对应语言的同一页（与设置页选语言一致，不留历史）。
 * - 立即锁定：关面板后弹出与安全页相同的「立即锁定？」确认层。
 */
import { on as featOn } from '../lib/features.js';
import { loadI18n } from '../lib/i18n.js';
import { sgxNavigate, sgxReplace } from '../lib/diag-jumptrace.js';
import { confirmLockNow } from '../lib/lock-now.js';
import {
  themeMode,
  isDark,
  setTheme,
  toggleFollowSystem,
  palette,
  setPalette,
  fontSize,
  setFontSize,
  layoutPref,
  layoutNarrow,
  setLayout,
  reducedMotionPref,
  setReducedMotion,
  setLang,
} from '../lib/prefs.js';
import { modalSheet } from './modal-sheet.js';

/** 面板滑下 / 收起时长（与 input.css .sgx-qp-sheet 的 transition 一致） */
const QP_MS = 240;

export function initQuickPanel() {
  const btn = /** @type {HTMLElement|null} */ (document.querySelector('.sgx-tb-quick'));
  const dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('sgx-qp'));
  if (!btn || !dlg || typeof dlg.showModal !== 'function') return;
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
      /* 布局：窄屏（< 840px）时 DeX / PC 置灰（与设置页一致，偏好保留，回到大屏再生效） */
      if (id === 'layout') {
        if ((bv === 'dex' || bv === 'pc') && narrow) {
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
    paintToggle('motion', reducedMotionPref());
    const p = palette();
    dlg.querySelectorAll('[data-qp-palette]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-qp-palette') === p ? 'true' : 'false');
    });
    paintSeg('font-size', fontSize());
    paintSeg('layout', layoutPref(), layoutNarrow());
    const lang = tile('lang');
    if (lang) lang.setAttribute('aria-label', T.t('qpLangTo'));
  }

  const ms = modalSheet(dlg, btn, { ms: QP_MS, stateKey: 'sgxQp', onOpen: paint });

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
      else if (id === 'motion') setReducedMotion(!reducedMotionPref());
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
    const sw = t.closest('[data-qp-palette]');
    if (sw) {
      setPalette(sw.getAttribute('data-qp-palette') || 'lake');
      paint();
      return;
    }
    const sb = /** @type {HTMLButtonElement|null} */ (t.closest('[data-qp-seg] button'));
    if (sb && !sb.disabled) {
      const seg = sb.closest('[data-qp-seg]');
      const id = seg ? seg.getAttribute('data-qp-seg') : '';
      const v = sb.getAttribute('data-v') || '';
      if (id === 'font-size') setFontSize(v);
      else if (id === 'layout') setLayout(v);
      paint();
      return;
    }
    const all = /** @type {HTMLAnchorElement|null} */ (t.closest('a.sgx-qp-all'));
    if (all) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      const href = all.href;
      /* 已经在设置首页：只关闭 */
      if (all.pathname === location.pathname) ms.close();
      else ms.close(function () {
        sgxNavigate(href);
      });
    }
  });

  /* 设置页（或别的标签页）改了同一项：面板开着时即时重绘 */
  const repaint = function () {
    if (ms.isOpen()) paint();
  };
  ['theme-mode', 'palette', 'font-size', 'layout', 'reduced-motion'].forEach(function (id) {
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
