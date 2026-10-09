/**
 * @fileoverview 底部搜索胶囊（替代旧 sgx-capsule.js ExecuteAsTemplate）。
 * 页面标识从 DOM 的 id="sgx-cap-{page}" 推导，不再烘焙进 JS；
 * 各页通过 setCapSearchProvider 注册搜索回调（替代旧 window.__sgxCapSearch）。
 */
import { on } from './events.js';
import { voiceSheet } from './voice-sheet.js';
import { reducedMotion } from './util.js';
import { onKeyboardHeight } from './vk.js';

/**
 * @typedef {(page: string, q: string) => string} CapSearchProvider
 */

/** @type {CapSearchProvider|null} */
let provider = null;

/**
 * 注册胶囊搜索回调（各页调用一次）。
 * @param {CapSearchProvider} fn
 */
export function setCapSearchProvider(fn) {
  provider = fn;
}

/**
 * 初始化页面内所有 .sgx-cap 胶囊（幂等）。
 */
export function initCapsule() {
  const reduced = reducedMotion();
  document.querySelectorAll('.sgx-cap').forEach(function (capEl) {
    const cap = /** @type {HTMLElement} */ (capEl);
    if (cap.dataset.sgxInit) return;
    cap.dataset.sgxInit = '1';
    const m = /^sgx-cap-(.+)$/.exec(cap.id || '');
    const page = m ? m[1] : '';
    const input = /** @type {HTMLInputElement|null} */ (
      document.getElementById('sgx-cap-input-' + page)
    );
    const panel = /** @type {HTMLElement|null} */ (document.getElementById('sgx-cap-results-' + page));

    if (!cap || !input) return;

    let opened = false;
    const kbMaxSeen = { v: 0 };

    /* 按键盘高度更新：宽度按 键盘高度/最终高度 同步插值；--sgx-kb 供结果浮层用 */
    /** @param {number} h */
    function kbUpdate(h) {
      h = Math.max(0, h || 0);
      if (h > kbMaxSeen.v) kbMaxSeen.v = h;
      const p = kbMaxSeen.v < 1 ? 1 : Math.min(1, h / kbMaxSeen.v);
      const vw = window.innerWidth || 0;
      const baseW = Math.min(vw * 0.64, 300);
      const fullW = document.documentElement.classList.contains('layout-dex')
        ? Math.min(480, Math.max(0, vw - 32))
        : Math.max(0, vw - 32);
      cap.style.width = Math.round(baseW + (fullW - baseW) * p) + 'px';
      document.documentElement.style.setProperty('--sgx-kb', Math.round(h) + 'px');
      /* 无 VK API 时手动把胶囊顶到键盘上方 */
      if (!document.documentElement.classList.contains('sgx-vk')) {
        const capRest = document.body.classList.contains('subpage') ? 12 : 88;
        cap.style.transform = 'translateX(-50%) translateY(' + Math.round(capRest - 12 - h) + 'px)';
      }
    }

    /** @type {Array<() => void>} */
    let openDisposers = [];
    function open() {
      if (opened) return;
      opened = true;
      cap.classList.add('open');
      if (panel) panel.hidden = false;
      /* 2.4.0 D：键盘高度统一走 vk.js（VirtualKeyboard API / visualViewport 回退） */
      openDisposers.push(onKeyboardHeight(kbUpdate, cap));
      doSearch();
    }
    function close() {
      if (!opened) return;
      opened = false;
      cap.classList.remove('open');
      cap.classList.remove('sgx-kb-sync');
      document.documentElement.classList.remove('sgx-vk');
      cap.style.width = '';
      cap.style.transform = '';
      openDisposers.forEach(function (d) {
        d();
      });
      openDisposers = [];
      if (panel) {
        panel.hidden = true;
        panel.innerHTML = '';
      }
      document.documentElement.style.setProperty('--sgx-kb', '0px');
    }
    function doSearch() {
      if (typeof provider !== 'function') return;
      let html = '';
      try {
        html = provider(page, input.value.trim()) || '';
      } catch (e) {}
      if (panel) {
        panel.innerHTML = html;
        panel.hidden = !html;
        if (html) {
          panel.classList.remove('sgx-fade');
          void panel.offsetWidth;
          if (!reduced) panel.classList.add('sgx-fade');
        }
      }
    }

    /** @type {number|null} */
    let deb = null;
    /* 触屏点输入框时手动聚焦并禁止浏览器自动滚动页面（页面全程不动） */
    on(
      input,
      'touchstart',
      function (/** @type {TouchEvent} */ e) {
        if (document.activeElement !== input) {
          try {
            e.preventDefault();
          } catch (_) {}
          try {
            input.focus(/** @type {any} */ ({ preventScroll: true }));
          } catch (err) {
            try {
              input.focus();
            } catch (_) {}
          }
        }
      },
      { passive: false }
    );
    on(input, 'focus', function () {
      open();
    });
    on(input, 'input', function () {
      if (!opened) open();
      if (deb) clearTimeout(deb);
      deb = window.setTimeout(doSearch, 150);
    });
    on(input, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Escape') {
        input.blur();
        close();
      } else if (e.key === 'Enter') {
        doSearch();
        if (page === 'store') {
          input.blur();
          close();
        }
      }
    });
    /* 失焦后收起（延迟一点，让结果里的点击先触发） */
    on(input, 'blur', function () {
      window.setTimeout(function () {
        if (panel && panel.contains(document.activeElement)) return;
        close();
      }, 180);
    });
    if (panel) {
      on(panel, 'click', function (e) {
        const t = /** @type {Element|null} */ (e.target);
        const hit = t && t.closest ? t.closest('a,button') : null;
        if (hit) window.setTimeout(close, 80);
      });
    }
    /* 语音输入：走共享语音弹窗；只检测 SpeechRecognition 接口是否存在；
       不支持则麦克风不渲染（无空位、无报错） */
    const mic = cap.querySelector('[data-mic]');
    const SR =
      /** @type {any} */ (window).SpeechRecognition || /** @type {any} */ (window).webkitSpeechRecognition;
    if (mic && SR) {
      /** @type {HTMLElement} */ (mic).style.display = '';
      on(mic, 'click', function (e) {
        e.stopPropagation();
        voiceSheet({
          onFinal: function (t) {
            if (!opened) open();
            input.value = t;
            doSearch();
          },
        });
      });
    }
    /* 页面底部留白：胶囊不压内容，最后一项能完整滚出 */
    document.body.classList.add('sgx-cap-pad');
  });
}
