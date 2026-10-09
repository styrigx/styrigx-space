/**
 * @fileoverview 顶栏与 Dock 系统（旧 sgx-base-b.js）。
 * 手机悬浮 Dock、桌面布局 resize 跟随、顶栏时钟/天气、DeX 应用抽屉、时钟弹窗、天气面板。
 */
import { on } from './events.js';
import { fmtTz } from './util.js';
import { get } from './storage.js';
import { get as featGet } from './features.js';
import { visibleInterval } from './scheduler.js';
import { onDexLayoutChange, applyLayout } from './layout.js';

/**
 * @param {import('./scheduler.js').Scheduler} S
 */
export function initNav(S) {
  const en = document.documentElement.lang === 'en';

  /* ===== 手机悬浮 Dock：滚动隐藏 + 选中高亮块滑动 ===== */
  (function () {
    const dock = document.getElementById('phone-dock');
    if (!dock) return;
    const pill = document.getElementById('dock-pill');
    const reduced = function () {
      return document.documentElement.classList.contains('reduced-motion');
    };
    function paintActive() {
      const pg = document.body.getAttribute('data-page');
      const btns = dock.querySelectorAll('.dock-btn');
      /** @type {Element|null} */
      let active = null;
      btns.forEach(function (b) {
        const isOn = b.getAttribute('data-dock') === pg;
        b.classList.toggle('dock-active', isOn);
        if (isOn) active = b;
      });
      if (active && pill) {
        const a = /** @type {HTMLElement} */ (active);
        pill.style.display = '';
        pill.style.left = a.offsetLeft + 6 + 'px';
        pill.style.width = a.offsetWidth - 12 + 'px';
      } else if (pill) {
        pill.style.display = 'none';
      }
    }
    paintActive();
    S.onResize(paintActive);
    /* 滚动时隐藏，停 0.6s 后或滚到底时出现；减弱动效时不隐藏 */
    /** @type {number|null} */
    let t = null;
    const ssBar = document.getElementById('settings-searchbar-wrap');
    function show() {
      dock.classList.remove('dock-hide');
      if (ssBar) ssBar.classList.remove('sgx-hide');
    }
    S.onScroll(function () {
      if (reduced()) return;
      dock.classList.add('dock-hide');
      if (ssBar) ssBar.classList.add('sgx-hide');
      if (t) clearTimeout(t);
      t = window.setTimeout(show, 600);
    });
    /* DeX 模式下确保隐藏（CSS 已处理，这里兜底清状态） */
    onDexLayoutChange(function (m) {
      if (m !== 'dex') paintActive();
    });
  })();

  /* resize 时重算布局（防抖） */
  (function () {
    /** @type {number|null} */
    let rt = null;
    S.onResize(function () {
      if (rt) clearTimeout(rt);
      rt = window.setTimeout(function () {
        applyLayout();
      }, 180);
    });
  })();

  /* ---- 顶栏时钟/日期：遵守小时制 + 第一时区设置 ---- */
  (function () {
    const tEl = document.getElementById('nav-time');
    const dEl = document.getElementById('nav-time-date');
    const w = /** @type {any} */ (window);
    function tickTray() {
      if (!tEl || !dEl) return;
      const tz = w.__firstTz ? w.__firstTz() : 'UTC';
      const h12 = w.__hour12 ? w.__hour12() : false;
      const s = fmtTz(tz, h12);
      if (s) tEl.textContent = s;
      const d = new Date();
      const wdzh = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const wden = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const mp = d.getMonth() + 1,
        dp = d.getDate();
      dEl.textContent = en ? mp + '/' + dp + ' ' + wden[d.getDay()] : mp + '月' + dp + '日 ' + wdzh[d.getDay()];
    }
    visibleInterval(tickTray, 15000);
    on(window, 'sgx-settings-changed', tickTray);
  })();

  /* ---- 当前页面：DeX Dock 图标下方小圆点 ---- */
  (function () {
    const pg = document.body.getAttribute('data-page');
    if (!pg) return;
    document.querySelectorAll('#dex-dock [data-navpage]').forEach(function (a) {
      if (a.getAttribute('data-navpage') === pg) a.classList.add('dex-dock-active');
    });
  })();

  /* ---- 顶栏天气（图标 + 温度）：localStorage 30 分钟缓存；2.4.0-G：SGX_FEAT_WEATHER_SHOW 编译期可移除 ---- */
  if (SGX_FEAT_WEATHER_SHOW)
  (function () {
    const icEl = document.getElementById('nav-wx-ic');
    const tEl2 = document.getElementById('nav-wx-t');
    const btn = document.getElementById('nav-wx');
    if (!icEl || !tEl2 || !btn) return;
    const WXI = {
      0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️', 45: '🌫️', 48: '🌫️', 51: '🌦️', 53: '🌦️',
      55: '🌧️', 61: '🌧️', 63: '🌧️', 65: '🌧️', 71: '🌨️', 73: '🌨️', 75: '❄️',
      80: '🌦️', 81: '🌧️', 82: '⛈️', 95: '⛈️', 96: '⛈️',
    };
    function cachedFresh() {
      try {
        const c = JSON.parse(localStorage.getItem('sgx-weather') || 'null');
        if (c && Date.now() - c.ts < 30 * 60 * 1000) return c.data;
      } catch (e) {}
      return null;
    }
    function cachedAny() {
      try {
        const c = JSON.parse(localStorage.getItem('sgx-weather') || 'null');
        if (c && c.data) return c.data;
      } catch (e) {}
      return null;
    }
    /** @param {any} d */
    function save(d) {
      try {
        localStorage.setItem('sgx-weather', JSON.stringify({ ts: Date.now(), data: d }));
      } catch (e) {}
    }
    /** @param {number} c */
    function fmtT(c) {
      const unit = featGet('temp-unit') === 'f' ? 'f' : 'c';
      return unit === 'f' ? Math.round((c * 9) / 5 + 32) : Math.round(c);
    }
    /** @param {any} d */
    function render(d) {
      if (!d || !d.current) return;
      icEl.textContent = WXI[d.current.weather_code] || '☁️';
      tEl2.textContent = fmtT(d.current.temperature_2m) + '°';
      btn.style.display = '';
      btn.title = (d.city || '') + (en ? ' weather' : ' 天气');
      renderWxPop(d);
    }
    function hide() {
      btn.style.display = 'none';
    }
    /** @param {any} d */
    function renderWxPop(d) {
      const pop = document.getElementById('nav-wx-pop');
      if (!pop || !d || !d.current) return;
      const cur = d.current,
        day = d.daily;
      let h =
        '<div class="wxp-city">' +
        ((d.city || '').replace(/</g, '&lt;') || (en ? 'Weather' : '天气')) +
        '</div>' +
        '<div class="wxp-main"><span class="wxp-ic">' +
        (WXI[cur.weather_code] || '☁️') +
        '</span>' +
        '<span class="wxp-temp clock-num">' +
        fmtT(cur.temperature_2m) +
        '°</span></div>';
      if (day && day.temperature_2m_max && day.temperature_2m_min) {
        h +=
          '<div class="wxp-hilo">' +
          (en ? 'H:' : '最高 ') +
          fmtT(day.temperature_2m_max[0]) +
          '°  ' +
          (en ? 'L:' : '最低 ') +
          fmtT(day.temperature_2m_min[0]) +
          '°</div>';
      }
      pop.innerHTML = '<div class="dex-pop-card">' + h + '</div>';
    }
    const c = cachedFresh();
    if (c) render(c);
    /* 和首页小组件共用一份缓存；首页会负责拉取，这里只做兜底拉取 */
    if (!c) {
      fetch('/api/geo')
        .then(function (r) {
          return r.json();
        })
        .catch(function () {
          return {};
        })
        .then(function (g) {
          const lat = parseFloat(g.latitude),
            lon = parseFloat(g.longitude);
          if (!isFinite(lat) || !isFinite(lon)) throw 0;
          return fetch(
            'https://api.open-meteo.com/v1/forecast?latitude=' +
              lat +
              '&longitude=' +
              lon +
              '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1'
          )
            .then(function (r) {
              if (!r.ok) throw 0;
              return r.json();
            })
            .then(function (j) {
              const d = { current: j.current, daily: j.daily, city: g.city || '' };
              save(d);
              render(d);
            });
        })
        .catch(function () {
          const old = cachedAny();
          if (old) render(old);
          else hide();
        });
    }
    on(window, 'sgx-settings-changed', function () {
      const cc = cachedFresh();
      if (cc) render(cc);
    });
    /* 天气面板：从顶栏往下展开 */
    /** @param {Event} [e] */
    function toggleWxPop(e) {
      const pop = document.getElementById('nav-wx-pop');
      if (!pop) return;
      if (e) e.stopPropagation();
      const cc = cachedFresh() || cachedAny();
      if (cc) renderWxPop(cc);
      pop.classList.toggle('open');
    }
    on(btn, 'click', toggleWxPop);
    on(document, 'click', function (/** @type {MouseEvent} */ e) {
      const pop = document.getElementById('nav-wx-pop');
      const t = /** @type {Element|null} */ (e.target);
      if (pop && pop.classList.contains('open') && t && !pop.contains(t) && !btn.contains(t))
        pop.classList.remove('open');
    });
    on(document, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Escape') {
        const pop = document.getElementById('nav-wx-pop');
        if (pop) pop.classList.remove('open');
      }
    });
  })();

  /* ---- DeX 应用抽屉（底部 Dock 按钮，从 Dock 上方往上展开） ---- */
  (function () {
    const dr = document.getElementById('dex-drawer');
    const btn = document.getElementById('dex-dock-drawer');
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('dex-drawer-search'));
    const grid = document.getElementById('dex-drawer-grid');
    if (!dr || !btn) return;
    function open() {
      dr.classList.remove('hidden');
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          dr.classList.add('open');
        });
      });
      window.setTimeout(function () {
        if (input) input.focus();
      }, 80);
    }
    function close() {
      dr.classList.remove('open');
      window.setTimeout(function () {
        if (!dr.classList.contains('open')) dr.classList.add('hidden');
      }, 240);
    }
    on(btn, 'click', function (e) {
      e.stopPropagation();
      if (dr.classList.contains('open')) close();
      else open();
    });
    dr.querySelectorAll('[data-dex-drawer-close]').forEach(function (el) {
      on(el, 'click', close);
    });
    on(document, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Escape' && dr.classList.contains('open')) close();
    });
    if (input)
      on(input, 'input', function () {
        const q = input.value.trim().toLowerCase();
        if (grid)
          grid.querySelectorAll('a').forEach(function (a) {
            a.style.display = !q || (a.dataset.name || '').toLowerCase().indexOf(q) !== -1 ? '' : 'none';
          });
      });
    /* 抽屉内跳转：主页用普通跳转，子页面用 replace（与 Dock 一致） */
    if (grid)
      on(grid, 'click', function (/** @type {MouseEvent} */ e) {
        const t = /** @type {Element|null} */ (e.target);
        const a = t && t.closest ? /** @type {HTMLAnchorElement|null} */ (t.closest('a[href]')) : null;
        if (!a || a.target === '_blank') return;
        const p = location.pathname;
        const isHome = p === '/' || p === '/en' || p === '/en/';
        if (isHome) return;
        e.preventDefault();
        location.replace(a.getAttribute('href') || '/');
      });
    /* 离开 dex 模式时关闭抽屉 */
    onDexLayoutChange(function (m) {
      if (m !== 'dex') close();
    });
  })();

  /* ---- 顶栏时钟面板（双时钟 + 日历，从顶栏往下展开） ---- */
  (function () {
    const pop = document.getElementById('dex-clock-pop');
    const btn = document.getElementById('nav-time-center');
    if (!pop || !btn) return;
    const w = /** @type {any} */ (window);
    const TZN = {
      zh: {
        'Asia/Shanghai': '北京', 'America/Los_Angeles': '洛杉矶', 'America/New_York': '纽约',
        'Europe/London': '伦敦', 'Asia/Tokyo': '东京', 'Asia/Hong_Kong': '香港', 'Asia/Seoul': '首尔',
      },
      en: {
        'Asia/Shanghai': 'Beijing', 'America/Los_Angeles': 'Los Angeles', 'America/New_York': 'New York',
        'Europe/London': 'London', 'Asia/Tokyo': 'Tokyo', 'Asia/Hong_Kong': 'Hong Kong', 'Asia/Seoul': 'Seoul',
      },
    };
    /** @param {string} tz */
    function tzName(tz) {
      const m = en ? TZN.en : TZN.zh;
      const v = m[tz];
      return v || tz.split('/').pop().replace(/_/g, ' ');
    }
    function calendar() {
      const d = new Date(),
        y = d.getFullYear(),
        mo = d.getMonth();
      const first = new Date(y, mo, 1).getDay(),
        days = new Date(y, mo + 1, 0).getDate();
      let h =
        '<div class="dex-cal-h">' + y + (en ? '/' : '年') + (mo + 1) + (en ? '' : '月') + '</div><div class="dex-cal-g">';
      (en ? ['S', 'M', 'T', 'W', 'T', 'F', 'S'] : ['日', '一', '二', '三', '四', '五', '六']).forEach(function (wd) {
        h += '<span class="dex-cal-w">' + wd + '</span>';
      });
      for (let i = 0; i < first; i++) h += '<span></span>';
      for (let dd = 1; dd <= days; dd++)
        h += '<span class="dex-cal-d' + (dd === d.getDate() ? ' today' : '') + '">' + dd + '</span>';
      return h + '</div>';
    }
    function render() {
      const local = w.__firstTz ? w.__firstTz() : 'UTC';
      let r = w.__secondTz ? w.__secondTz() : 'America/Los_Angeles';
      if (r === local) r = local === 'Asia/Shanghai' ? 'America/Los_Angeles' : 'Asia/Shanghai';
      const h12 = w.__hour12 ? w.__hour12() : false;
      /** @param {string} id @param {string} v */
      const setT = function (id, v) {
        const el = document.getElementById(id);
        if (el) el.textContent = v;
      };
      setT('dex-pop-local', fmtTz(local, h12));
      setT('dex-pop-local-c', tzName(local));
      setT('dex-pop-r', fmtTz(r, h12));
      setT('dex-pop-r-c', tzName(r));
      const cal = document.getElementById('dex-pop-cal');
      if (cal) cal.innerHTML = calendar();
    }
    function open() {
      render();
      pop.classList.remove('hidden');
      pop.classList.add('open');
    }
    function close() {
      pop.classList.remove('open');
      pop.classList.add('hidden');
    }
    /** @param {Event} [e] */
    function toggle(e) {
      if (e) e.stopPropagation();
      if (pop.classList.contains('open')) close();
      else open();
    }
    on(btn, 'click', toggle);
    on(document, 'click', function (/** @type {MouseEvent} */ e) {
      const t = /** @type {Element|null} */ (e.target);
      if (pop.classList.contains('open') && t && !pop.contains(t)) close();
    });
    on(document, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Escape' && pop.classList.contains('open')) close();
    });
    /* 离开 dex 模式时关闭时钟弹窗 */
    onDexLayoutChange(function (m) {
      if (m !== 'dex') close();
    });
  })();
}
