/**
 * @fileoverview AI 页：平台网格、收藏、输入框、语音、快捷键、全部打开。
 * 平台中英文说明为双语数据（JS 与语言无关）；toast 文案来自 sgx-i18n-ai JSON。
 */
import { on } from './events.js';
import { esc } from './util.js';
import { loadI18n } from './i18n.js';
import { toast } from './toast.js';
import { voiceInput } from './voice.js';
import { bindFavFallback } from './fav.js';

(function () {
  'use strict';
  const T = loadI18n('sgx-i18n-ai');
  const EN = document.documentElement.lang === 'en';
  /** @param {string} u */
  function hostOf(u) {
    try {
      return new URL(u).hostname;
    } catch (e) {
      return '';
    }
  }

  /* ---------- 平台列表：name、home、url 模板、prefill、中英文说明 ---------- */
  const PLATFORMS = [
    { id: 'chatgpt', name: 'ChatGPT', home: 'https://chatgpt.com/', url: 'https://chatgpt.com/?prompt={q}', prefill: true, zh: 'OpenAI', en: 'OpenAI' },
    { id: 'perplexity', name: 'Perplexity', home: 'https://www.perplexity.ai/', url: 'https://www.perplexity.ai/search/new?q={q}', prefill: true, zh: 'AI 搜索', en: 'AI search' },
    { id: 'googleai', name: 'Google AI', home: 'https://www.google.com/search?udm=50', url: 'https://www.google.com/search?udm=50&q={q}', prefill: true, zh: 'AI 模式', en: 'AI Mode' },
    { id: 'grok', name: 'Grok', home: 'https://grok.com/', url: 'https://grok.com/?q={q}', prefill: true, zh: 'xAI', en: 'xAI' },
    { id: 'deepseek', name: 'DeepSeek', home: 'https://chat.deepseek.com/', url: 'https://chat.deepseek.com/?q={q}', prefill: true, zh: '深度求索', en: 'DeepSeek' },
    { id: 'kimi', name: 'Kimi', home: 'https://www.kimi.com/', url: 'https://www.kimi.com/?p={q}', prefill: true, zh: '月之暗面', en: 'Moonshot' },
    { id: 'gemini', name: 'Gemini', home: 'https://gemini.google.com/app', url: '', prefill: false, zh: 'Google', en: 'Google' },
    { id: 'muse', name: 'Muse', home: 'https://muse.ai/', url: '', prefill: false, zh: 'Meta', en: 'Meta' },
    { id: 'doubao', name: '豆包', home: 'https://www.doubao.com/chat/', url: '', prefill: false, zh: '字节跳动', en: 'ByteDance' },
    { id: 'tongyi', name: '通义千问', home: 'https://www.tongyi.com/', url: '', prefill: false, zh: '阿里巴巴', en: 'Alibaba' },
  ];
  /** @type {Record<string, any>} */
  const byId = {};
  PLATFORMS.forEach(function (p) {
    byId[p.id] = p;
  });

  const input = /** @type {HTMLInputElement|null} */ (document.getElementById('ai-q')),
    grid = document.getElementById('ai-grid'),
    micBtn = document.getElementById('ai-mic'),
    clearBtn = document.getElementById('ai-clear'),
    openAllBtn = document.getElementById('ai-openall');
  if (!input || !grid) return;

  bindFavFallback();

  /* ---------- 收藏 ---------- */
  const LS_FAV = 'sgx-ai-fav',
    DEFAULT_FAV = ['chatgpt', 'perplexity', 'googleai'];
  /* 旧 id 迁移：claude -> muse */
  /** @param {Array<string>} a */
  function migrateFavs(a) {
    let changed = false;
    a = a.map(function (id) {
      if (id === 'claude') {
        changed = true;
        return 'muse';
      }
      return id;
    });
    return { a: a, changed: changed };
  }
  function getFavs() {
    try {
      const v = localStorage.getItem(LS_FAV);
      if (v === null) {
        localStorage.setItem(LS_FAV, JSON.stringify(DEFAULT_FAV));
        return DEFAULT_FAV.slice();
      }
      const a = JSON.parse(v);
      if (!Array.isArray(a)) return DEFAULT_FAV.slice();
      const m = migrateFavs(a);
      if (m.changed) setFavs(m.a);
      return m.a;
    } catch (e) {
      return DEFAULT_FAV.slice();
    }
  }
  /** @param {Array<string>} a */
  function setFavs(a) {
    try {
      localStorage.setItem(LS_FAV, JSON.stringify(a));
    } catch (e) {}
  }
  /** @param {string} id */
  function isFav(id) {
    return getFavs().indexOf(id) >= 0;
  }
  /** @param {string} id */
  function toggleFav(id) {
    const favs = getFavs(),
      i = favs.indexOf(id);
    if (i >= 0) favs.splice(i, 1);
    else favs.push(id);
    setFavs(favs);
    renderGrid();
    toast(i >= 0 ? T.t('unfav') : T.t('fav'));
  }

  /* ---------- 输入框：自动增高 / sessionStorage / ?q= ---------- */
  const LS_Q = 'sgx-ai-q';
  function autogrow() {
    input.style.height = 'auto';
    const lh = parseFloat(getComputedStyle(input).lineHeight) || 24;
    const maxH = lh * 6;
    const h = Math.min(input.scrollHeight, maxH);
    input.style.height = h + 'px';
    input.style.overflowY = input.scrollHeight > maxH ? 'auto' : 'hidden';
  }
  function saveQ() {
    try {
      sessionStorage.setItem(LS_Q, input.value);
    } catch (e) {}
  }
  (function initQ() {
    let q = null;
    try {
      q = new URLSearchParams(location.search).get('q');
    } catch (e) {}
    if (q) {
      input.value = q;
    } else {
      try {
        const s = sessionStorage.getItem(LS_Q);
        if (s) input.value = s;
      } catch (e) {}
    }
    autogrow();
  })();
  on(input, 'input', function () {
    saveQ();
    autogrow();
  });

  if (clearBtn)
    on(clearBtn, 'click', function () {
      input.value = '';
      saveQ();
      autogrow();
      input.focus();
    });

  /* 语音：复用统一组件（含错误提示） */
  voiceInput(micBtn, {
    input: function () {
      return input;
    },
    onResult: function () {
      saveQ();
      autogrow();
    },
  });

  /* 快捷键：Ctrl/⌘+Enter 用第一个收藏平台打开；Esc 清空 */
  on(input, 'keydown', function (/** @type {KeyboardEvent} */ e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      const f = getFavs()
        .map(function (id) {
          return byId[id];
        })
        .filter(Boolean)[0];
      if (f) openPlatform(f, input.value);
    } else if (e.key === 'Escape') {
      input.value = '';
      saveQ();
      autogrow();
    }
  });

  /* 提示词芯片：填入输入框前缀 */
  document.querySelectorAll('.ai-chip').forEach(function (ch) {
    on(ch, 'click', function () {
      const pre = ch.getAttribute('data-chip') || '';
      const cur = input.value.replace(/^\s+/, '');
      input.value = pre + (cur ? '\n' + cur : '');
      saveQ();
      autogrow();
      input.focus();
    });
  });

  /* ---------- 打开逻辑 ---------- */
  /** @param {string} q @param {(ok: boolean) => void} done */
  function copyThenOpen(q, done) {
    function fin(/** @type {boolean} */ ok) {
      if (ok) {
        toast(T.t('copied'));
      } else {
        toast(T.t('copyFail'));
        try {
          input.focus();
          input.select();
        } catch (e) {}
      }
      done(ok);
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(q).then(
          function () {
            fin(true);
          },
          function () {
            fin(false);
          }
        );
      } else fin(false);
    } catch (e) {
      fin(false);
    }
  }
  /** @param {any} p @param {string} q */
  function openPlatform(p, q) {
    q = (q || '').trim();
    const url = p.prefill && q ? p.url.replace('{q}', encodeURIComponent(q)) : p.home;
    if (p.prefill || !q) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    /* 不支持预填：先复制问题再打开官网 */
    copyThenOpen(q, function () {
      window.open(url, '_blank', 'noopener');
    });
  }
  function openAll() {
    const favs = getFavs()
      .map(function (id) {
        return byId[id];
      })
      .filter(Boolean);
    if (!favs.length) return;
    const q = input.value.trim();
    const needCopy = q && favs.some(function (/** @type {any} */ p) {
      return !p.prefill;
    });
    function go() {
      favs.forEach(function (/** @type {any} */ p) {
        const url = p.prefill && q ? p.url.replace('{q}', encodeURIComponent(q)) : p.home;
        window.open(url, '_blank', 'noopener');
      });
    }
    if (needCopy) copyThenOpen(q, go);
    else go();
  }
  if (openAllBtn) on(openAllBtn, 'click', openAll);

  /* ---------- 平台网格渲染 ---------- */
  /** @param {any} p */
  function cardHTML(p) {
    const host = hostOf(p.home);
    const fav = isFav(p.id);
    const desc = EN ? p.en : p.zh;
    return (
      '<button type="button" class="ai-plat" role="listitem" data-id="' + p.id + '" aria-label="' + esc(p.name) + '">' +
      '<img src="https://www.google.com/s2/favicons?domain=' + esc(host) + '&sz=64" alt="" loading="lazy" decoding="async" width="48" height="48" class="ai-plat-ic" data-favname="' + esc(p.name) + '">' +
      '<span class="ai-plat-name">' + esc(p.name) + '</span>' +
      '<span class="ai-plat-desc">' + esc(desc) + '</span>' +
      '<span class="ai-star' + (fav ? ' on' : '') + '" aria-hidden="true">★</span>' +
      '</button>'
    );
  }
  function renderGrid() {
    grid.innerHTML = PLATFORMS.map(cardHTML).join('');
    bindCards();
  }
  function bindCards() {
    grid.querySelectorAll('.ai-plat').forEach(function (el) {
      const id = el.getAttribute('data-id') || '',
        p = byId[id];
      if (!p) return;
      on(el, 'click', function () {
        openPlatform(p, input.value);
      });
      /* 长按收藏（触屏） */
      /** @type {number|null} */
      let timer = null;
      let fired = false;
      function start() {
        fired = false;
        timer = window.setTimeout(function () {
          fired = true;
          toggleFav(id);
        }, 550);
      }
      function cancel() {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }
      on(el, 'touchstart', start, { passive: true });
      on(el, 'touchend', cancel);
      on(el, 'touchmove', cancel, { passive: true });
      /* 右键收藏（桌面） */
      on(el, 'contextmenu', function (e) {
        e.preventDefault();
        toggleFav(id);
      });
      /* 长按后吞掉 click */
      on(
        el,
        'click',
        function (e) {
          if (fired) {
            e.preventDefault();
            e.stopPropagation();
            fired = false;
          }
        },
        { capture: true }
      );
    });
  }
  renderGrid();
})();
