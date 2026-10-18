/**
 * @fileoverview 浏览器页：底部地址栏（点一下跳独立搜索页 /browser/search/）、顶栏 ⋮、书签筛选。
 * 搜索本身在 browser-search.js（做法照抄设置搜索）；原来的磨砂弹出层已删除。
 * 文案来自页面内 sgx-i18n-browser JSON（中英双语），JS 与语言无关。
 */
import { on } from '../lib/events.js';
import { get, set } from '../lib/storage.js';
import { loadI18n } from '../lib/i18n.js';
import { openSheet } from '../shell/sheet.js';
import { engines as SE } from '../shell/engines.js';
import { bindFavFallback } from '../shell/fav.js';
import { onDexLayoutChange } from '../shell/layout.js';
import { sgxNavigate, sgxReplace } from '../lib/diag-jumptrace.js';

(function () {
  'use strict';
  const T = loadI18n('sgx-i18n-browser');
  const en = document.documentElement.lang === 'en';
  const SEARCH_URL = en ? '/en/browser/search/' : '/browser/search/';
  const LS_POS = 'sgx-addrbar-pos';
  const LS_HIST = 'sgx-browser-history';

  /* 旧入口兼容：/browser/?q=… 与 /browser/#focus（主页搜索圆旧链接、OpenSearch、书签）→ 搜索页 */
  try {
    const q = new URLSearchParams(location.search).get('q');
    if (q || location.hash === '#focus') {
      sgxReplace(SEARCH_URL + (q ? '?q=' + encodeURIComponent(q) : ''));
      return;
    }
  } catch (e) {}

  /* favicon 失败兜底（data-favname 委托） */
  bindFavFallback();

  /* ============ 底部地址栏：点一下跳搜索页（不弹键盘；滑过不误触） ============ */
  const addrbar = document.getElementById('brw-addrbar');
  if (addrbar) {
    on(addrbar, 'click', function (/** @type {MouseEvent} */ e) {
      const t = /** @type {Element|null} */ (e.target);
      const mic = t && t.closest ? t.closest('[data-mic]') : null;
      sgxNavigate(SEARCH_URL + (mic ? '#voice' : ''));
    });
    const pillMic = addrbar.querySelector('[data-mic]');
    const SR = /** @type {any} */ (window).SpeechRecognition || /** @type {any} */ (window).webkitSpeechRecognition;
    if (pillMic && SR) /** @type {HTMLElement} */ (pillMic).style.display = '';
  }

  /* ============ 地址栏位置（顶部 / 底部） ============ */
  function curPos() {
    return get(LS_POS) === 'top' ? 'top' : 'bottom';
  }
  function applyDex() {
    const el = document.documentElement;
    const dex = el.classList.contains('layout-dex') || el.classList.contains('layout-pc');
    document.body.classList.toggle('addrbar-dex', dex);
  }
  function applyPos() {
    const pos = curPos();
    document.body.classList.toggle('addrbar-top', pos === 'top');
    document.body.classList.toggle('addrbar-bottom', pos !== 'top');
    applyDex();
  }
  onDexLayoutChange(applyDex);
  applyPos();
  on(window, 'sgx-settings-changed', applyPos);

  /* ============ 顶栏 ⋮（B2-4：原「设置 › 应用 › 浏览器」）：搜索引擎 / 地址栏位置 / 清除浏览记录 ============ */
  function openEngSheet() {
    const cur = SE.cur();
    openSheet({
      title: T.t('engineTitle'),
      options: SE.ORDER.map(function (id) {
        return { label: SE.name(id), value: id, checked: id === cur };
      }),
      onPick: function (v) {
        if (SE.ENGINES[v]) SE.setCur(v);
      },
    });
  }
  function openTbMenu() {
    openSheet({
      title: '',
      options: [
        { label: T.t('engineTitle'), sub: SE.name(SE.cur()), value: 'engine' },
        { label: T.t('addrPos'), sub: T.t(curPos() === 'top' ? 'posTop' : 'posBottom'), value: 'pos' },
        { label: T.t('clearHist'), value: 'clear' },
      ],
      onPick: function (v) {
        if (v === 'engine') openEngSheet();
        else if (v === 'pos') {
          const pos = curPos();
          openSheet({
            title: T.t('addrPos'),
            options: [
              { label: T.t('posTop'), value: 'top', checked: pos === 'top' },
              { label: T.t('posBottom'), value: 'bottom', checked: pos === 'bottom' },
            ],
            onPick: function (p) {
              if (p !== 'top' && p !== 'bottom') return;
              set(LS_POS, p);
              applyPos();
            },
          });
        } else if (v === 'clear') {
          openSheet({
            title: T.t('clearHistQ'),
            options: [{ label: T.t('clear'), value: 'yes' }],
            onPick: function (y) {
              if (y === 'yes') set(LS_HIST, '[]');
            },
          });
        }
      },
    });
  }
  const tbMore = document.getElementById('brw-more');
  if (tbMore) on(tbMore, 'click', openTbMenu);

  /* ============ 书签分类筛选 ============ */
  const catBtns = document.querySelectorAll('[data-brw-cat]');
  /** @param {string} key */
  function filterCats(key) {
    for (let k = 0; k < catBtns.length; k++) {
      catBtns[k].classList.toggle('is-active', catBtns[k].getAttribute('data-brw-cat') === key);
    }
    const groups = document.querySelectorAll('[data-brw-catgroup]');
    for (let g = 0; g < groups.length; g++) {
      /** @type {HTMLElement} */ (groups[g]).style.display =
        key === 'all' || groups[g].getAttribute('data-brw-catgroup') === key ? '' : 'none';
    }
  }
  catBtns.forEach(function (btn) {
    on(btn, 'click', function () {
      filterCats(btn.getAttribute('data-brw-cat') || 'all');
    });
  });
})();
