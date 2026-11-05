/**
 * @fileoverview 设置页：显示（主题、布局、语言）、风格（调色板）、数字健康、桌面双栏。
 * （2026-10-23 PR-E：字体大小、减弱动效、重置所有设置删除；P4-2c：日期和时间、天气、快捷键连同高级功能分类删除）
 * 文案来自页面内 sgx-i18n-settings JSON（中英双语），JS 与语言无关。
 * 2026-10-24 页内切换（shell/inpage-tabs.js）：不再在 import 时直接跑，改成 mountSettings()，返回 destroy()；
 * 设置首页每次切进来都是服务器那份 HTML 的新拷贝 + 重新挂（同整页打开一样），切走时 destroy 拆掉本次挂的全部监听 / 定时器 / 撤销条。
 * 设置子页（/settings/<cat>/）由 entry-settings.js 照旧在加载时挂一次。
 */
import { on as evOn } from '../lib/events.js';
import { get } from '../lib/storage.js';
import { get as featGet, set as featSet, on as featOnRaw } from '../lib/features.js';
import { loadI18n } from '../lib/i18n.js';
import { openSheet } from '../shell/sheet.js';
import { setTheme, toggleFollowSystem, setPalette, palette, DEFAULT_PALETTE, setLayout, setLang, normLayout, layoutNarrow } from '../lib/prefs.js';
import { syncAccent } from '../lib/accent-roles.js';
import { accent } from '../lib/accent.js';
import { wellLoad, wellFlush } from '../shell/goodlock.js';
import { fmtDur } from '../lib/wb-view.js';
import { sgxReplace } from '../lib/diag-jumptrace.js';

/**
 * 挂设置页（设置首页 / 设置子页）。返回 destroy()：移除这次挂上的所有监听（含 features 订阅）、定时器、布局撤销条。
 * @returns {() => void}
 */
export function mountSettings() {
  /** @type {Array<() => void>} */
  const offs = [];
  /** 同 lib/events.js on()，但记下清理函数，destroy 时统一拆 @type {typeof evOn} */
  const on = function (t, type, fn, o) {
    const off = evOn(t, type, fn, o);
    offs.push(off);
    return off;
  };
  /** @param {string} id @param {(v: any) => void} fn */
  const featOn = function (id, fn) {
    const off = featOnRaw(id, fn);
    offs.push(off);
    return off;
  };
  const en = document.documentElement.lang === 'en';
  const T = loadI18n('sgx-i18n-settings');

  /** @param {string} id */
  function $(id) {
    return document.getElementById(id);
  }
  /** @param {string} id @param {boolean} on_ */
  function setSwitch(id, on_) {
    const el = $(id);
    if (el) el.setAttribute('aria-checked', on_ ? 'true' : 'false');
  }
  /** @param {string} id @param {() => void} fn */
  function rowToggle(id, fn) {
    const r = $(id);
    if (!r) return;
    on(r, 'click', fn);
    on(r, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fn();
      }
    });
  }

  /* 旧分类 hash（/settings/#display、#sg-theme、#goodlock 等）→ 对应子页。只在设置首页（中英）生效。
     2026-10-25 从 settings.html 的内联脚本搬进来（CSP：少一段要算 sha256 的内联脚本），逻辑不变。 */
  legacyHashRedirect();

  /* ---- 主题模式 ---- */
  function curMode() {
    return featGet('theme-mode');
  }
  function paintTheme() {
    const m = curMode();
    document.querySelectorAll('#theme-previews .theme-prev').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-mode') === m ? 'true' : 'false');
    });
    setSwitch('sw-system', m === 'system');
  }
  document.querySelectorAll('#theme-previews .theme-prev').forEach(function (b) {
    on(b, 'click', function () {
      setTheme(/** @type {any} */ (b.getAttribute('data-mode')));
      paintTheme();
    });
  });
  rowToggle('row-system', function () {
    toggleFollowSystem();
    paintTheme();
  });
  on(window, 'sgx-theme-changed', paintTheme);
  paintTheme();
  featOn('theme-mode', paintTheme);

  /* ---- 调色板（2026-10-23 PR-G 七色调色板：22 套一个列表、按组分组；默认 dustyblue） ---- */
  /* 色块 .pal-tile（#palette-dots 下，按 group 分组的网格）；上面的预览卡 #pal-preview 显示当前色板：
     选中后把色块 style 上的颜色变量（partials/palette-tile-vars.html）和名字拷到预览卡，两部小手机（浅色 / 深色）跟着换色。 */
  const SW_SEL = '#palette-dots .pal-tile';
  const preview = document.getElementById('pal-preview');
  const previewName = document.getElementById('pal-preview-name');
  function paintPreview(/** @type {string} */ p) {
    if (!preview) return;
    const tile = document.querySelector(SW_SEL + '[data-palette="' + p + '"]') || document.querySelector(SW_SEL + '[data-palette="' + DEFAULT_PALETTE + '"]');
    if (!tile) return;
    const st = tile.getAttribute('style') || '';
    if (preview.getAttribute('style') !== st) preview.setAttribute('style', st);
    if (previewName) previewName.textContent = tile.getAttribute('data-name') || '';
  }
  /* 标题右端「恢复默认」（#palette-reset）= 选默认色板（同一个 setPalette，自定义色一并清掉）；
     已是默认（且没有自定义主题色）时 aria-disabled 置灰、点了不动 */
  const palReset = document.getElementById('palette-reset');
  function paintPalette() {
    const p = palette();
    document.querySelectorAll(SW_SEL).forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-palette') === p ? 'true' : 'false');
    });
    paintPreview(p);
    if (palReset) palReset.setAttribute('aria-disabled', p === DEFAULT_PALETTE && !accent() ? 'true' : 'false');
  }
  if (palReset) {
    on(palReset, 'click', function () {
      if (palReset.getAttribute('aria-disabled') === 'true') return;
      setPalette(DEFAULT_PALETTE);
      paintPalette();
    });
  }
  document.querySelectorAll(SW_SEL).forEach(function (b) {
    on(b, 'click', function () {
      setPalette(b.getAttribute('data-palette') || DEFAULT_PALETTE);
      paintPalette();
    });
  });
  /* 自定义主题色（sgx-accent）：缓存缺失 / 过期时按种子重算整套角色（lib/palette-scheme.js） */
  syncAccent();
  paintPalette();
  featOn('palette', paintPalette);

  /* ---- 布局：Mobile / Auto / DeX ---- */
  function paintLayout() {
    let v = featGet('layout');
    /* 旧值 pc → dex；其他旧值（tablet/phone 等）一律回落到自动 */
    if (v !== 'auto' && v !== 'mobile' && v !== 'dex') {
      v = normLayout(v);
      featSet('layout', v);
    }
    /* 不够 DeX（宽 < 840 或高 < 500）：DeX 置灰，偏好保留，回到大屏再生效 */
    const isNarrow = layoutNarrow();
    const en = document.documentElement.lang === 'en';
    document.querySelectorAll('#seg-layout button').forEach(function (b) {
      const bv = b.getAttribute('data-v');
      b.setAttribute('aria-pressed', bv === v ? 'true' : 'false');
      if (bv === 'dex' && isNarrow) {
        b.setAttribute('disabled', 'disabled');
        b.setAttribute('title', en ? 'Large screens only' : '仅在大屏生效');
      } else {
        b.removeAttribute('disabled');
        b.removeAttribute('title');
      }
    });
    // 不够 DeX 的提示
    let hint = document.getElementById('seg-layout-narrow-hint');
    if (isNarrow) {
      if (!hint) {
        hint = document.createElement('p');
        hint.id = 'seg-layout-narrow-hint';
        hint.className = 'text-[12px] opacity-60 mt-1';
        hint.textContent = en ? 'DeX only works on large screens (not met here)' : 'DeX 仅在大屏生效（当前不满足）';
        const seg = document.getElementById('seg-layout');
        if (seg && seg.parentNode) seg.parentNode.appendChild(hint);
      }
    } else if (hint) {
      hint.remove();
    }
  }
  /* 2.9.2：布局切换 snackbar（含 10 秒撤销） */
  let layoutUndoTimer = null;
  function showLayoutSnackbar(newV, oldV) {
    // 清掉旧的
    const old = document.getElementById('sgx-layout-snackbar');
    if (old) old.remove();
    if (layoutUndoTimer) { clearTimeout(layoutUndoTimer); layoutUndoTimer = null; }
    const names = { auto: 'Auto', mobile: 'Mobile', dex: 'DeX' };
    const bar = document.createElement('div');
    bar.id = 'sgx-layout-snackbar';
    bar.setAttribute('role', 'status');
    bar.innerHTML = '<span>已切换为 ' + (names[newV] || newV) + ' 布局</span>' +
      '<button type="button" id="sgx-layout-undo">撤销</button>';
    document.body.appendChild(bar);
    // 10 秒后自动消失
    layoutUndoTimer = setTimeout(function () {
      bar.remove();
      layoutUndoTimer = null;
    }, 10000);
    on(/** @type {HTMLElement} */ (document.getElementById('sgx-layout-undo')), 'click', function () {
      setLayout(oldV);
      paintLayout();
      bar.remove();
      if (layoutUndoTimer) { clearTimeout(layoutUndoTimer); layoutUndoTimer = null; }
    });
  }

  document.querySelectorAll('#seg-layout button').forEach(function (b) {
    on(b, 'click', function () {
      const v = b.getAttribute('data-v') || 'auto';
      const oldV = featGet('layout') || 'auto';
      if (v === oldV) return;
      setLayout(v);
      paintLayout();
      showLayoutSnackbar(v, oldV);
    });
  });
  paintLayout();
  featOn('layout', paintLayout);

  /* ---- 语言（显示）行：当前值 ---- */
  function paintManage() {
    const lv = $('lang-val');
    if (lv) {
      const v = langVal();
      lv.textContent = v === 'system' ? T.t('langSystem') : v === 'en' ? 'English' : '中文';
    }
  }
  paintManage();

  /* ---- 语言 ---- */
  function langVal() {
    const v = get('sgx-lang');
    if (v === 'zh') return 'zh';
    if (v === 'en') return 'en';
    return 'system';
  }
  rowToggle('row-lang', function () {
    const cur = langVal();
    openSheet({
      title: T.t('langTitle'),
      options: [
        { label: T.t('langSystem'), value: 'system', checked: cur === 'system' },
        { label: '中文', value: 'zh', checked: cur === 'zh' },
        { label: 'English', value: 'en', checked: cur === 'en' },
      ],
      onPick: function (v) {
        /* 写偏好并跳到对应语言版本（保留查询参数与 hash），replace 不产生历史 */
        sgxReplace(setLang(/** @type {any} */ (v)));
      },
    });
  });

  /* ---- 数字健康：时长提示 ---- */
  function paintWellTip() {
    setSwitch('sw-welltip', !!featGet('well-tip'));
  }
  rowToggle('row-welltip', function () {
    featSet('well-tip', !featGet('well-tip'));
    paintWellTip();
  });
  paintWellTip();
  featOn('well-tip', paintWellTip);
  /* 屏幕时间卡（2026-10-23 PR-E 两张并一张）：先画本机记录（sgx-well-v）；core 的 loadWb() 拉到 /api/wellbeing 且 detail:true
     （账号已登录，P2-2）时覆盖同一组 [data-wb] 槽位并把范围改成「所有设备」；detail:false 就保持本机记录（卡上的 data-wb-detail，lib/wb-view.js wbFits）。
     不看锁屏进门方式。 */
  (function () {
    const card = $('wb-card');
    if (!card) return;
    const q = function (/** @type {string} */ n) {
      return /** @type {HTMLElement|null} */ (card.querySelector('[data-wb="' + n + '"]'));
    };
    const totalEl = q('total'),
      bar = q('bar'),
      legend = q('legend');
    if (!totalEl || !bar) return;
    let v = wellLoad();
    try {
      v = wellFlush();
    } catch (e) {}
    const ar = v.areas || {};
    /* 旧数据：'goodlock' 区域（原 Good Lock 页）并进设置；搜索页的区域键是 'browser'（更早是 'links'） */
    const mins = {
      home: ar.home || 0,
      links: (ar.browser || 0) + (ar.links || 0),
      settings: (ar.settings || 0) + (ar.goodlock || 0),
    };
    const total = Math.max(0, v.min || 0);
    totalEl.textContent = fmtDur(total * 60, en, true);
    const AREAS = [
      { id: 'home', label: T.t('areaHome'), color: 'var(--m-primary-fill, var(--m-primary))' },
      { id: 'links', label: T.t('areaLinks'), color: 'var(--m-accent)' },
      { id: 'settings', label: T.t('areaSettings'), color: 'var(--sgx-secondary-fill, var(--m-secondary))' },
    ];
    if (total < 1) {
      bar.innerHTML = '<span style="width:100%;background:var(--m-container-highest)"></span>';
      if (legend) legend.innerHTML = '<span>' + T.t('wellNoRec') + '</span>';
      return;
    }
    bar.innerHTML = AREAS.map(function (a) {
      const pct = Math.max(0, (/** @type {any} */ (mins)[a.id] / total) * 100);
      return '<span style="width:' + pct.toFixed(1) + '%;background:' + a.color + '" title="' + a.label + '"></span>';
    }).join('');
    if (legend)
      legend.innerHTML = AREAS.map(function (a) {
        return (
          '<span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-full" style="background:' + a.color + '"></span>' + a.label + '</span>'
        );
      }).join('');
  })();

  /* 2.6.0：设置改为真实二级页（/settings/<cat>/）；旧 hash 由设置首页内联脚本跳转到子页；
     子页用浏览器 / 系统返回。DeX 双栏在首页内切换（下）。 */
  /* ---- 2.6.0 DeX 双栏：左导航切换右窗格（复用子页同一套 partial；无 JS 时导航照常跳子页） ---- */
  (function () {
    var nav = document.getElementById('set-cat-nav');
    var layout = document.querySelector('.set-layout');
    if (!nav || !layout) return;
    var panes = document.getElementById('set-panes');
    if (!panes) return;
    var isWide = document.documentElement.classList.contains('layout-dex');
    function showPane(id, title) {
      var groups = panes.querySelectorAll('.set-group');
      groups.forEach(function (g) {
        g.classList.toggle('active', g.id === 'sg-' + id);
      });
      nav.querySelectorAll('.set-cat').forEach(function (b) {
        var on_ = b.getAttribute('data-cat') === id;
        b.classList.toggle('active', on_);
        if (on_) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      });
      var rt = document.getElementById('set-right-title');
      if (rt && title) rt.textContent = title;
      layout.classList.add('single-cat');
    }
    on(nav, 'click', function (/** @type {any} */ e) {
      var b = e.target && e.target.closest ? e.target.closest('.set-cat') : null;
      if (!b) return;
      var id = b.getAttribute('data-cat') || '';
      if (id === 'security' || id === 'status') return; /* 独立页面，不拦截 */
      if (!isWide) return; /* 移动端没有双栏（导航隐藏），照常跳转 */
      e.preventDefault();
      showPane(id, b.getAttribute('data-title') || '');
    });
    if (isWide) showPane('display', (nav.querySelector('[data-cat="display"]') || {}).getAttribute ? nav.querySelector('[data-cat="display"]').getAttribute('data-title') : '');
  })();

  return function destroy() {
    offs.splice(0).forEach(function (f) {
      try {
        f();
      } catch (e) {}
    });
    if (layoutUndoTimer) {
      clearTimeout(layoutUndoTimer);
      layoutUndoTimer = null;
    }
    const bar = document.getElementById('sgx-layout-snackbar');
    if (bar) bar.remove();
  };
}

/* 旧分类 hash → 设置子页（2.6.0 起设置是真实二级页）。manage / accessibility 已删除（回设置首页，不跳）；
   P4-2c：高级功能分类（含原 goodlock）删除，同样回设置首页、不跳。 */
const LEGACY_HASH = /** @type {Record<string, 1|string>} */ ({
  display: 1, theme: 1, wellbeing: 1, about: 1, security: 1,
  'sg-display': 'display', 'sg-theme': 'theme',
  'sg-wellbeing': 'wellbeing', 'sg-about': 'about', 'sg-security': 'security',
});

/** 设置首页（/settings/、/en/settings/）带旧分类 hash 时 replace 到子页（不留历史） */
export function legacyHashRedirect() {
  try {
    const p = location.pathname;
    if (p !== '/settings/' && p !== '/en/settings/') return;
    const h = (location.hash || '').replace(/^#/, '');
    const cat = Object.prototype.hasOwnProperty.call(LEGACY_HASH, h) ? LEGACY_HASH[h] : null;
    if (!cat) return;
    const base = p.indexOf('/en/') === 0 ? '/en/settings/' : '/settings/';
    sgxReplace(base + (cat === 1 ? h : cat) + '/');
  } catch (e) {}
}
