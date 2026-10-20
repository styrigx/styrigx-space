/**
 * @fileoverview 设置页：主题、调色板、字体、布局、常规管理（含重置）、
 * 减弱动效、数字健康、重置、桌面双栏、设置搜索。
 * 文案来自页面内 sgx-i18n-settings JSON（中英双语），JS 与语言无关。
 */
import { on } from '../lib/events.js';
import { esc } from '../lib/util.js';
import { get, set, remove, removeByPrefix, getJSON, setJSON } from '../lib/storage.js';
import { get as featGet, set as featSet, on as featOn } from '../lib/features.js';
import { loadI18n } from '../lib/i18n.js';
import { openSheet } from '../shell/sheet.js';
import { setThemeMode } from '../lib/theme.js';
import { wellLoad, wellFlush } from '../shell/goodlock.js';
import { sgxNavigate, sgxReplace, sgxGoBack, sgxReload } from '../lib/diag-jumptrace.js';

(function () {
  const en = document.documentElement.lang === 'en';
  const T = loadI18n('sgx-i18n-settings');
  /** @type {any} */
  let RAW = {};
  try {
    RAW = JSON.parse(document.getElementById('sgx-i18n-settings').textContent || '{}');
  } catch (e) {}

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

  /* ---- 调色板（第一个 = 默认，即头像取色） ---- */
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
    /* 2.9.2 窄屏保护：< 840px 时 DeX/PC 置灰（仅在大屏生效），偏好保留 */
    const isNarrow = (window.innerWidth || 1280) < 840;
    document.querySelectorAll('#seg-layout button').forEach(function (b) {
      const bv = b.getAttribute('data-v');
      b.setAttribute('aria-pressed', bv === v ? 'true' : 'false');
      if ((bv === 'dex' || bv === 'pc') && isNarrow) {
        b.setAttribute('disabled', 'disabled');
        b.setAttribute('title', '仅在大屏生效');
      } else {
        b.removeAttribute('disabled');
        b.removeAttribute('title');
      }
    });
    // 窄屏提示
    let hint = document.getElementById('seg-layout-narrow-hint');
    if (isNarrow) {
      if (!hint) {
        hint = document.createElement('p');
        hint.id = 'seg-layout-narrow-hint';
        hint.className = 'text-[12px] opacity-60 mt-1';
        hint.textContent = 'DeX / PC 仅在大屏生效（当前为窄屏）';
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
    const names = { auto: '自动', mobile: 'Mobile', dex: 'DeX', pc: 'PC' };
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
    document.getElementById('sgx-layout-undo').addEventListener('click', function () {
      featSet('layout', oldV);
      paintLayout();
      const w = /** @type {any} */ (window);
      if (w.__applyLayout) w.__applyLayout();
      window.dispatchEvent(new Event('sgx-settings-changed'));
      bar.remove();
      if (layoutUndoTimer) { clearTimeout(layoutUndoTimer); layoutUndoTimer = null; }
    });
  }

  document.querySelectorAll('#seg-layout button').forEach(function (b) {
    on(b, 'click', function () {
      const v = b.getAttribute('data-v') || 'auto';
      const oldV = featGet('layout') || 'auto';
      if (v === oldV) return;
      featSet('layout', v);
      paintLayout();
      const w = /** @type {any} */ (window);
      if (w.__applyLayout) w.__applyLayout();
      window.dispatchEvent(new Event('sgx-settings-changed'));
      showLayoutSnackbar(v, oldV);
    });
  });
  paintLayout();
  featOn('layout', paintLayout);

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
        if (v === 'system') remove('sgx-lang');
        else set('sgx-lang', v);
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
        sgxReplace(np + q + h);
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
    return get('sgx-weather-loc') || 'auto';
  }
  function wxCityName() {
    const c = getJSON('sgx-weather-city', null);
    return (c && c.name) || '';
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
        set('sgx-weather-loc', v);
        document.querySelectorAll('#wx-loc button').forEach(function (x) {
          x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
        });
        const wrap = document.getElementById('wx-city-wrap');
        if (wrap) wrap.style.display = v === 'manual' ? '' : 'none';
        /* 清除天气缓存，触发重新获取 */
        remove('sgx-weather');
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
                setJSON('sgx-weather-city', {
                  name: g.name,
                  lat: g.latitude,
                  lon: g.longitude,
                });
                remove('sgx-weather');
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
            setJSON('sgx-weather-precise', {
              lat: pos.coords.latitude,
              lon: pos.coords.longitude,
              ts: Date.now(),
            });
            set('sgx-weather-loc', 'precise');
            remove('sgx-weather');
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
    removeByPrefix('sgx-');
    remove('theme');
    sgxReload();
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
  /* B1-6a：设置主页/子页的胶囊点一下就跳搜索页，不弹键盘 */
  (function () {
    const cap = document.getElementById('sgx-cap-settings');
    if (!cap) return;
    const go = function () {
      sgxNavigate(en ? '/en/settings/search/' : '/settings/search/');
    };
    /* 按下时 preventDefault：不让里面的输入框拿到焦点弹键盘；
       抬起时才跳转，且手指移动超过 10px 视为滑动、不跳（以前 touchstart 就跳，滑过胶囊会误触） */
    let sx = 0,
      sy = 0,
      moved = false;
    cap.addEventListener('touchstart', function (e) {
      e.preventDefault();
      e.stopPropagation();
      const t = e.touches[0];
      sx = t ? t.clientX : 0;
      sy = t ? t.clientY : 0;
      moved = false;
    }, { passive: false, capture: true });
    cap.addEventListener('touchmove', function (e) {
      const t = e.touches[0];
      if (t && Math.hypot(t.clientX - sx, t.clientY - sy) > 10) moved = true;
    }, { passive: true, capture: true });
    cap.addEventListener('touchend', function (e) {
      e.stopPropagation();
      if (!moved) go();
    }, { capture: true });
    cap.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
    }, { capture: true });
    cap.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      go();
    }, { capture: true });
    cap.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    }, { capture: true });
  })();
  /* B1-6a：搜索独立页逻辑 */
  (function () {
    const input = document.getElementById('sgx-cap-input-setsearch');
    const page = document.getElementById('setso-page');
    if (!input || !page) return;
    /** @type {Array<any>} */
    let cats = [];
    try {
      cats = JSON.parse(document.getElementById('sgx-settings-cats').textContent || '[]');
    } catch (e) {}
    const catMap = {};
    cats.forEach(function (c) {
      catMap[c.id] = c;
    });
    /* 进页聚焦放到下一帧：模块求值时搜索胶囊（initCapsule）还没绑定 focus，
       提前聚焦会让胶囊不展开、不跟键盘（录屏里键盘弹出时胶囊不见、收起后悬在半空） */
    requestAnimationFrame(function () {
      try { input.focus({ preventScroll: true }); } catch (e) {}
    });
    let timer = null;
    /* B1-6b：最近搜索（localStorage 字符串数组，中英文共用） */
    const LS_SETHIST = 'sgx-setso-history';
    try {
      remove('sgx-set-recent'); /* 旧 key 清理 */
    } catch (e) {}
    const XICON =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>';
    function getSetsoHist() {
      try {
        const a = JSON.parse(get(LS_SETHIST, '[]') || '[]');
        return Array.isArray(a)
          ? a.filter(function (x) { return typeof x === 'string'; }).slice(0, 10)
          : [];
      } catch (e) {
        return [];
      }
    }
    function setSetsoHist(a) {
      try {
        set(LS_SETHIST, JSON.stringify(a.slice(0, 10)));
      } catch (e) {}
    }
    /** @param {string} s */
    function pushSetsoHist(s) {
      s = (s || '').trim();
      if (!s) return;
      const low = s.toLowerCase();
      const a = getSetsoHist().filter(function (x) { return x.toLowerCase() !== low; });
      a.unshift(s);
      setSetsoHist(a.slice(0, 10));
    }
    function renderRecent() {
      const a = getSetsoHist();
      if (!a.length) {
        page.innerHTML = '';
        return;
      }
      let html =
        '<div class="setso-card setso-recent" role="region" aria-label="' + esc(T.t('setsoRecent')) + '">' +
        '<div class="setso-recent-head"><span class="setso-recent-title">' + esc(T.t('setsoRecent')) + '</span>' +
        '<button type="button" class="setso-clear" data-setso-clear>' + esc(T.t('setsoClearAll')) + '</button></div>' +
        '<div class="setso-chips">';
      a.forEach(function (s, i) {
        html +=
          '<span class="setso-chip" data-setso-chip="' + i + '"><span class="setso-chip-tx">' + esc(s) + '</span>' +
          '<button type="button" class="setso-chip-x" data-setso-del="' + i + '" aria-label="' + esc(T.t('setsoDel') + ' ' + s) + '">' + XICON + '</button></span>';
      });
      html += '</div></div>';
      page.innerHTML = html;
    }
    /* 点卡片不抢输入框焦点（6c 键盘逻辑） */
    page.addEventListener('pointerdown', function (e) {
      const t = /** @type {Element|null} */ (e.target);
      if (t && t.closest && t.closest('.setso-recent')) e.preventDefault();
    });
    function hl(text, q) {
      const idx = text.toLowerCase().indexOf(q);
      if (idx < 0) return esc(text);
      return esc(text.slice(0, idx)) + '<mark class="setso-hl">' + esc(text.slice(idx, idx + q.length)) + '</mark>' + esc(text.slice(idx + q.length));
    }
    function render(q) {
      q = (q || '').trim().toLowerCase();
      if (!q) {
        renderRecent();
        return;
      }
      const hits = SETIDX.filter(function (x) {
        return (x.t + ' ' + x.d).toLowerCase().indexOf(q) >= 0;
      });
      if (!hits.length) {
        page.innerHTML = '<p class="px-4 py-8 text-center text-sm text-m-on-surface-variant">' + T.t('setsoNo') + '</p>';
        return;
      }
      const groups = {};
      hits.forEach(function (x) {
        (groups[x.cat] = groups[x.cat] || []).push(x);
      });
      let html = '<h2 class="setso-title">' + T.fmt('setsoResults', { n: hits.length }) + '</h2>';
      Object.keys(groups).forEach(function (catId) {
        const c = catMap[catId] || { zh: catId, en: catId, icon: '', bg: '', fg: '' };
        html += '<div class="setso-card"><div class="setso-card-head"><span class="' + c.bg + ' ' + c.fg + '">' + esc(c.icon) + '</span>' + esc(en ? c.en : c.zh) + '</div>';
        groups[catId].forEach(function (x) {
          html +=
            '<button type="button" class="setso-item" data-cat="' + x.cat + '" data-el="' + x.el + '" data-t="' + esc(x.t) + '"' +
            (x.p ? ' data-p="' + x.p + '"' : '') + (x.i ? ' data-i="' + x.i + '"' : '') + (x.u ? ' data-u="' + x.u + '"' : '') + '>' +
            '<span class="flex-1 min-w-0"><span class="block font-medium">' + hl(x.t, q) + '</span>' +
            (x.d ? '<span class="block text-xs text-m-on-surface-variant">' + hl(x.d, q) + '</span>' : '') + '</span>' + CHEVR + '</button>';
        });
        html += '</div>';
      });
      page.innerHTML = html;
    }
    input.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        render(input.value);
      }, 150);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        if (timer) clearTimeout(timer);
        pushSetsoHist(input.value);
        render(input.value);
        input.blur(); /* B1-6c：回车 = 收键盘、搜索栏沉底，看结果 */
      }
    });
    render(input.value); /* B1-6b：进页即渲染（空输入时显示最近搜索卡） */

    /* ===== B1-6c：键盘 / 沉底 / 返回手势 / 内容置顶 / ⓧ 清空 / × 关闭 ===== */
    const cap = document.getElementById('sgx-cap-setsearch');
    const capClose = cap ? cap.querySelector('[data-cap-close]') : null;
    /* 键盘哨兵是否已 push（返回手势逻辑见下方） */
    let armed = false;
    const capClear = cap ? cap.querySelector('[data-cap-clear]') : null;
    /* ⓧ 清空：有输入才出现；× 关闭常驻 */
    function syncTools() {
      if (capClear) /** @type {HTMLElement} */ (capClear).hidden = input.value.length === 0;
    }
    input.addEventListener('input', syncTools);
    [capClose, capClear].forEach(function (b) {
      /* 点按钮不抢输入框焦点（键盘态下点 ⓧ 不收键盘） */
      if (b) b.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    });
    if (capClear) {
      capClear.addEventListener('click', function (e) {
        e.stopPropagation();
        if (timer) clearTimeout(timer);
        input.value = '';
        syncTools();
        render('');
        contentFirst();
        try { input.focus({ preventScroll: true }); } catch (err) {}
      });
    }
    if (capClose) {
      /* × = 退出搜索页：站内进来的回到来的那一页（连同键盘哨兵一起退掉）；外部直接打开的回设置主页 */
      capClose.addEventListener('click', function (e) {
        e.stopPropagation();
        let internal = false;
        try { internal = !!document.referrer && new URL(document.referrer).origin === location.origin; } catch (err) {}
        if (!internal) {
          sgxReplace(document.documentElement.lang === 'en' ? '/en/settings/' : '/settings/');
          return;
        }
        if (armed) {
          armed = false;
          history.go(-2);
        } else {
          sgxGoBack();
        }
      });
    }
    syncTools();

    /* 内容置顶：滚过标题区，内容紧贴顶栏下方（顶栏下沿 68px + 16px）；往下拉到顶才露出大标题 */
    function contentFirst() {
      const heads = document.querySelectorAll('[data-subpage-head]');
      let head = null;
      for (let i = 0; i < heads.length; i++) {
        if (heads[i].getClientRects().length) { head = /** @type {HTMLElement} */ (heads[i]); break; }
      }
      if (!head) return;
      const bar = document.querySelector('.sgx-topbar');
      const barBottom = bar ? bar.getBoundingClientRect().bottom : 68;
      const y = Math.max(0, head.getBoundingClientRect().bottom + window.scrollY - barBottom - 16);
      window.scrollTo(0, y);
    }
    try { history.scrollRestoration = 'manual'; } catch (e) {}
    /* 下一帧再置顶：公共初始化（initCore）会调整标题区高度，模块求值时量的位置会偏 */
    requestAnimationFrame(contentFirst);
    /* 搜索后同样内容置顶 */
    input.addEventListener('input', function () {
      window.setTimeout(contentFirst, 170);
    });

    /* 返回手势：键盘弹出时 push 一条同 URL 的哨兵；popstate 时
       - 键盘态：只收键盘（blur → 胶囊沉底），停留本页；
       - 沉底态：不拦截，继续返回上一页（设置主页）。
       */
    function isKb() {
      return document.activeElement === input || !!(cap && cap.classList.contains('open'));
    }
    function arm() {
      if (armed) return;
      try {
        history.pushState(
          { url: window.location.href, scrollY: window.scrollY, sgxSetsoKb: 1 },
          '',
          window.location.href
        );
        armed = true;
      } catch (e) {}
    }
    input.addEventListener('focus', arm);
    if (document.activeElement === input) arm(); /* 进页时已自动聚焦 */
    /* capture：先于胶囊自己的 popstate 兜底（它会 blur），这样还能判断出事发时是否键盘态 */
    window.addEventListener(
      'popstate',
      function () {
        if (!armed) return;
        /* 出栈的是哨兵之上的条目（如导航抽屉的哨兵）：本页哨兵还在，不当作返回 */
        if (history.state && history.state.sgxSetsoKb) return;
        armed = false;
        const kb = isKb();
        if (kb) {
          try { input.blur(); } catch (e) {}
          return;
        }
        /* 沉底态：哨兵已出栈，再退一步才是真正的返回 */
        window.setTimeout(function () {
          sgxGoBack();
        }, 0);
      },
      true
    );
    on(page, 'click', function (/** @type {MouseEvent} */ e) {
      const t = /** @type {Element|null} */ (e.target);
      /* B1-6b：最近搜索卡交互 */
      const del = t && t.closest ? t.closest('[data-setso-del]') : null;
      if (del) {
        const a = getSetsoHist();
        a.splice(parseInt(del.getAttribute('data-setso-del') || '0', 10), 1);
        setSetsoHist(a);
        renderRecent();
        return;
      }
      const clr = t && t.closest ? t.closest('[data-setso-clear]') : null;
      if (clr) {
        setSetsoHist([]);
        page.innerHTML = '';
        return;
      }
      const chip = t && t.closest ? t.closest('[data-setso-chip]') : null;
      if (chip) {
        const a = getSetsoHist();
        const s = a[parseInt(chip.getAttribute('data-setso-chip') || '0', 10)] || '';
        if (s) {
          if (timer) clearTimeout(timer);
          input.value = s;
          pushSetsoHist(s);
          render(s);
        }
        return;
      }
      const b = t && t.closest ? t.closest('.setso-item') : null;
      if (b) {
        pushSetsoHist(input.value);
        pickResult(
          b.getAttribute('data-cat') || '',
          b.getAttribute('data-el') || '',
          b.getAttribute('data-t') || '',
          b.getAttribute('data-p') || '',
          b.getAttribute('data-i') || '',
          b.getAttribute('data-u') || ''
        );
      }
    });
  })();
  /**
   * @param {string} cat
   * @param {string} elid
   * @param {string} title
   * @param {string} panel
   * @param {string} item
   */
  function pickResult(cat, elid, title, panel, item, url) {
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
      sgxNavigate(target);
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
