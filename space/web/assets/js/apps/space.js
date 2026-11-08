/**
 * @fileoverview 旷野页（/）与子页（/theme/、/wellbeing/、/about/）：风格（调色板）、数字健康。
 * P4-3 PR-4b（2026-11-07，Gray）：显示页（/display/）整页删除——深色 / 跟随系统 / 语言 / 布局都在快捷面板（共享外壳），这里不再有主题模式、布局、语言三段。
 * P4-3 PR-4b（2026-11-07）：由 apps/settings.js 改名；主页和设置合成「旷野 / Space」一页，页内切换、DeX 双栏、旧 hash 跳转删除。
 * （2026-10-23 PR-E：字体大小、减弱动效、重置所有设置删除；P4-2c：日期和时间、天气、快捷键连同高级功能分类删除）
 * 文案来自页面内 sgx-i18n-space JSON（中英双语），JS 与语言无关。
 * mountSpace() 在加载时挂一次（入口 entry-space.js / entry-space-sub.js），返回 destroy()：拆掉本次挂的全部监听。
 */
import { on as evOn } from '../lib/events.js';
import { get as featGet, set as featSet, on as featOnRaw } from '../lib/features.js';
import { loadI18n } from '../lib/i18n.js';
import { setPalette, palette, DEFAULT_PALETTE } from '../lib/prefs.js';
import { syncAccent } from '../lib/accent-roles.js';
import { accent } from '../lib/accent.js';
import { wellLoad, wellFlush } from '../shell/goodlock.js';
import { fmtDur } from '../lib/wb-view.js';

/**
 * 挂旷野页 / 旷野子页。返回 destroy()：移除这次挂上的所有监听（含 features 订阅）。
 * @returns {() => void}
 */
export function mountSpace() {
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
  const T = loadI18n('sgx-i18n-space');

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

  /* ---- 调色板（2026-10-23 PR-G 七色调色板：22 套一个列表、按组分组；默认 terra，2026-11 PR-A 前 dustyblue） ---- */
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
    /* 读旧写新（P4-3 PR-4b）：旧区域键 'home'（主页）、'settings'（设置）和更早的 'goodlock'（原 Good Lock 页）并进旷野 'space'；
       搜索页的区域键是 'browser'（更早是 'links'） */
    const mins = {
      space: (ar.space || 0) + (ar.home || 0) + (ar.settings || 0) + (ar.goodlock || 0),
      links: (ar.browser || 0) + (ar.links || 0),
    };
    const total = Math.max(0, v.min || 0);
    totalEl.textContent = fmtDur(total * 60, en, true);
    const AREAS = [
      { id: 'space', label: T.t('areaSpace'), color: 'var(--m-primary-fill, var(--m-primary))' },
      { id: 'links', label: T.t('areaLinks'), color: 'var(--m-accent)' },
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

  return function destroy() {
    offs.splice(0).forEach(function (f) {
      try {
        f();
      } catch (e) {}
    });
  };
}
