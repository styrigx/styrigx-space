/**
 * @fileoverview 设置页：主题、主色、字体、布局、搜索引擎、常规管理、应用面板、
 * 减弱动效、数字健康、重置、桌面双栏、设置搜索。
 * 文案来自页面内 sgx-i18n-settings JSON（中英双语），JS 与语言无关。
 */
import { on } from '../lib/events.js';
import { esc } from '../lib/util.js';
import { get, set } from '../lib/storage.js';
import { get as featGet, set as featSet, on as featOn } from '../lib/features.js';
import { loadI18n } from '../lib/i18n.js';
import { openSheet, closeSheet } from '../shell/sheet.js';
import { setThemeMode } from '../lib/theme.js';
import { engines } from '../shell/engines.js';
import { getHiddenApps } from '../shell/appvis.js';
import { wellLoad, wellFlush } from '../shell/goodlock.js';
import { setCapSearchProvider } from '../shell/capsule.js';

(function () {
  const en = document.documentElement.lang === 'en';
  const T = loadI18n('sgx-i18n-settings');
  /** @type {any} */
  let RAW = {};
  try {
    RAW = JSON.parse(document.getElementById('sgx-i18n-settings').textContent || '{}');
  } catch (e) {}
  const APPS_TOTAL = RAW.appsTotal || 0;
  const APP_LINKS = {
    files: RAW.linkFiles || '/files/',
    store: RAW.linkStore || '/store/',
    browser: RAW.linkBrowser || '/browser/',
  };

  /** @param {string} id */
  function $(id) {
    return document.getElementById(id);
  }
  const CHEVR =
    '<svg width="18" height="18" class="w-[18px] h-[18px] text-m-on-surface-variant shrink-0" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"/></svg>';
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
  const appSheetRow = rowToggle;

  /* ---- 时区列表（两边共用） ---- */
  const TZS = [
    { id: 'Asia/Shanghai', zh: '北京', en: 'Beijing' },
    { id: 'Asia/Taipei', zh: '台北', en: 'Taipei' },
    { id: 'Asia/Hong_Kong', zh: '香港', en: 'Hong Kong' },
    { id: 'Asia/Tokyo', zh: '东京', en: 'Tokyo' },
    { id: 'Asia/Seoul', zh: '首尔', en: 'Seoul' },
    { id: 'Asia/Singapore', zh: '新加坡', en: 'Singapore' },
    { id: 'Asia/Bangkok', zh: '曼谷', en: 'Bangkok' },
    { id: 'Asia/Dubai', zh: '迪拜', en: 'Dubai' },
    { id: 'Asia/Kolkata', zh: '加尔各答', en: 'Kolkata' },
    { id: 'Asia/Karachi', zh: '卡拉奇', en: 'Karachi' },
    { id: 'Europe/Moscow', zh: '莫斯科', en: 'Moscow' },
    { id: 'Europe/Berlin', zh: '柏林', en: 'Berlin' },
    { id: 'Europe/Paris', zh: '巴黎', en: 'Paris' },
    { id: 'Europe/London', zh: '伦敦', en: 'London' },
    { id: 'America/New_York', zh: '纽约', en: 'New York' },
    { id: 'America/Chicago', zh: '芝加哥', en: 'Chicago' },
    { id: 'America/Denver', zh: '丹佛', en: 'Denver' },
    { id: 'America/Los_Angeles', zh: '洛杉矶', en: 'Los Angeles' },
    { id: 'America/Anchorage', zh: '安克雷奇', en: 'Anchorage' },
    { id: 'Pacific/Honolulu', zh: '檀香山', en: 'Honolulu' },
    { id: 'America/Toronto', zh: '多伦多', en: 'Toronto' },
    { id: 'America/Vancouver', zh: '温哥华', en: 'Vancouver' },
    { id: 'Australia/Sydney', zh: '悉尼', en: 'Sydney' },
    { id: 'Pacific/Auckland', zh: '奥克兰', en: 'Auckland' },
  ];
  /** @param {string} id */
  function tzLabel(id) {
    for (let i = 0; i < TZS.length; i++) {
      if (TZS[i].id === id) return en ? TZS[i].en : TZS[i].zh;
    }
    return String(id).split('/').pop().replace(/_/g, ' ');
  }
  function deviceTz() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (e) {
      return 'UTC';
    }
  }
  function tz1auto() {
    return !!featGet('tz1-auto');
  }
  function firstCity() {
    return tz1auto() ? tzLabel(deviceTz()) : tzLabel(featGet('tz1'));
  }
  function secondCity() {
    return tzLabel(featGet('tz2'));
  }

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
      setThemeMode(/** @type {any} */ (b.getAttribute('data-mode')));
      paintTheme();
    });
  });
  rowToggle('row-system', function () {
    const m = curMode();
    if (m === 'system') setThemeMode(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    else setThemeMode('system');
    paintTheme();
  });
  on(window, 'sgx-theme-changed', paintTheme);
  paintTheme();
  featOn('theme-mode', paintTheme);

  /* ---- 主色色板（第一个 = 默认，即头像取色） ---- */
  function curPalette() {
    return featGet('palette');
  }
  function paintPalette() {
    const p = curPalette();
    document.querySelectorAll('#palette-dots .swatch').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-palette') === p ? 'true' : 'false');
    });
  }
  document.querySelectorAll('#palette-dots .swatch').forEach(function (b) {
    on(b, 'click', function () {
      const p = b.getAttribute('data-palette') || 'lake';
      featSet('palette', p);
      const d = document.documentElement;
      if (p === 'lake') d.removeAttribute('data-palette');
      else d.setAttribute('data-palette', p);
      paintPalette();
      window.dispatchEvent(new Event('sgx-settings-changed'));
    });
  });
  paintPalette();
  featOn('palette', paintPalette);

  /* ---- 字体大小 ---- */
  function paintFont() {
    const v = featGet('font-size');
    document.querySelectorAll('#seg-font button').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-v') === v ? 'true' : 'false');
    });
  }
  document.querySelectorAll('#seg-font button').forEach(function (b) {
    on(b, 'click', function () {
      const v = b.getAttribute('data-v') || 'standard';
      featSet('font-size', v);
      const d = document.documentElement;
      d.style.fontSize = v === 'large' ? '112.5%' : v === 'small' ? '87.5%' : '';
      paintFont();
    });
  });
  paintFont();
  featOn('font-size', paintFont);

  /* ---- 布局：自动 / Mobile / DeX / PC ---- */
  function paintLayout() {
    let v = featGet('layout');
    /* 2.5.0：旧值（tablet/phone 等）一律回落到自动 */
    if (v !== 'auto' && v !== 'mobile' && v !== 'dex' && v !== 'pc') {
      v = 'auto';
      featSet('layout', 'auto');
    }
    document.querySelectorAll('#seg-layout button').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-v') === v ? 'true' : 'false');
    });
  }
  document.querySelectorAll('#seg-layout button').forEach(function (b) {
    on(b, 'click', function () {
      const v = b.getAttribute('data-v') || 'auto';
      featSet('layout', v);
      paintLayout();
      const w = /** @type {any} */ (window);
      if (w.__applyLayout) w.__applyLayout();
      window.dispatchEvent(new Event('sgx-settings-changed'));
    });
  });
  paintLayout();
  featOn('layout', paintLayout);

  /* ---- 搜索引擎（定义走共享模块 sgx/engines.js，与浏览器页共用同一个 localStorage key） ---- */
  const SE = engines;
  function engineName() {
    return SE.name(SE.cur());
  }

  /* ---- 常规管理行：当前值 ---- */
  function paintManage() {
    const lv = $('lang-val');
    if (lv) {
      const v = langVal();
      lv.textContent = v === 'system' ? T.t('langSystem') : v === 'en' ? 'English' : '中文';
    }
    const dt = $('dt-val');
    if (dt) dt.textContent = firstCity() + ' · ' + secondCity();
    const wx = $('wx-val');
    if (wx) wx.textContent = featGet('temp-unit') === 'f' ? '℉' : '℃';
  }
  paintManage();

  /* ---- 语言 ---- */
  function langVal() {
    try {
      const v = localStorage.getItem('sgx-lang');
      if (v === 'zh') return 'zh';
      if (v === 'en') return 'en';
      return 'system';
    } catch (e) {
      return 'system';
    }
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
        try {
          if (v === 'system') localStorage.removeItem('sgx-lang');
          else localStorage.setItem('sgx-lang', v);
        } catch (e) {}
        featSet('lang', v === 'system' ? 'system' : v);
        /* 跳到对应语言版本，保留查询参数与 hash，用 replace 不产生历史 */
        const p = location.pathname,
          q = location.search,
          h = location.hash;
        let want = v;
        if (v === 'system') {
          try {
            const bl = (navigator.language || navigator.userLanguage || 'zh').toLowerCase();
            want = bl.indexOf('zh') === 0 ? 'zh' : 'en';
          } catch (e) {
            want = 'zh';
          }
        }
        let np;
        if (want === 'en') {
          np = p === '/' ? '/en/' : p === '/en' || p.indexOf('/en/') === 0 ? p : '/en' + p;
        } else {
          np = p.replace(/^\/en(\/|$)/, '/');
          if (np === '' || np.charAt(0) !== '/') np = '/';
        }
        location.replace(np + q + h);
      },
    });
  });

  /* ---- 日期和时间 ---- */
  function openDateTime() {
    const auto = tz1auto();
    const tz1cur = featGet('tz1');
    const h12 = featGet('hour12') === '12';
    const html =
      '<div class="px-1 pb-2">' +
      '<div class="set-row no-ic" id="dt-auto" role="button" tabindex="0">' +
      '<span class="flex-1 min-w-0"><span class="block font-medium">' + T.t('dtAuto') + '</span>' +
      '<span class="block text-xs text-m-on-surface-variant mt-0.5">' + T.t('dtAutoSub') + '</span></span>' +
      '<span class="switch" id="dt-auto-sw" role="switch" aria-checked="' + (auto ? 'true' : 'false') + '" aria-label="' + T.t('dtUseLocal') + '"><span class="knob"></span></span></div>' +
      '<div class="set-row no-ic' + (auto ? ' is-disabled' : '') + '" id="dt-tz1" role="button" tabindex="0">' +
      '<span class="flex-1 font-medium">' + T.t('dtTz1') + '</span>' +
      '<span class="text-sm text-m-on-surface-variant">' + esc(auto ? tzLabel(deviceTz()) : tzLabel(tz1cur)) + '</span>' + CHEVR + '</div>' +
      '<div class="set-row no-ic" id="dt-tz2" role="button" tabindex="0">' +
      '<span class="flex-1 font-medium">' + T.t('dtTz2') + '</span>' +
      '<span class="text-sm text-m-on-surface-variant">' + esc(secondCity()) + '</span>' + CHEVR + '</div>' +
      '<div class="px-5 py-4"><p class="text-sm font-medium mb-3">' + T.t('dtHour') + '</p>' +
      '<div class="seg" id="dt-hour" role="group" aria-label="' + T.t('dtHour') + '">' +
      '<button type="button" data-v="12" aria-pressed="' + (h12 ? 'true' : 'false') + '">' + T.t('dt12') + '</button>' +
      '<button type="button" data-v="24" aria-pressed="' + (h12 ? 'false' : 'true') + '">' + T.t('dt24') + '</button>' +
      '</div></div>' +
      '<p class="px-5 pb-3 text-xs text-m-on-surface-variant">' + T.t('dtNote') + '</p>' +
      '</div>';
    openSheet({ title: T.t('dtTitle'), html: html });
    const sheetRow = rowToggle;
    (function rewire() {
      sheetRow('dt-auto', function () {
        const on_ = !tz1auto();
        featSet('tz1-auto', on_);
        paintManage();
        window.dispatchEvent(new Event('sgx-settings-changed'));
        openDateTime();
      });
      if (!tz1auto()) {
        sheetRow('dt-tz1', function () {
          openTzPicker('sgx-tz1', openDateTime);
        });
      }
      document.querySelectorAll('#dt-hour button').forEach(function (b) {
        on(b, 'click', function () {
          featSet('hour12', b.getAttribute('data-v'));
          document.querySelectorAll('#dt-hour button').forEach(function (x) {
            x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
          });
          window.dispatchEvent(new Event('sgx-settings-changed'));
        });
      });
      sheetRow('dt-tz2', function () {
        openTzPicker('sgx-tz2', openDateTime);
      });
    })();
  }
  rowToggle('row-datetime', openDateTime);

  /* ---- 时区选择器（顶部带搜索） ---- */
  /** @param {string} key @param {() => void} back */
  function openTzPicker(key, back) {
    const cur = key === 'sgx-tz1' ? featGet('tz1') : featGet('tz2');
    const html =
      '<div class="px-1 pb-2">' +
      '<div class="px-4 pb-2"><input id="tzp-q" type="search" autocomplete="off" placeholder="' + T.t('tzpPh') + '" aria-label="' + T.t('tzpAria') + '"' +
      ' class="w-full rounded-full border border-m-outline bg-m-container px-5 py-2.5 text-sm outline-none placeholder:text-m-on-surface-variant focus:border-m-primary"></div>' +
      '<div id="tzp-list"></div></div>';
    openSheet({ title: T.t('tzpTitle'), html: html });
    /** @param {string} q */
    function renderList(q) {
      q = (q || '').toLowerCase();
      const list = TZS.filter(function (t) {
        return !q || t.id.toLowerCase().indexOf(q) >= 0 || t.zh.indexOf(q) >= 0 || t.en.toLowerCase().indexOf(q) >= 0;
      });
      const box = $('tzp-list');
      if (!box) return;
      box.innerHTML = list.length
        ? list
            .map(function (t) {
              const lb = en ? t.en : t.zh;
              return (
                '<button type="button" class="sheet-opt" data-tz="' + t.id + '">' +
                '<span class="flex-1 min-w-0"><span class="block font-medium truncate">' + esc(lb) + '</span>' +
                '<span class="block text-xs text-m-on-surface-variant truncate">' + t.id + '</span></span>' +
                (t.id === cur ? '<span class="text-m-primary">✓</span>' : '') + '</button>'
              );
            })
            .join('')
        : '<p class="px-5 py-4 text-sm text-m-on-surface-variant text-center">' + T.t('tzpNo') + '</p>';
      box.querySelectorAll('.sheet-opt').forEach(function (b) {
        on(b, 'click', function () {
          featSet(key === 'sgx-tz1' ? 'tz1' : 'tz2', b.getAttribute('data-tz'));
          paintManage();
          window.dispatchEvent(new Event('sgx-settings-changed'));
          back();
        });
      });
    }
    renderList('');
    const qi = /** @type {HTMLInputElement|null} */ ($('tzp-q'));
    if (qi) on(qi, 'input', function () {
      renderList(qi.value.trim());
    });
    window.setTimeout(function () {
      if (qi) qi.focus();
    }, 300);
  }

  /* ---- 天气 ---- */
  function wxLocMode() {
    try {
      return localStorage.getItem('sgx-weather-loc') || 'auto';
    } catch (e) {
      return 'auto';
    }
  }
  function wxCityName() {
    try {
      const c = JSON.parse(localStorage.getItem('sgx-weather-city') || 'null');
      return (c && c.name) || '';
    } catch (e) {
      return '';
    }
  }
  function openWeather() {
    const show = !!featGet('weather-show');
    const unit = featGet('temp-unit') === 'f' ? 'f' : 'c';
    const locMode = wxLocMode();
    const cityName = wxCityName();
    const html =
      '<div class="px-1 pb-2">' +
      '<div class="set-row no-ic" id="wx-show" role="button" tabindex="0">' +
      '<span class="flex-1 font-medium">' + T.t('wxShow') + '</span>' +
      '<span class="switch" id="wx-show-sw" role="switch" aria-checked="' + (show ? 'true' : 'false') + '"><span class="knob"></span></span></div>' +
      '<div class="px-5 py-4"><p class="text-sm font-medium mb-3">' + T.t('wxUnit') + '</p>' +
      '<div class="seg" id="wx-unit" role="group" aria-label="' + T.t('wxUnit') + '">' +
      '<button type="button" data-v="c" aria-pressed="' + (unit === 'c' ? 'true' : 'false') + '">℃</button>' +
      '<button type="button" data-v="f" aria-pressed="' + (unit === 'f' ? 'true' : 'false') + '">℉</button>' +
      '</div></div>' +
      '<div class="px-5 py-4"><p class="text-sm font-medium mb-3">' + T.t('wxLoc') + '</p>' +
      '<div class="seg" id="wx-loc" role="group" aria-label="' + T.t('wxLoc') + '">' +
      '<button type="button" data-v="auto" aria-pressed="' + (locMode === 'auto' ? 'true' : 'false') + '">' + T.t('wxLocAuto') + '</button>' +
      '<button type="button" data-v="manual" aria-pressed="' + (locMode === 'manual' ? 'true' : 'false') + '">' + T.t('wxLocManual') + '</button>' +
      '</div>' +
      '<div id="wx-city-wrap" class="mt-3" style="' + (locMode === 'manual' ? '' : 'display:none') + '">' +
      '<input type="text" id="wx-city-input" class="w-full px-3 py-2 rounded-lg border border-m-outline bg-m-surface text-sm" placeholder="' + T.t('wxCityPh') + '" value="' + cityName.replace(/"/g, '&quot;') + '">' +
      '</div>' +
      '<button type="button" id="wx-precise" class="mt-3 w-full px-3 py-2 rounded-lg border border-m-outline text-sm font-medium">' +
      T.t('wxLocPrecise') + '<span class="block text-xs opacity-60 font-normal">' + T.t('wxLocPreciseDesc') + '</span></button>' +
      '</div></div>';
    openSheet({ title: T.t('wxTitle'), html: html });
    const sheetRow2 = rowToggle;
    sheetRow2('wx-show', function () {
      const on_ = !featGet('weather-show');
      featSet('weather-show', on_);
      setSwitch('wx-show-sw', on_);
      paintManage();
      window.dispatchEvent(new Event('sgx-settings-changed'));
    });
    document.querySelectorAll('#wx-unit button').forEach(function (b) {
      on(b, 'click', function () {
        featSet('temp-unit', b.getAttribute('data-v'));
        document.querySelectorAll('#wx-unit button').forEach(function (x) {
          x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
        });
        paintManage();
        window.dispatchEvent(new Event('sgx-settings-changed'));
      });
    });
    /* 位置模式切换 */
    document.querySelectorAll('#wx-loc button').forEach(function (b) {
      on(b, 'click', function () {
        const v = b.getAttribute('data-v');
        try {
          localStorage.setItem('sgx-weather-loc', v);
        } catch (e) {}
        document.querySelectorAll('#wx-loc button').forEach(function (x) {
          x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
        });
        const wrap = document.getElementById('wx-city-wrap');
        if (wrap) wrap.style.display = v === 'manual' ? '' : 'none';
        /* 清除天气缓存，触发重新获取 */
        try {
          localStorage.removeItem('sgx-weather');
        } catch (e) {}
        window.dispatchEvent(new Event('sgx-settings-changed'));
      });
    });
    /* 手动城市输入 */
    const cityInput = document.getElementById('wx-city-input');
    if (cityInput) {
      let cityTimer = null;
      on(cityInput, 'input', function () {
        if (cityTimer) clearTimeout(cityTimer);
        cityTimer = setTimeout(function () {
          const name = cityInput.value.trim();
          if (!name) return;
          /* 用 open-meteo geocoding API 解析城市名（免费，无需密钥） */
          fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(name) + '&count=1&language=zh&format=json')
            .then(function (r) { return r.json(); })
            .then(function (j) {
              if (j.results && j.results[0]) {
                const g = j.results[0];
                try {
                  localStorage.setItem('sgx-weather-city', JSON.stringify({
                    name: g.name,
                    lat: g.latitude,
                    lon: g.longitude,
                  }));
                  localStorage.removeItem('sgx-weather');
                } catch (e) {}
                window.dispatchEvent(new Event('sgx-settings-changed'));
              }
            })
            .catch(function () {});
        }, 800);
      });
    }
    /* 精确定位（仅用户点击时触发，不自动弹权限） */
    const preciseBtn = document.getElementById('wx-precise');
    if (preciseBtn) {
      on(preciseBtn, 'click', function () {
        if (!navigator.geolocation) return;
        const orig = preciseBtn.innerHTML;
        preciseBtn.innerHTML = T.t('wxLocating');
        preciseBtn.disabled = true;
        navigator.geolocation.getCurrentPosition(
          function (pos) {
            try {
              localStorage.setItem('sgx-weather-precise', JSON.stringify({
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                ts: Date.now(),
              }));
              localStorage.setItem('sgx-weather-loc', 'precise');
              localStorage.removeItem('sgx-weather');
            } catch (e) {}
            window.dispatchEvent(new Event('sgx-settings-changed'));
            preciseBtn.innerHTML = orig;
            preciseBtn.disabled = false;
          },
          function () {
            preciseBtn.innerHTML = orig;
            preciseBtn.disabled = false;
          },
          { timeout: 10000, maximumAge: 600000 }
        );
      });
    }
  }
  rowToggle('row-weather', openWeather);

  /* ================= 应用：我的文件 / 应用商店 / 浏览器 ================= */
  function addrbarPos() {
    const p = featGet('addrbar-pos');
    return p === 'top' ? 'top' : 'bottom';
  }
  function filesView() {
    const v = featGet('files-view');
    return v && typeof v === 'object' ? v : {};
  }
  function paintApps() {
    const v = filesView();
    const layout = v.layout === 'grid' ? 'grid' : 'list';
    const f1 = $('app-files-val');
    if (f1) f1.textContent = T.t(layout === 'grid' ? 'gridViewVal' : 'listViewVal');
    const h = getHiddenApps(),
      inst = APPS_TOTAL - h.length;
    const f2 = $('app-store-val');
    if (f2) f2.textContent = T.fmt('storeCounts', { i: inst, u: h.length });
    const f3 = $('app-browser-val');
    if (f3) f3.textContent = engineName() + ' · ' + T.t(addrbarPos() === 'top' ? 'posTop' : 'posBottom');
    /* 浏览器面板开着时，引擎行标签实时同步（跨标签页 storage 事件同样走这里） */
    const apb = $('apb-engine');
    if (apb) {
      const lbl = apb.querySelector('.text-sm');
      if (lbl) lbl.textContent = engineName();
    }
  }
  /* 二次确认按钮：第一次点击变红字确认态，3 秒内再点执行 */
  /** @param {HTMLElement|null} btn @param {string} confirmLabel @param {() => void} fn */
  function armConfirm(btn, confirmLabel, fn) {
    if (!btn) return;
    let armed = false,
      timer = null;
    const orig = btn.innerHTML;
    on(btn, 'click', function (e) {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        btn.innerHTML = '<span class="font-medium" style="color:#dc2626">' + esc(confirmLabel) + '</span>';
        timer = window.setTimeout(function () {
          armed = false;
          btn.innerHTML = orig;
        }, 3000);
      } else {
        if (timer) clearTimeout(timer);
        fn();
      }
    });
  }
  /**
   * @param {string} id
   * @param {Array<{v: string, label: string}>} options
   * @param {string} cur
   */
  function sheetSeg(id, options, cur) {
    return (
      '<div class="seg" id="' + id + '" role="group">' +
      options
        .map(function (o) {
          return (
            '<button type="button" data-v="' + o.v + '" aria-pressed="' + (o.v === cur ? 'true' : 'false') + '">' +
            esc(o.label) + '</button>'
          );
        })
        .join('') +
      '</div>'
    );
  }
  /** @param {string} id @param {(v: string) => void} onPick */
  function wireSeg(id, onPick) {
    document.querySelectorAll('#' + id + ' button').forEach(function (b) {
      on(b, 'click', function () {
        const v = b.getAttribute('data-v') || '';
        document.querySelectorAll('#' + id + ' button').forEach(function (x) {
          x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
        });
        onPick(v);
      });
    });
  }
  /** @param {string} [itemId] */
  function hlInSheet(itemId) {
    if (!itemId) return;
    window.setTimeout(function () {
      const el = document.querySelector('#sheet-body #' + itemId);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: reducedM ? 'auto' : 'smooth' });
        el.classList.add('set-hl');
        window.setTimeout(function () {
          el.classList.remove('set-hl');
        }, 1400);
      }
    }, 320);
  }
  /** @param {string} key @param {string} label */
  function appOpenLink(key, label) {
    return (
      '<a class="set-row no-ic" href="' + APP_LINKS[key] + '">' +
      '<span class="flex-1 font-medium text-m-primary">' + esc(label) + '</span>' + CHEVR + '</a>'
    );
  }

  /* ---- 我的文件面板 ---- */
  /** @param {string} [hl] */
  function openFilesPanel(hl) {
    const v = filesView();
    const layout = v.layout === 'grid' ? 'grid' : 'list';
    const sort = v.sort === 'name' ? 'name' : 'added';
    /** @type {Record<string, any>} */
    let home = featGet('files-home') || {};
    const GROUPS = [
      { id: 'cats', label: T.t('gCats') },
      { id: 'sites', label: T.t('gSites') },
      { id: 'recent', label: T.t('gRecent') },
      { id: 'storage', label: T.t('gStorage') },
      { id: 'fav', label: T.t('gFav') },
    ];
    const html =
      '<div class="px-1 pb-2">' +
      '<div class="px-5 py-4" id="apf-view"><p class="text-sm font-medium mb-3">' + T.t('filesView') + '</p>' +
      sheetSeg('apf-view-seg', [{ v: 'list', label: T.t('viewList') }, { v: 'grid', label: T.t('viewGrid') }], layout) + '</div>' +
      '<div class="px-5 py-4" id="apf-sort"><p class="text-sm font-medium mb-3">' + T.t('filesSort') + '</p>' +
      sheetSeg('apf-sort-seg', [{ v: 'added', label: T.t('sortAdded') }, { v: 'name', label: T.t('sortName') }], sort) + '</div>' +
      '<div class="px-5 py-4" id="apf-home"><p class="text-sm font-medium mb-1">' + T.t('filesHome') + '</p>' +
      GROUPS.map(function (g) {
        const on_ = home[g.id] !== false;
        return (
          '<div class="set-row no-ic" id="apf-home-' + g.id + '" role="button" tabindex="0">' +
          '<span class="flex-1 font-medium">' + g.label + '</span>' +
          '<span class="switch" role="switch" aria-checked="' + (on_ ? 'true' : 'false') + '"><span class="knob"></span></span></div>'
        );
      }).join('') + '</div>' +
      '<div class="set-row no-ic" id="apf-clear" role="button" tabindex="0">' +
      '<span class="flex-1 font-medium">' + T.t('filesClear') + '</span></div>' +
      appOpenLink('files', T.t('openFiles')) +
      '</div>';
    openSheet({ title: T.t('filesTitle'), html: html });
    wireSeg('apf-view-seg', function (val) {
      const vv = filesView();
      vv.layout = val;
      featSet('files-view', vv);
      paintApps();
      window.dispatchEvent(new Event('sgx-settings-changed'));
    });
    wireSeg('apf-sort-seg', function (val) {
      const vv = filesView();
      vv.sort = val;
      featSet('files-view', vv);
      window.dispatchEvent(new Event('sgx-settings-changed'));
    });
    GROUPS.forEach(function (g) {
      appSheetRow('apf-home-' + g.id, function () {
        /** @type {Record<string, any>} */
        const hh = Object.assign({}, featGet('files-home') || {});
        const on_ = hh[g.id] !== false;
        hh[g.id] = !on_;
        featSet('files-home', hh);
        const sw = document.querySelector('#apf-home-' + g.id + ' .switch');
        if (sw) sw.setAttribute('aria-checked', !on_ ? 'true' : 'false');
        window.dispatchEvent(new Event('sgx-settings-changed'));
      });
    });
    const clr = $('apf-clear');
    if (clr)
      armConfirm(clr, T.t('confirmClear'), function () {
        try {
          localStorage.removeItem('sgx-files-recent');
          localStorage.removeItem('sgx-files-lastvisit');
        } catch (e) {}
        window.dispatchEvent(new Event('sgx-settings-changed'));
        closeSheet();
      });
    hlInSheet(hl);
  }
  rowToggle('row-app-files', function () {
    openFilesPanel();
  });

  /* ---- 应用商店面板 ---- */
  /** @param {string} [hl] */
  function openStorePanel(hl) {
    const h = getHiddenApps(),
      inst = APPS_TOTAL - h.length;
    const html =
      '<div class="px-1 pb-2">' +
      '<div class="set-row no-ic"><span class="flex-1 font-medium">' + T.fmt('storeCounts', { i: inst, u: h.length }) + '</span></div>' +
      '<div class="set-row no-ic" id="aps-restore" role="button" tabindex="0">' +
      '<span class="flex-1 font-medium text-m-primary">' + T.t('storeRestore') + '</span></div>' +
      appOpenLink('store', T.t('openStore')) +
      '</div>';
    openSheet({ title: T.t('storeTitle'), html: html });
    const rs = $('aps-restore');
    if (rs)
      on(rs, 'click', function () {
        try {
          localStorage.removeItem('sgx-apps-hidden');
        } catch (e) {}
        paintApps();
        window.dispatchEvent(new Event('sgx-settings-changed'));
        closeSheet();
      });
    hlInSheet(hl);
  }
  rowToggle('row-app-store', function () {
    openStorePanel();
  });

  /* ---- 浏览器面板 ---- */
  function pickEngine() {
    const cur = SE.cur();
    openSheet({
      title: T.t('engineTitle'),
      options: SE.ORDER.map(function (id) {
        return { label: SE.name(id), value: id, checked: id === cur };
      }),
      onPick: function (v) {
        SE.setCur(v); /* 存值 + 派发 sgx-settings-changed，paintApps 自动刷新 */
        openBrowserPanel('apb-engine');
      },
    });
  }
  /** @param {string} [hl] */
  function openBrowserPanel(hl) {
    const pos = addrbarPos();
    const html =
      '<div class="px-1 pb-2">' +
      '<div class="set-row no-ic" id="apb-engine" role="button" tabindex="0">' +
      '<span class="flex-1 font-medium">' + T.t('engineTitle') + '</span>' +
      '<span class="text-sm text-m-on-surface-variant">' + esc(engineName()) + '</span>' + CHEVR + '</div>' +
      '<div class="px-5 py-4" id="apb-pos"><p class="text-sm font-medium mb-3">' + T.t('addrPos') + '</p>' +
      sheetSeg('apb-pos-seg', [{ v: 'top', label: T.t('posTop') }, { v: 'bottom', label: T.t('posBottom') }], pos) + '</div>' +
      '<div class="set-row no-ic" id="apb-clear" role="button" tabindex="0">' +
      '<span class="flex-1 font-medium">' + T.t('clearHist') + '</span></div>' +
      appOpenLink('browser', T.t('openBrowser')) +
      '</div>';
    openSheet({ title: T.t('browserTitle'), html: html });
    appSheetRow('apb-engine', pickEngine);
    wireSeg('apb-pos-seg', function (val) {
      featSet('addrbar-pos', val);
      paintApps();
      window.dispatchEvent(new Event('sgx-settings-changed'));
    });
    const clr = $('apb-clear');
    if (clr)
      armConfirm(clr, T.t('confirmClear'), function () {
        try {
          localStorage.setItem('sgx-browser-recent', '[]');
        } catch (e) {}
        window.dispatchEvent(new Event('sgx-settings-changed'));
        closeSheet();
      });
    hlInSheet(hl);
  }
  rowToggle('row-app-browser', function () {
    openBrowserPanel();
  });
  paintApps();
  on(window, 'sgx-settings-changed', paintApps);

  /* ---- 减弱动效 ---- */
  function paintMotion() {
    const on_ = !!featGet('reduced-motion');
    setSwitch('sw-motion', on_);
    document.documentElement.classList.toggle('reduced-motion', on_);
    try {
      document.documentElement.setAttribute('data-reduced-motion', on_ ? '1' : '0');
    } catch (e) {}
  }
  rowToggle('row-motion', function () {
    featSet('reduced-motion', !featGet('reduced-motion'));
    paintMotion();
  });
  paintMotion();
  featOn('reduced-motion', paintMotion);

  /* ---- 数字健康：访客时长提示 ---- */
  function paintWellTip() {
    setSwitch('sw-welltip', !!featGet('well-tip'));
  }
  rowToggle('row-welltip', function () {
    featSet('well-tip', !featGet('well-tip'));
    paintWellTip();
  });
  paintWellTip();
  featOn('well-tip', paintWellTip);
  /* 访客到访分布 */
  (function () {
    const totalEl = $('well-v-total'),
      bar = $('well-v-bar'),
      legend = $('well-v-legend');
    if (!totalEl || !bar) return;
    let v = wellLoad();
    try {
      v = wellFlush();
    } catch (e) {}
    const total = Math.max(0, Math.round(v.min || 0));
    totalEl.textContent = String(total);
    const AREAS = [
      { id: 'home', label: T.t('areaHome'), color: 'var(--m-primary)' },
      { id: 'links', label: T.t('areaLinks'), color: 'var(--m-accent)' },
      { id: 'settings', label: T.t('areaSettings'), color: 'var(--m-secondary)' },
      { id: 'goodlock', label: T.t('areaGoodlock'), color: 'var(--m-rose)' },
    ];
    if (total <= 0) {
      bar.innerHTML = '<span style="width:100%;background:var(--m-container-highest)"></span>';
      if (legend) legend.innerHTML = '<span>' + T.t('wellNoRec') + '</span>';
      return;
    }
    bar.innerHTML = AREAS.map(function (a) {
      const m = v.areas[a.id] || 0,
        pct = Math.max(0, (m / total) * 100);
      return '<span style="width:' + pct.toFixed(1) + '%;background:' + a.color + '" title="' + a.label + '"></span>';
    }).join('');
    if (legend)
      legend.innerHTML = AREAS.map(function (a) {
        return (
          '<span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-full" style="background:' + a.color + '"></span>' + a.label + '</span>'
        );
      }).join('');
  })();

  /* ---- 重置 ---- */
  rowToggle('row-reset', function () {
    try {
      /** @type {string[]} */
      const ks = [];
      for (let i = 0; i < localStorage.length; i++) ks.push(localStorage.key(i) || '');
      ks.forEach(function (k) {
        if (k.indexOf('sgx-') === 0 || k === 'theme') localStorage.removeItem(k);
      });
    } catch (e) {}
    location.reload();
  });

  /* 2.6.0：设置改为真实二级页（/settings/<cat>/）；旧 hash 由设置首页内联脚本跳转到子页；
     子页返回用 subpage-head 的返回键。DeX/PC 双栏在首页内切换（下）。 */
  /* ---- 2.6.0 DeX/PC 双栏：左导航切换右窗格（复用子页同一套 partial；无 JS 时导航照常跳子页） ---- */
  (function () {
    var nav = document.getElementById('set-cat-nav');
    var layout = document.querySelector('.set-layout');
    if (!nav || !layout) return;
    var panes = document.getElementById('set-panes');
    if (!panes) return;
    var isWide = document.documentElement.classList.contains('layout-dex') ||
      document.documentElement.classList.contains('layout-pc');
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
    nav.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('.set-cat') : null;
      if (!b) return;
      var id = b.getAttribute('data-cat') || '';
      if (id === 'security') return; /* 独立页面，不拦截 */
      if (!isWide) return; /* 移动端没有双栏（导航隐藏），照常跳转 */
      e.preventDefault();
      showPane(id, b.getAttribute('data-title') || '');
    });
    if (isWide) showPane('display', (nav.querySelector('[data-cat="display"]') || {}).getAttribute ? nav.querySelector('[data-cat="display"]').getAttribute('data-title') : '');
  })();
  const reducedM = document.documentElement.classList.contains('reduced-motion');

  /* 2.6.0：搜索结果跨页跳转带 #元素id 到达后，滚动并高亮命中行
    （首页旧 hash 跳转脚本只认分类名，元素 id 不受影响） */
  (function () {
    var h = '';
    try { h = (location.hash || '').replace(/^#/, ''); } catch (e) { return; }
    if (!h) return;
    var el = document.getElementById(h);
    if (!el) return;
    function hl() {
      try {
        el.scrollIntoView({ block: 'center', behavior: reducedM ? 'auto' : 'smooth' });
        el.classList.add('set-hl');
        window.setTimeout(function () { el.classList.remove('set-hl'); }, 1400);
      } catch (e2) {}
    }
    if (document.readyState === 'complete') window.setTimeout(hl, 150);
    else window.addEventListener('load', function () { window.setTimeout(hl, 150); });
  })();

  /* ---- 全屏搜索索引 ---- */
  /** @type {Array<any>} */
  const SETIDX = (RAW.setidx || []).map(function (/** @type {Array<string>} */ a) {
    return {
      t: en ? a[1] : a[0],
      d: en ? a[3] : a[2],
      cat: a[4],
      el: a[5],
      p: a[6] || '',
      i: a[7] || '',
      u: a[8] || '',
    };
  });
  /** @param {string} elid */
  function idxByEl(elid) {
    for (let i = 0; i < SETIDX.length; i++) {
      if (SETIDX[i].el === elid) return SETIDX[i];
    }
    return null;
  }
  /* 胶囊搜索：复用 SETIDX 索引，结果显示在胶囊上方浮层 */
  /** @param {any} x */
  function itemHTML(x) {
    return (
      '<button type="button" class="setso-item" data-cat="' + x.cat + '" data-el="' + x.el + '" data-t="' + esc(x.t) + '"' +
      (x.p ? ' data-p="' + x.p + '"' : '') + (x.i ? ' data-i="' + x.i + '"' : '') + (x.u ? ' data-u="' + x.u + '"' : '') + '>' +
      '<span class="flex-1 min-w-0"><span class="block font-medium truncate">' + esc(x.t) + '</span>' +
      (x.d ? '<span class="block text-xs text-m-on-surface-variant truncate">' + esc(x.d) + '</span>' : '') + '</span>' + CHEVR + '</button>'
    );
  }
  /** @param {string} q */
  function renderSearchHTML(q) {
    q = (q || '').trim().toLowerCase();
    let html = '';
    if (!q) {
      /** @type {Array<string>} */
      let recent = [];
      try {
        recent = JSON.parse(get('sgx-set-recent') || '[]');
      } catch (e) {}
      if (recent.length) {
        html += '<p class="setso-sec">' + T.t('setsoRecent') + '</p>';
        html += recent
          .map(function (r) {
            let f = null;
            for (let i = 0; i < SETIDX.length; i++) {
              if (SETIDX[i].t === r) {
                f = SETIDX[i];
                break;
              }
            }
            return f ? itemHTML(f) : '';
          })
          .join('');
      }
      html += '<p class="setso-sec">' + T.t('setsoCommon') + '</p>';
      ['seg-font', 'palette-dots', 'row-datetime'].forEach(function (eid) {
        const f = idxByEl(eid);
        if (f) html += itemHTML(f);
      });
    } else {
      const hits = SETIDX.filter(function (x) {
        return (x.t + ' ' + x.d).toLowerCase().indexOf(q) >= 0;
      }).slice(0, 12);
      html = hits.length
        ? hits.map(itemHTML).join('')
        : '<p class="px-4 py-8 text-center text-sm text-m-on-surface-variant">' + T.t('setsoNo') + '</p>';
    }
    return html;
  }
  setCapSearchProvider(function (pg, q) {
    if (pg !== 'settings') return '';
    return renderSearchHTML(q);
  });
  on(document, 'click', function (/** @type {MouseEvent} */ e) {
    const t = /** @type {Element|null} */ (e.target);
    const b = t && t.closest ? t.closest('#sgx-cap-results-settings .setso-item') : null;
    if (b)
      pickResult(
        b.getAttribute('data-cat') || '',
        b.getAttribute('data-el') || '',
        b.getAttribute('data-t') || '',
        b.getAttribute('data-p') || '',
        b.getAttribute('data-i') || '',
        b.getAttribute('data-u') || ''
      );
  });
  /**
   * @param {string} cat
   * @param {string} elid
   * @param {string} title
   * @param {string} panel
   * @param {string} item
   */
  function pickResult(cat, elid, title, panel, item, url) {
    try {
      let r = JSON.parse(get('sgx-set-recent') || '[]');
      r = r.filter(function (/** @type {string} */ x) {
        return x !== title;
      });
      r.unshift(title);
      set('sgx-set-recent', JSON.stringify(r.slice(0, 6)));
    } catch (e) {}
    /* 2.6.0：面板（我的文件/应用商店/浏览器）优先原地弹层，不跳转 */
    if (panel === 'files' || panel === 'store' || panel === 'browser') {
      window.setTimeout(function () {
        if (panel === 'files') openFilesPanel(item);
        else if (panel === 'store') openStorePanel(item);
        else openBrowserPanel(item);
      }, 80);
      return;
    }
    /* 子页 URL（u 字段；安全与隐私沿用 el 开头 / 的旧形式）→ 跳转对应子页。
       2.6.0：跨页跳转时把元素 id 带到 hash 上，子页加载后滚动并高亮命中行。 */
    var target = url || (elid && elid.charAt(0) === '/' ? elid : '');
    if (target) {
      try {
        var tp = new URL(target, window.location.origin).pathname;
        if (tp === window.location.pathname && elid && elid.charAt(0) !== '/') {
          var sameEl = document.getElementById(elid);
          if (sameEl) {
            sameEl.scrollIntoView({ block: 'center', behavior: reducedM ? 'auto' : 'smooth' });
            sameEl.classList.add('set-hl');
            window.setTimeout(function () { sameEl.classList.remove('set-hl'); }, 1100);
            return;
          }
        }
      } catch (e) {}
      if (elid && elid.charAt(0) !== '/' && target.indexOf('#') < 0) target += '#' + elid;
      window.location.href = target;
      return;
    }
    window.setTimeout(function () {
      const el = document.getElementById(elid);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: reducedM ? 'auto' : 'smooth' });
      el.classList.add('set-hl');
      window.setTimeout(function () {
        el.classList.remove('set-hl');
      }, 1100);
    }, 80);
  }
})();
