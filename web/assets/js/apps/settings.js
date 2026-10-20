/**
 * @fileoverview 设置页：主题、调色板、字体、布局、常规管理（含重置）、
 * 减弱动效、数字健康、重置、桌面双栏。
 * 文案来自页面内 sgx-i18n-settings JSON（中英双语），JS 与语言无关。
 */
import { on } from '../lib/events.js';
import { esc } from '../lib/util.js';
import { get, set, remove, removeByPrefix, getJSON, setJSON } from '../lib/storage.js';
import { get as featGet, set as featSet, on as featOn } from '../lib/features.js';
import { loadI18n } from '../lib/i18n.js';
import { openSheet } from '../shell/sheet.js';
import { setTheme, toggleFollowSystem, setPalette, setFontSize, setLayout, setReducedMotion, setLang } from '../lib/prefs.js';
import { syncAccent } from '../lib/accent-roles.js';
import { wellLoad, wellFlush } from '../shell/goodlock.js';
import { sgxReplace, sgxReload } from '../lib/diag-jumptrace.js';

(function () {
  const en = document.documentElement.lang === 'en';
  const T = loadI18n('sgx-i18n-settings');

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
      setPalette(b.getAttribute('data-palette') || 'lake');
      paintPalette();
    });
  });
  /* 自定义主题色（sgx-accent）：缓存缺失 / 过期时按种子重算整套角色（lib/palette-scheme.js） */
  syncAccent();
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
      setFontSize(b.getAttribute('data-v') || 'standard');
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
        /* 写偏好并跳到对应语言版本（保留查询参数与 hash），replace 不产生历史 */
        sgxReplace(setLang(/** @type {any} */ (v)));
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
    setReducedMotion(!featGet('reduced-motion'));
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
     子页用浏览器 / 系统返回。DeX/PC 双栏在首页内切换（下）。 */
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
})();
