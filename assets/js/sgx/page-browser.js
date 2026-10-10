/**
 * @fileoverview 浏览器页：地址栏弹出层、搜索引擎切换、站内建议、最近搜索、书签筛选。
 * 文案来自页面内 sgx-i18n-browser JSON（中英双语），JS 与语言无关。
 */
import { on } from './events.js';
import { esc } from './util.js';
import { get, set } from './storage.js';
import { loadI18n } from './i18n.js';
import { openSheet } from './sheet.js';
import { voiceSheet } from './voice-sheet.js';
import { engines } from './engines.js';
import { bindFavFallback } from './fav.js';
import { onDexLayoutChange } from './layout.js';
import { onKeyboardHeight } from './vk.js';

(function () {
  'use strict';
  const T = loadI18n('sgx-i18n-browser');
  const EN = document.documentElement.lang === 'en';

  function lsGet(/** @type {string} */ k, /** @type {string} */ d) {
    const v = get(k);
    return v == null ? d : v;
  }
  function lsSet(/** @type {string} */ k, /** @type {string} */ v) {
    set(k, v);
  }

  /* ============ 搜索引擎（定义走共享模块 sgx/engines.js，与设置页共用） ============ */
  const SE = engines;
  const LS_RECENT = 'sgx-browser-recent',
    LS_POS = 'sgx-addrbar-pos';

  function curEngine() {
    return SE.cur();
  }

  const input = /** @type {HTMLInputElement|null} */ (document.getElementById('brw-input')),
    suggest = document.getElementById('brw-suggest'),
    engineBtn = /** @type {HTMLElement|null} */ (document.getElementById('brw-engine-btn')),
    engineIc = document.getElementById('brw-engine-ic'),
    micBtn = document.getElementById('brw-mic'),
    menuBtn = document.getElementById('brw-menu-btn'),
    overlay = document.getElementById('brw-overlay'),
    addrbar = document.getElementById('brw-addrbar');
  if (!input || !suggest || !overlay) return;

  /* favicon 失败兜底（data-favname 委托） */
  bindFavFallback();

  /* ============ 2.3.12.1 弹出层开/关：磨砂蒙层，点蒙层空白处或返回键淡出关闭 ============ */
  let ovOpen = false;
  /**
   * @param {{focus?: boolean}} [opts]
   */
  function openOverlay(opts) {
    if (ovOpen) return;
    ovOpen = true;
    try {
      history.pushState({ brwOv: 1 }, '');
    } catch (e) {}
    overlay.classList.add('open');
    renderSuggest();
    if (!opts || opts.focus !== false) {
      window.setTimeout(function () {
        try {
          input.focus(/** @type {any} */ ({ preventScroll: true }));
        } catch (e) {}
      }, 180);
    }
    stickKb();
  }
  /**
   * @param {boolean} [fromPop]
   */
  function closeOverlay(fromPop) {
    if (!ovOpen) return;
    ovOpen = false;
    overlay.classList.remove('open');
    overlay.classList.remove('has-text');
    if (engMenuOpen && engMenu) {
      try {
        /** @type {any} */ (engMenu).hidePopover();
      } catch (e) {}
    }
    try {
      input.blur();
    } catch (e) {}
    unstickKb();
    if (!fromPop) {
      try {
        history.back();
      } catch (e) {}
    }
  }
  if (addrbar) on(addrbar, 'click', function () { openOverlay(); });
  /* 内容区是全高滚动容器；点蒙层边缘或内容下方空白（padding 区）同样关闭 */
  const ovTop = overlay.querySelector('#brw-overlay .brw-ov-top');
  on(overlay, 'click', function (/** @type {MouseEvent} */ e) {
    const t = /** @type {Element|null} */ (e.target);
    if (t === overlay) {
      closeOverlay(false);
      return;
    }
    if (ovTop && t === ovTop) {
      let bottom = 0;
      const ch = ovTop.children;
      for (let i = 0; i < ch.length; i++) {
        if (/** @type {HTMLElement} */ (ch[i]).offsetParent !== null) {
          const b = ch[i].getBoundingClientRect().bottom;
          if (b > bottom) bottom = b;
        }
      }
      if (e.clientY > bottom + 4) closeOverlay(false);
    }
  });
  on(document, 'keydown', function (/** @type {KeyboardEvent} */ e) {
    if (e.key === 'Escape' && ovOpen) closeOverlay(false);
  });
  on(window, 'popstate', function () {
    if (ovOpen) closeOverlay(true);
  });

  /* ============ 键盘贴合：地址栏贴键盘，无跳动（2.4.0 D：统一走 vk.js） ============ */
  /** @type {(() => void)|null} */ let kbCleanup = null;
  function stickKb() {
    unstickKb();
    kbCleanup = onKeyboardHeight(function (h) {
      document.documentElement.style.setProperty('--sgx-kb', Math.round(h) + 'px');
    }, overlay);
  }
  function unstickKb() {
    document.documentElement.classList.remove('sgx-vk');
    overlay.classList.remove('sgx-kb-sync');
    if (kbCleanup) {
      kbCleanup();
      kbCleanup = null;
    }
    document.documentElement.style.setProperty('--sgx-kb', '0px');
  }

  /* ============ 地址栏位置 ============ */
  function applyDex() {
    const el = document.documentElement;
    const dex = el.classList.contains('layout-dex') || el.classList.contains('layout-pc');
    document.body.classList.toggle('addrbar-dex', dex);
  }
  function applyPos() {
    let pos = lsGet(LS_POS, 'bottom');
    if (pos !== 'top') pos = 'bottom';
    document.body.classList.toggle('addrbar-top', pos === 'top');
    document.body.classList.toggle('addrbar-bottom', pos !== 'top');
    applyDex();
  }
  onDexLayoutChange(function () {
    applyDex();
  });
  applyPos();
  /* 设置页改动后双向同步（搜索引擎、地址栏位置）；引擎变化时刷新建议 */
  on(window, 'sgx-settings-changed', function () {
    applyPos();
    paintEngine();
    renderSuggest();
  });

  /* ============ 引擎切换：地址栏「logo + ▾」，锚定弹出菜单 ============ */
  const engMenu = document.getElementById('brw-eng-menu'),
    engList = engMenu ? engMenu.querySelector('.brw-eng-list') : null;
  let engMenuOpen = false,
    engLight = false;
  let anchorOK = false;
  const popoverOK = !!(engMenu && /** @type {any} */ (engMenu).showPopover);
  try {
    anchorOK = !!(
      window.CSS &&
      (CSS.supports('position-anchor', '--brw-eng-btn') || CSS.supports('anchor-name', '--brw-eng-btn'))
    );
  } catch (e) {
    anchorOK = false;
  }

  function paintEngine() {
    if (!engineBtn || !engineIc) return;
    const k = curEngine();
    engineIc.innerHTML = SE.iconUse(k, 22);
    engineBtn.setAttribute('aria-label', T.fmt('switchEngine', { n: SE.name(k) }));
  }
  function buildEngMenu() {
    if (!engList) return;
    const cur = curEngine();
    let html = '';
    SE.ORDER.forEach(function (id) {
      const checked = id === cur;
      const def = id === 'google' ? ' <span class="brw-eng-def">' + T.t('engineDef') + '</span>' : '';
      html +=
        '<button type="button" class="brw-eng-item" role="menuitemradio" aria-checked="' + checked + '" data-eng="' + id + '">' +
        '<span class="brw-eng-logo">' + SE.iconUse(id, 24) + '</span>' +
        '<span class="brw-eng-name">' + esc(SE.name(id)) + def + '</span>' +
        '<svg class="brw-eng-check" width="18" height="18" aria-hidden="true"><use href="#sgx-ic-check"></use></svg>' +
        '</button>';
    });
    engList.innerHTML = html;
  }
  function placeEngMenu() {
    if (!engMenu || !engineBtn) return;
    /* 无 anchor positioning：按按钮位置手动定位，空间不足自动上翻 */
    const r = engineBtn.getBoundingClientRect();
    const mw = engMenu.offsetWidth,
      mh = engMenu.offsetHeight;
    const x = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
    const below = r.bottom + 8 + mh <= window.innerHeight - 8;
    /** @type {HTMLElement} */ (engMenu).style.left = x + 'px';
    /** @type {HTMLElement} */ (engMenu).style.top = (below ? r.bottom + 8 : Math.max(8, r.top - 8 - mh)) + 'px';
    engMenu.classList.toggle('flip', !below);
  }
  /** @param {string} id */
  function pickEngine(id) {
    if (!SE.ENGINES[id]) return;
    SE.setCur(id); /* 存值 + 派发 sgx-settings-changed，两边实时同步 */
    paintEngine();
    renderSuggest(); /* 有输入内容时立即刷新建议 */
    if (engMenuOpen && engMenu) {
      try {
        /** @type {any} */ (engMenu).hidePopover();
      } catch (e) {}
    }
    try {
      input.focus(/** @type {any} */ ({ preventScroll: true }));
    } catch (e) {} /* 焦点还给输入框，键盘不收起 */
  }
  function openEngSheet() {
    /* 极旧浏览器回退：原来的底部菜单（定义走共享模块） */
    const cur = curEngine();
    openSheet({
      title: T.t('engineTitle'),
      options: SE.ORDER.map(function (id) {
        return { label: SE.name(id), value: id, checked: id === cur };
      }),
      onPick: function (v) {
        pickEngine(v);
      },
    });
  }
  /** @param {boolean} fromKeyboard */
  function openEngMenu(fromKeyboard) {
    if (!popoverOK) {
      openEngSheet();
      return;
    }
    if (!engMenu) return;
    buildEngMenu();
    engMenu.classList.toggle('no-anchor', !anchorOK);
    /** @type {HTMLElement} */ (engMenu).style.left = '';
    /** @type {HTMLElement} */ (engMenu).style.top = '';
    engMenu.classList.remove('flip');
    engLight = false;
    try {
      /** @type {any} */ (engMenu).showPopover();
    } catch (e) {
      return;
    }
    /* 键盘打开（Enter/Space）：焦点进菜单，支持方向键 + 回车；触屏/鼠标不抢焦点，键盘保持弹起 */
    if (fromKeyboard && engList) {
      const cur = engList.querySelector('[aria-checked="true"]');
      if (cur) {
        try {
          /** @type {HTMLElement} */ (cur).focus(/** @type {any} */ ({ preventScroll: true }));
        } catch (e) {}
      }
    }
  }
  if (engineBtn) {
    /* 触屏/鼠标点按钮不抢输入框焦点，键盘保持弹起 */
    on(engineBtn, 'pointerdown', function (e) {
      e.preventDefault();
    });
    on(engineBtn, 'click', function (/** @type {MouseEvent} */ e) {
      if (engMenuOpen && engMenu) {
        try {
          /** @type {any} */ (engMenu).hidePopover();
        } catch (e2) {}
        return;
      }
      openEngMenu(e.detail === 0); /* detail===0 即键盘激活 */
    });
  }
  if (engMenu && engList) {
    on(engList, 'click', function (/** @type {MouseEvent} */ e) {
      const t = /** @type {Element|null} */ (e.target);
      const it = t && t.closest ? t.closest('.brw-eng-item') : null;
      if (it) pickEngine(it.getAttribute('data-eng') || '');
    });
    on(engList, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      const items = engList.querySelectorAll('.brw-eng-item');
      if (!items.length) return;
      let idx = -1;
      for (let i = 0; i < items.length; i++) {
        if (items[i] === document.activeElement) {
          idx = i;
          break;
        }
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        /** @type {HTMLElement} */ (items[(idx + 1 + items.length) % items.length]).focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        /** @type {HTMLElement} */ (items[(idx - 1 + items.length) % items.length]).focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        /** @type {HTMLElement} */ (items[0]).focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        /** @type {HTMLElement} */ (items[items.length - 1]).focus();
      }
    });
    on(engMenu, 'toggle', function (/** @type {any} */ e) {
      engMenuOpen = e.newState === 'open';
      if (engineBtn) engineBtn.setAttribute('aria-expanded', engMenuOpen ? 'true' : 'false');
      if (engMenuOpen) {
        if (!anchorOK) {
          placeEngMenu();
        } else if (engineBtn) {
          /* anchor 定位 + 自动翻转：翻上去时缩放动画原点改到底部 */
          const mr = engMenu.getBoundingClientRect(),
            br = engineBtn.getBoundingClientRect();
          engMenu.classList.toggle('flip', mr.top < br.top - 4);
        }
      } else {
        /* 点外部/Esc 关闭：焦点回到输入框（点外部的轻关闭走原生行为，不抢） */
        if (!engLight && ovOpen && document.activeElement !== input) {
          try {
            input.focus(/** @type {any} */ ({ preventScroll: true }));
          } catch (e2) {}
        }
        engLight = false;
      }
    });
    /* 点外部的轻关闭不抢焦点；点菜单内部不算轻关闭 */
    on(
      document,
      'pointerdown',
      function () {
        if (engMenuOpen) engLight = true;
      },
      true
    );
    on(engList, 'pointerdown', function () {
      engLight = false;
    });
    /* 无 anchor 时键盘/视口变化重定位 */
    if (window.visualViewport) {
      on(window.visualViewport, 'resize', function () {
        if (engMenuOpen && !anchorOK) placeEngMenu();
      });
    }
  }
  paintEngine();

  /* ============ 菜单：地址栏位置 / 清除最近 ============ */
  if (menuBtn)
    on(menuBtn, 'click', function () {
      let pos = lsGet(LS_POS, 'bottom');
      if (pos !== 'top') pos = 'bottom';
      openSheet({
        title: T.t('menuTitle'),
        options: [
          { label: T.t('addrTop'), value: 'top', checked: pos === 'top' },
          { label: T.t('addrBottom'), value: 'bottom', checked: pos === 'bottom' },
          { label: T.t('clearRecent'), value: '__clear_recent' },
        ],
        onPick: function (v) {
          if (v === '__clear_recent') {
            lsSet(LS_RECENT, '[]');
            renderSuggest();
            return;
          }
          if (v === 'top' || v === 'bottom') {
            lsSet(LS_POS, v);
            applyPos();
          }
        },
      });
    });

  /* ============ 语音输入：走共享语音弹窗；识别文字填入并展示站内建议 ============ */
  (function () {
    const SR = /** @type {any} */ (window).SpeechRecognition || /** @type {any} */ (window).webkitSpeechRecognition;
    if (micBtn && SR) {
      micBtn.style.display = '';
      on(micBtn, 'click', function (e) {
        e.stopPropagation();
        voiceSheet({
          onFinal: function (t) {
            input.value = t;
            renderSuggest();
            showSuggest();
            try {
              input.focus(/** @type {any} */ ({ preventScroll: true }));
            } catch (e2) {}
          },
        });
      });
    }
  })();

  /* ============ 底部地址栏胶囊麦克风：点麦克风先打开弹出层，再走共享语音弹窗 ============ */
  (function () {
    const pillMic = addrbar ? addrbar.querySelector('[data-mic]') : null;
    const SR = /** @type {any} */ (window).SpeechRecognition || /** @type {any} */ (window).webkitSpeechRecognition;
    if (!pillMic || !SR) return;
    /** @type {HTMLElement} */ (pillMic).style.display = '';
    on(pillMic, 'click', function (e) {
      e.stopPropagation();
      openOverlay({ focus: false });
      voiceSheet({
        onFinal: function (t) {
          input.value = t;
          renderSuggest();
          showSuggest();
          try {
            input.focus(/** @type {any} */ ({ preventScroll: true }));
          } catch (e2) {}
        },
      });
    });
  })();

  /* ============ 站内搜索索引 ============ */
  const TYPE_META = {
    link: { label: T.t('catLink'), icon: 'globe' },
    book: { label: T.t('catBook'), icon: 'book' },
    music: { label: T.t('catMusic'), icon: 'music' },
    post: { label: T.t('catPost'), icon: 'pen' },
    app: { label: T.t('catApp'), icon: 'compass' },
  };
  const C_CATS = ['link', 'book', 'music', 'post', 'app'].map(function (k) {
    return { type: k, label: TYPE_META[k].label, icon: TYPE_META[k].icon };
  });

  // 旧内联索引 {t,d,u,c} → 新形状 {t,d,u,type}
  /** @param {string} c */
  function oldCatToType(c) {
    c = c || '';
    if (c.indexOf(T.t('catLink')) === 0) return 'link';
    if (c === T.t('catBook')) return 'book';
    if (c === T.t('catMusic')) return 'music';
    if (c === T.t('catPost')) return 'post';
    return 'app';
  }
  /** @param {Array<any>} raw */
  function normInline(raw) {
    return (raw || []).map(function (x) {
      return { t: x.t || '', d: x.d || '', u: x.u || '', type: oldCatToType(x.c) };
    });
  }

  /** @type {Array<any>} */
  let INDEX = [];
  function loadInline() {
    try {
      const el = document.getElementById('search-index');
      INDEX = normInline(JSON.parse((el && el.textContent) || '{"items":[]}').items);
    } catch (e) {
      INDEX = [];
    }
  }
  loadInline();

  // 异步换上 /files-index.json（按当前语言过滤）；失败则保留内联兜底
  /** @param {any} item */
  function isAppHidden(item) {
    if (!item || item.type !== 'app') return false;
    try {
      const h = JSON.parse(localStorage.getItem('sgx-apps-hidden') || '[]');
      const id = String(item.id || '').replace(/-en$/, '').replace(/^app-/, '');
      return h.indexOf(id) !== -1;
    } catch (e) {
      return false;
    }
  }
  (function () {
    const wantLang = document.documentElement.lang === 'en' ? 'en' : 'zh';
    fetch('/files-index.json')
      .then(function (r) {
        if (!r.ok) throw new Error('bad status ' + r.status);
        return r.json();
      })
      .then(function (j) {
        const items = ((j && j.items) || [])
          .filter(function (/** @type {any} */ x) {
            return x && TYPE_META[x.type] && (x.lang || 'zh') === wantLang && !isAppHidden(x);
          })
          .map(function (/** @type {any} */ x) {
            return { t: x.title || '', d: x.subtitle || '', u: x.url || '', type: x.type, id: x.id || '' };
          });
        if (items.length) INDEX = items;
      })
      .catch(function () {
        /* keep inline fallback */
      });
    /* 应用卸载/安装后即时重过滤 */
    on(window, 'sgx-settings-changed', function () {
      INDEX = INDEX.filter(function (x) {
        return !isAppHidden(x);
      });
      renderSuggest();
    });
  })();

  /** @param {string} inner */
  function svgIc(inner) {
    return (
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
      inner +
      '</svg>'
    );
  }
  const ICONS = {
    globe: svgIc('<path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9 9 0 100-18 9 9 0 000 18zm0 0c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m-8.7 9h17.4"/>'),
    book: svgIc('<path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"/>'),
    music: svgIc('<path stroke-linecap="round" stroke-linejoin="round" d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
    pen: svgIc('<path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125"/>'),
    sparkles: svgIc('<path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z"/>'),
    compass: svgIc('<circle cx="12" cy="12" r="9"/><path stroke-linecap="round" stroke-linejoin="round" d="M15.2 8.8l-2.7 5.7-5.7 2.7 2.7-5.7 5.7-2.7z"/>'),
    clock: svgIc('<path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/>'),
    search: svgIc('<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/>'),
    x: svgIc('<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>'),
    trash: svgIc('<path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/>'),
  };

  /* ============ 最近搜索 ============ */
  function getRecent() {
    try {
      const a = JSON.parse(lsGet(LS_RECENT, '[]'));
      return Array.isArray(a) ? a : [];
    } catch (e) {
      return [];
    }
  }
  /** @param {string} s */
  function pushRecent(s) {
    s = (s || '').trim();
    if (!s) return;
    const a = getRecent().filter(function (x) {
      return x !== s;
    });
    a.unshift(s);
    lsSet(LS_RECENT, JSON.stringify(a.slice(0, 8)));
  }
  /** @param {string} s */
  function delRecent(s) {
    lsSet(LS_RECENT, JSON.stringify(getRecent().filter(function (x) {
      return x !== s;
    })));
    renderSuggest();
  }

  /* ============ 建议列表 ============ */
  let selIdx = -1;
  /** @type {Array<any>} */
  let curRows = [];

  /**
   * @param {number} i
   * @param {string} ic
   * @param {string} title
   * @param {string} sub
   * @param {string} tag
   * @param {string} [extra]
   */
  function rowHTML(i, ic, title, sub, tag, extra) {
    return (
      '<div class="brw-sg-row flex items-center gap-3 px-4 py-2.5 cursor-pointer' + (extra ? ' ' + extra : '') +
      '" role="option" data-i="' + i + '">' +
      '<span class="brw-sg-ic shrink-0 text-m-on-surface-variant">' + ic + '</span>' +
      '<span class="brw-sg-tx flex-1 min-w-0"><span class="brw-sg-ti block text-sm font-medium truncate">' + esc(title) + '</span>' +
      (sub ? '<span class="brw-sg-sub block text-xs text-m-on-surface-variant truncate">' + esc(sub) + '</span>' : '') +
      '</span>' +
      (tag ? '<span class="brw-sg-tag shrink-0 text-[11px] text-m-on-primary-container bg-m-primary-container rounded-full px-2 py-0.5">' + esc(tag) + '</span>' : '') +
      '</div>'
    );
  }

  function renderSuggest() {
    const q = input.value.trim();
    selIdx = -1;
    curRows = [];
    overlay.classList.toggle('has-text', q.length > 0);
    if (!q) {
      suggest.innerHTML = '';
      renderHist();
      return;
    }
    const ql = q.toLowerCase();
    let html = '';
    C_CATS.forEach(function (cat) {
      const hits = INDEX.filter(function (x) {
        return x.type === cat.type && (x.t + ' ' + (x.d || '')).toLowerCase().indexOf(ql) !== -1;
      }).slice(0, 3);
      if (!hits.length) return;
      html += '<div class="brw-sg-group px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-m-on-surface-variant">' + esc(cat.label) + '</div>';
      hits.forEach(function (x) {
        const i = curRows.length;
        curRows.push({ kind: 'site', title: x.t, url: x.u });
        html += rowHTML(i, ICONS[cat.icon], x.t, x.d, cat.label);
      });
    });
    const ek = curEngine(),
      i = curRows.length;
    curRows.push({ kind: 'engine', title: q });
    html += rowHTML(i, ICONS.search, T.fmt('searchWith', { n: SE.name(ek) }) + ' “' + q + '”', '', '', 'brw-sg-engine');
    /* 问 AI：跳到 /ai/?q= */
    const aiIdx = curRows.length;
    curRows.push({ kind: 'ai', title: q });
    html += rowHTML(aiIdx, ICONS.sparkles, T.t('askAI') + ' “' + q + '”', '', 'AI');
    suggest.innerHTML = html;
  }

  function renderRecent() {
    const a = getRecent();
    let html = '';
    html += '<div class="brw-sg-group px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-m-on-surface-variant">' + esc(T.t('recentTitle')) + '</div>';
    if (!a.length) {
      html += '<div class="brw-sg-empty px-4 py-6 text-center text-sm text-m-on-surface-variant">' + esc(T.t('recentEmpty')) + '</div>';
    } else {
      a.forEach(function (s) {
        const i = curRows.length;
        curRows.push({ kind: 'recent', title: s });
        html +=
          '<div class="brw-sg-row flex items-center gap-3 px-4 py-2.5 cursor-pointer" role="option" data-i="' + i + '">' +
          '<span class="brw-sg-ic shrink-0 text-m-on-surface-variant">' + ICONS.clock + '</span>' +
          '<span class="brw-sg-tx flex-1 min-w-0"><span class="brw-sg-ti block text-sm truncate">' + esc(s) + '</span></span>' +
          '<span class="brw-sg-del shrink-0 p-1 text-m-on-surface-variant" data-del="' + esc(s) + '" role="button" aria-label="' + esc(T.t('del')) + '">' + ICONS.x + '</span>' +
          '</div>';
      });
      html +=
        '<div class="brw-sg-clear flex items-center justify-center gap-2 px-4 py-3 text-sm text-m-on-surface-variant cursor-pointer" data-clear="1">' +
        '<span class="brw-sg-ic">' + ICONS.trash + '</span><span>' + esc(T.t('clearAll')) + '</span></div>';
    }
    suggest.innerHTML = html;
  }

  function showSuggest() {
    /* 弹出层内建议列表常驻，无需显隐 */
  }
  function hideSuggest() {
    selIdx = -1;
  }
  function paintSel() {
    const rows = suggest.querySelectorAll('.brw-sg-row');
    for (let k = 0; k < rows.length; k++) {
      rows[k].classList.toggle('is-sel', parseInt(rows[k].getAttribute('data-i') || '-1', 10) === selIdx);
    }
    const sel = suggest.querySelector('.brw-sg-row.is-sel');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }
  /** @param {number} d */
  function moveSel(d) {
    if (!curRows.length) return;
    selIdx = (selIdx + d + curRows.length) % curRows.length;
    paintSel();
  }

  /** @param {string} u */
  function openUrl(u) {
    hideSuggest();
    if (!u) return;
    if (/^https?:\/\//i.test(u)) {
      window.open(u, '_blank', 'noopener');
    } else {
      location.href = u;
    }
  }

  const URL_RE = /^[^\s]+\.[^\s]{2,}$/;
  const HAS_CJK = /[一-鿿㐀-䶿豈-﫿]/;
  /** @param {string} q */
  function doSearch(q) {
    q = (q || '').trim();
    if (!q) return;
    pushRecent(q);
    pushHist(q);
    hideSuggest();
    if (URL_RE.test(q) && !HAS_CJK.test(q)) {
      const url = /^https?:\/\//i.test(q) ? q : 'https://' + q;
      window.open(url, '_blank', 'noopener');
      return;
    }
    const ek = curEngine();
    window.open(SE.url(ek, q), '_blank', 'noopener');
  }

  /** @param {number} i */
  function activateRow(i) {
    const r = curRows[i];
    if (!r) return;
    if (r.kind === 'engine') {
      doSearch(r.title);
      return;
    }
    if (r.kind === 'ai') {
      pushRecent(r.title);
      hideSuggest();
      location.href = (EN ? '/en/ai/' : '/ai/') + '?q=' + encodeURIComponent(r.title);
      return;
    }
    if (r.kind === 'recent') {
      input.value = r.title;
      doSearch(r.title);
      return;
    }
    pushRecent(r.title);
    openUrl(r.url);
  }

  on(suggest, 'click', function (/** @type {MouseEvent} */ ev) {
    const et = /** @type {Element|null} */ (ev.target);
    const del = et && et.closest ? et.closest('[data-del]') : null;
    if (del) {
      ev.stopPropagation();
      delRecent(del.getAttribute('data-del') || '');
      return;
    }
    const clr = et && et.closest ? et.closest('[data-clear]') : null;
    if (clr) {
      lsSet(LS_RECENT, '[]');
      renderSuggest();
      return;
    }
    const row = et && et.closest ? et.closest('.brw-sg-row') : null;
    if (!row) return;
    activateRow(parseInt(row.getAttribute('data-i') || '-1', 10));
  });

  on(input, 'input', function () {
    renderSuggest();
    showSuggest();
  });
  on(input, 'focus', function () {
    renderSuggest();
    showSuggest();
  });
  on(input, 'keydown', function (/** @type {KeyboardEvent} */ ev) {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      moveSel(ev.key === 'ArrowDown' ? 1 : -1);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (selIdx >= 0 && curRows[selIdx]) {
        activateRow(selIdx);
      } else {
        doSearch(input.value);
      }
    } else if (ev.key === 'Escape') {
      closeOverlay(false);
    }
  });

  /* ============ 弹层内最近搜索卡片 ============ */
  const LS_HIST = 'sgx-browser-history',
    LS_HIST_HIDE = 'sgx-browser-history-hidden';
  const histCard = document.getElementById('brw-hist-card'),
    histTags = document.getElementById('brw-hist-tags'),
    histShow = document.getElementById('brw-hist-show');
  function getHist() {
    try {
      const a = JSON.parse(lsGet(LS_HIST, '[]'));
      return Array.isArray(a) ? a.slice(0, 12) : [];
    } catch (e) {
      return [];
    }
  }
  /** @param {Array<string>} a */
  function setHist(a) {
    lsSet(LS_HIST, JSON.stringify(a));
  }
  /** @param {string} s */
  function pushHist(s) {
    s = (s || '').trim();
    if (!s) return;
    const a = getHist().filter(function (x) {
      return x !== s;
    });
    a.unshift(s);
    setHist(a.slice(0, 12));
  }
  function renderHist() {
    if (!histCard || !histShow) return;
    const a = getHist(),
      hidden = lsGet(LS_HIST_HIDE, '') === '1';
    histCard.hidden = true;
    histShow.hidden = true;
    if (!a.length) return;
    if (hidden) {
      histShow.hidden = false;
      return;
    }
    histCard.hidden = false;
    if (histTags)
      histTags.innerHTML = a
        .map(function (s) {
          return (
            '<span class="brw-hist-tag"><span class="brw-hist-tx">' + esc(s) + '</span>' +
            '<span class="brw-hist-x" data-hx="' + esc(s) + '" role="button" aria-label="' + esc(T.t('del')) + '">' + ICONS.x + '</span></span>'
          );
        })
        .join('');
  }
  if (histTags) {
    on(histTags, 'click', function (/** @type {MouseEvent} */ ev) {
      const et = /** @type {Element|null} */ (ev.target);
      const x = et && et.closest ? et.closest('[data-hx]') : null;
      if (x) {
        ev.stopPropagation();
        setHist(
          getHist().filter(function (s) {
            return s !== x.getAttribute('data-hx');
          })
        );
        renderHist();
        return;
      }
      const tag = et && et.closest ? et.closest('.brw-hist-tag') : null;
      if (tag) {
        const tx = tag.querySelector('.brw-hist-tx');
        const v = tx ? tx.textContent || '' : '';
        doSearch(v);
      }
    });
    const hc = document.getElementById('brw-hist-clear');
    if (hc)
      on(hc, 'click', function () {
        setHist([]);
        renderHist();
      });
    const hh = document.getElementById('brw-hist-hide');
    if (hh)
      on(hh, 'click', function () {
        lsSet(LS_HIST_HIDE, '1');
        renderHist();
      });
    on(histShow, 'click', function () {
      lsSet(LS_HIST_HIDE, '');
      renderHist();
    });
  }

  /* ============ 书签分类筛选 ============ */
  const catBtns = document.querySelectorAll('[data-brw-cat]');
  /** @param {string} key */
  function filterCats(key) {
    for (let k = 0; k < catBtns.length; k++) {
      catBtns[k].classList.toggle('is-active', catBtns[k].getAttribute('data-brw-cat') === key);
    }
    const groups = document.querySelectorAll('[data-brw-catgroup]');
    for (let g = 0; g < groups.length; g++) {
      /** @type {HTMLElement} */ (groups[g]).style.display = key === 'all' || groups[g].getAttribute('data-brw-catgroup') === key ? '' : 'none';
    }
  }
  catBtns.forEach(function (btn) {
    on(btn, 'click', function () {
      filterCats(btn.getAttribute('data-brw-cat') || 'all');
    });
  });

  /* ============ ?q= 预填 / #focus 聚焦 ============ */
  function initFromUrl() {
    let q = null;
    try {
      q = new URLSearchParams(location.search).get('q');
    } catch (e) {}
    if (q) {
      input.value = q;
      openOverlay();
      renderSuggest();
    }
    if (location.hash === '#focus') {
      openOverlay();
    }
  }
  on(window, 'hashchange', function () {
    if (location.hash === '#focus') {
      openOverlay();
    }
  });
  initFromUrl();
})();
