/**
 * @fileoverview 首页：双时钟、天气小组件、日刻今日一句。
 * 2026-10-24 页内切换（shell/inpage-tabs.js）：不再在 import 时直接跑，改成 mountHome()——
 * 首页这块 DOM 只挂一次（切走时连 DOM 一起留着，回来不重画），activate / deactivate 管全局的东西：
 * 时钟定时器、sgx-settings-changed 监听；切走即停，切回来先按当前设置重画一次再继续。
 */
import { on } from '../lib/events.js';
import { get as featGet } from '../lib/features.js';
import { visibleInterval } from '../lib/scheduler.js';
import { get, getJSON, setJSON } from '../lib/storage.js';
import { mountDaymarkToday } from '../lib/daymark-today.js';

/* 双时钟：返回 { start, stop } */
function clockPart() {
  const root = document.getElementById('dual-clock');
  if (!root) return null;
  const en = document.documentElement.lang === 'en';
  const w = /** @type {any} */ (window);
  const CITY = {
    zh: {
      'Asia/Shanghai': '北京', 'Asia/Tokyo': '东京', 'Asia/Hong_Kong': '香港', 'Asia/Seoul': '首尔',
      'Asia/Taipei': '台北', 'Asia/Singapore': '新加坡', 'Asia/Dubai': '迪拜',
      'America/Los_Angeles': '洛杉矶', 'America/New_York': '纽约', 'America/Chicago': '芝加哥',
      'America/Toronto': '多伦多', 'America/Vancouver': '温哥华',
      'Europe/London': '伦敦', 'Europe/Paris': '巴黎', 'Europe/Berlin': '柏林',
      'Australia/Sydney': '悉尼', 'Pacific/Auckland': '奥克兰',
    },
    en: {
      'Asia/Shanghai': 'Beijing', 'Asia/Tokyo': 'Tokyo', 'Asia/Hong_Kong': 'Hong Kong', 'Asia/Seoul': 'Seoul',
      'Asia/Taipei': 'Taipei', 'Asia/Singapore': 'Singapore', 'Asia/Dubai': 'Dubai',
      'America/Los_Angeles': 'Los Angeles', 'America/New_York': 'New York', 'America/Chicago': 'Chicago',
      'America/Toronto': 'Toronto', 'America/Vancouver': 'Vancouver',
      'Europe/London': 'London', 'Europe/Paris': 'Paris', 'Europe/Berlin': 'Berlin',
      'Australia/Sydney': 'Sydney', 'Pacific/Auckland': 'Auckland',
    },
  };
  const SUN =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  function firstTz() {
    return w.__firstTz ? w.__firstTz() : 'UTC';
  }
  function remoteTzNow() {
    const ft = firstTz();
    let remoteTz = w.__secondTz ? w.__secondTz() : 'America/Los_Angeles';
    if (remoteTz === ft) remoteTz = ft === 'Asia/Shanghai' ? 'America/Los_Angeles' : 'Asia/Shanghai';
    return remoteTz;
  }
  function hour12Now() {
    return w.__hour12 ? w.__hour12() : false;
  }
  /** @param {string} tz */
  function cityName(tz) {
    const m = en ? CITY.en : CITY.zh;
    return m[tz] || tz.split('/').pop().replace(/_/g, ' ');
  }
  /** @param {string} tz @param {Date} d */
  function tzOffsetMin(tz, d) {
    try {
      const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
      const tzd = new Date(d.toLocaleString('en-US', { timeZone: tz }));
      return Math.round((tzd.getTime() - utc.getTime()) / 60000);
    } catch (e) {
      return 0;
    }
  }
  /** @param {string} tz @param {Date} d @param {boolean} h12 */
  function parts(tz, d, h12) {
    try {
      const f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: h12, weekday: 'short', month: 'numeric',
        day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      /** @type {Record<string, string>} */
      const p = {};
      f.formatToParts(d).forEach(function (x) {
        p[x.type] = x.value;
      });
      let h = parseInt(p.hour, 10);
      if (h === 24) h = 0;
      return { h: h, mi: p.minute, ap: p.dayPeriod || '', wd: p.weekday, mo: p.month, day: p.day };
    } catch (e) {
      return null;
    }
  }
  const WD_ZH = { Sun: '周日', Mon: '周一', Tue: '周二', Wed: '周三', Thu: '周四', Fri: '周五', Sat: '周六' };
  function analogMode() {
    return get('sgx-gl-clockstyle') === '1';
  }
  /** @param {number} h @param {string} mi @param {string} fg */
  function analogSVG(h, mi, fg) {
    const ha = (h % 12) * 30 + parseInt(mi, 10) * 0.5,
      ma = parseInt(mi, 10) * 6;
    let ticks = '';
    for (let i = 0; i < 12; i++) {
      const a = ((i * 30) * Math.PI) / 180,
        x1 = 50 + 44 * Math.sin(a),
        y1 = 50 - 44 * Math.cos(a),
        x2 = 50 + 38 * Math.sin(a),
        y2 = 50 - 38 * Math.cos(a);
      ticks +=
        '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) +
        '" stroke="' + fg + '" stroke-width="' + (i % 3 === 0 ? 3 : 1.5) + '" stroke-linecap="round" opacity=".55"/>';
    }
    return (
      '<svg viewBox="0 0 100 100" class="analog-face" aria-hidden="true"><circle cx="50" cy="50" r="47" fill="none" stroke="' +
      fg + '" stroke-width="2" opacity=".35"/>' + ticks +
      '<line x1="50" y1="50" x2="50" y2="28" stroke="' + fg + '" stroke-width="4.5" stroke-linecap="round" transform="rotate(' + ha + ' 50 50)"/>' +
      '<line x1="50" y1="50" x2="50" y2="16" stroke="' + fg + '" stroke-width="3" stroke-linecap="round" transform="rotate(' + ma + ' 50 50)"/>' +
      '<circle cx="50" cy="50" r="3.5" fill="' + fg + '"/></svg>'
    );
  }
  /**
   * @param {string} pre
   * @param {string} tz
   * @param {Date} d
   * @param {boolean} h12
   */
  function renderHalf(pre, tz, d, h12) {
    const q = parts(tz, d, h12);
    if (!q) return 0;
    const isDay = q.h >= 6 && q.h < 18;
    /** @param {string} id @param {(el: HTMLElement) => void} fn */
    const withEl = function (id, fn) {
      const el = document.getElementById(id);
      if (el) fn(el);
    };
    withEl(pre + '-icon', function (el) {
      el.innerHTML = isDay ? SUN : MOON;
    });
    withEl(pre + '-city', function (el) {
      el.textContent = cityName(tz);
    });
    const timeEl = document.getElementById(pre + '-time');
    if (timeEl) {
      if (analogMode()) {
        timeEl.innerHTML = analogSVG(q.h, q.mi, isDay ? 'currentColor' : '#ffffff');
        timeEl.classList.add('analog-on');
      } else {
        const hh = h12 ? (q.h % 12 === 0 ? 12 : q.h % 12) : q.h;
        timeEl.classList.remove('analog-on');
        timeEl.textContent = String(hh).padStart(2, '0') + ':' + q.mi + (h12 ? ' ' + q.ap : '');
      }
    }
    withEl(pre + '-date', function (el) {
      el.textContent = en ? q.wd + ', ' + q.mo + '/' + q.day : q.mo + '月' + q.day + '日 ' + WD_ZH[q.wd];
    });
    const half = document.getElementById(pre === 'clk-l' ? 'clk-l' : 'clk-r');
    if (half) {
      half.classList.toggle('clock-night', !isDay);
      half.classList.toggle('clock-day', isDay);
    }
    return q.h;
  }
  function tick() {
    const d = new Date(),
      h12 = hour12Now(),
      ft = firstTz(),
      rtz = remoteTzNow();
    renderHalf('clk-l', ft, d, h12);
    renderHalf('clk-r', rtz, d, h12);
    const diffH = Math.round((tzOffsetMin(rtz, d) - tzOffsetMin(ft, d)) / 60);
    const el = document.getElementById('clk-r-diff');
    if (!el) return;
    if (diffH === 0) el.textContent = en ? 'Same time' : '同一时区';
    else if (diffH > 0) el.textContent = en ? diffH + ' hrs ahead' : '+' + diffH + ' 小时';
    else el.textContent = en ? -diffH + ' hrs behind' : diffH + ' 小时';
  }
  /** @type {Array<() => void>} */
  let offs = [];
  return {
    start() {
      if (offs.length) return;
      offs = [visibleInterval(tick, 60000), on(window, 'sgx-settings-changed', tick)];
    },
    stop() {
      offs.forEach((f) => f());
      offs = [];
    },
  };
}

/* 天气（2.4.0-G：SGX_FEAT_WEATHER_SHOW 编译期可移除）：返回 { start, stop }（start = 按缓存重画 + 听设置变化） */
function weatherPart() {
  if (!SGX_FEAT_WEATHER_SHOW) return null;
  const root = document.getElementById('weather');
  if (!root) return null;
  const en = document.documentElement.lang === 'en';
  const CACHE = 'sgx-weather';
  const WMO = [
    [0, 'Clear', '晴', '☀️', '🌙'], [1, 'Mainly clear', '晴', '🌤️', '🌙'], [2, 'Partly cloudy', '多云', '⛅', '☁️'],
    [3, 'Overcast', '阴', '☁️', '☁️'], [45, 'Fog', '雾', '🌫️', '🌫️'], [48, 'Rime fog', '雾凇', '🌫️', '🌫️'],
    [51, 'Light drizzle', '毛毛雨', '🌦️', '🌦️'], [53, 'Drizzle', '毛毛雨', '🌦️', '🌦️'], [55, 'Heavy drizzle', '大毛毛雨', '🌧️', '🌧️'],
    [61, 'Light rain', '小雨', '🌧️', '🌧️'], [63, 'Rain', '中雨', '🌧️', '🌧️'], [65, 'Heavy rain', '大雨', '🌧️', '🌧️'],
    [71, 'Light snow', '小雪', '🌨️', '🌨️'], [73, 'Snow', '中雪', '🌨️', '🌨️'], [75, 'Heavy snow', '大雪', '❄️', '❄️'],
    [80, 'Light showers', '阵雨', '🌦️', '🌦️'], [81, 'Showers', '阵雨', '🌧️', '🌧️'], [82, 'Heavy showers', '暴雨', '⛈️', '⛈️'],
    [95, 'Thunderstorm', '雷阵雨', '⛈️', '⛈️'], [96, 'Storm with hail', '冰雹', '⛈️', '⛈️'],
  ];
  /** @param {number} code @param {boolean} isDay */
  function wmoInfo(code, isDay) {
    for (let i = 0; i < WMO.length; i++) {
      if (WMO[i][0] === code) return { desc: en ? WMO[i][1] : WMO[i][2], icon: isDay ? WMO[i][3] : WMO[i][4] };
    }
    return { desc: en ? 'Unknown' : '未知', icon: '☁️' };
  }
  /** @param {number} code @param {boolean} isDay */
  function bgFor(code, isDay) {
    if (!isDay) return 'linear-gradient(135deg,#33316e,#1c1a45)';
    if (code === 0 || code === 1) return 'linear-gradient(135deg,#4a9fe3,#1e6fc4)';
    if (code === 2) return 'linear-gradient(135deg,#5b8ec4,#2e5a8a)';
    if (code >= 51) return 'linear-gradient(135deg,#3d5f8f,#1d2f4d)';
    return 'linear-gradient(135deg,#6b8aa5,#3d5a75)';
  }
  function tempUnit() {
    try {
      return featGet('temp-unit') === 'f' ? 'f' : 'c';
    } catch (e) {
      return 'c';
    }
  }
  /** @param {number} c */
  function fmtT(c) {
    return tempUnit() === 'f' ? Math.round((c * 9) / 5 + 32) : Math.round(c);
  }
  /** @param {any} d @param {boolean} instant */
  function render(d, instant) {
    try {
      if (!featGet('weather-show')) {
        root.classList.add('hidden');
        return;
      }
    } catch (e) {}
    const cur = d.current,
      day = d.daily;
    const isDay = cur.is_day === 1;
    const info = wmoInfo(cur.weather_code, isDay);
    root.style.background = bgFor(cur.weather_code, isDay);
    /** @param {string} id @param {string|number} v */
    const setT = function (id, v) {
      const el = document.getElementById(id);
      if (el) el.textContent = String(v);
    };
    setT('wx-city', d.city || (en ? 'Los Angeles' : '洛杉矶'));
    setT('wx-temp', fmtT(cur.temperature_2m) + '°');
    setT('wx-icon', info.icon);
    setT('wx-desc', info.desc);
    const hi = fmtT(day.temperature_2m_max[0]),
      lo = fmtT(day.temperature_2m_min[0]);
    setT('wx-hilo', (en ? 'H:' : '最高 ') + hi + '°  ' + (en ? 'L:' : '最低 ') + lo + '°');
    root.classList.remove('hidden');
    /* 无缓存时只淡入数字，不闪整张卡 */
    if (!instant) {
      const nums = document.getElementById('wx-main');
      if (nums) {
        nums.classList.add('wx-fade', 'wx-out');
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            nums.classList.remove('wx-out');
          });
        });
      }
    }
  }
  function renderWeather() {
    const c = cached();
    if (c) render(c, true);
    else {
      try {
        if (!featGet('weather-show')) root.classList.add('hidden');
      } catch (e) {}
    }
  }
  /** @type {(() => void)|null} */
  let off = null;
  const ctl = {
    start() {
      if (off) return;
      off = on(window, 'sgx-settings-changed', renderWeather);
    },
    stop() {
      if (off) off();
      off = null;
    },
    /** 切回首页：设置可能在别的栏改过（温度单位、显示开关），按缓存重画 */
    repaint: renderWeather,
  };
  function cached() {
    const c = getJSON(CACHE, null);
    if (c && Date.now() - c.ts < 30 * 60 * 1000) return c.data;
    return null;
  }
  /** @param {any} data */
  function save(data) {
    setJSON(CACHE, { ts: Date.now(), data: data });
  }
  function noData() {
    const t = document.getElementById('wx-temp');
    if (t) t.style.visibility = 'hidden';
    const ic = document.getElementById('wx-icon');
    if (ic) ic.textContent = '☁️';
  }
  /** @param {number} lat @param {number} lon @param {string|null} city */
  function fetchWx(lat, lon, city) {
    const u =
      'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
      '&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1';
    return fetch(u)
      .then(function (r) {
        if (!r.ok) throw 0;
        return r.json();
      })
      .then(function (j) {
        return { current: j.current, daily: j.daily, city: city };
      });
  }
  const c = cached();
  if (c) {
    render(c, true);
    return ctl;
  }
  const LA = { lat: 34.05, lon: -118.24, city: null };
  /* 2.7.0 定位顺序：手动城市 > 精确定位 > IP 兜底 > LA */
  function resolveLocation() {
    const mode = get('sgx-weather-loc') || 'auto';
    if (mode === 'manual') {
      const mc = getJSON('sgx-weather-city', null);
      if (mc && isFinite(mc.lat) && isFinite(mc.lon)) {
        return Promise.resolve({ lat: mc.lat, lon: mc.lon, city: mc.name });
      }
    }
    if (mode === 'precise') {
      const pc = getJSON('sgx-weather-precise', null);
      if (pc && isFinite(pc.lat) && isFinite(pc.lon)) {
        return Promise.resolve({ lat: pc.lat, lon: pc.lon, city: null });
      }
    }
    return fetch('/api/geo')
      .then(function (r) {
        return r.json();
      })
      .catch(function () {
        return {};
      })
      .then(function (g) {
        const lat = parseFloat(g.latitude),
          lon = parseFloat(g.longitude);
        if (!isFinite(lat) || !isFinite(lon)) return LA;
        return { lat: lat, lon: lon, city: g.city || null };
      });
  }
  resolveLocation()
    .then(function (loc) {
      if (!loc || !isFinite(loc.lat) || !isFinite(loc.lon)) {
        return fetchWx(LA.lat, LA.lon, null);
      }
      return fetchWx(loc.lat, loc.lon, loc.city || null);
    })
    .then(function (d) {
      save(d);
      render(d, false);
    })
    .catch(function () {
      fetchWx(LA.lat, LA.lon, null)
        .then(function (d) {
          save(d);
          render(d, false);
        })
        .catch(function () {
          let old = null;
          const oc = getJSON(CACHE, null);
          if (oc && oc.data) old = oc.data;
          if (old) render(old, true);
          else noData();
        });
    });
  return ctl;
}

/**
 * 挂首页（每块首页 DOM 只调一次）。返回 activate / deactivate（页内切换进出时调）；不在首页（没有 #home-widgets）返回 null。
 * @param {{direct?: boolean}} [o] direct：这一栏就是直接打开 / 刷新的那页（照旧回到顶部）
 * @returns {{activate: () => void, deactivate: () => void}|null}
 */
export function mountHome(o) {
  if (!document.getElementById('home-widgets')) return null;
  /* 首页刷新回到顶部（只管直接打开 / 刷新；页内切回来按记住的位置） */
  if (o && o.direct) {
    if ('scrollRestoration' in history) {
      history.scrollRestoration = 'manual';
    }
    window.scrollTo(0, 0);
  }
  const clock = clockPart();
  const wx = weatherPart();
  /* 日刻 · 今日一句：daymark.styrigx.com/api/today（公开只读）。与锁屏共用 lib/daymark-today.js：
     先画本地缓存（同一天才用），再静默拉新；拉失败且没缓存 → 卡片保持隐藏。只在挂上时拉一次。 */
  const dm = document.getElementById('w-daymark');
  if (dm) mountDaymarkToday(dm, { en: document.documentElement.lang === 'en' });
  let first = true;
  return {
    activate() {
      if (clock) clock.start();
      if (wx) {
        if (!first) wx.repaint();
        wx.start();
      }
      first = false;
    },
    deactivate() {
      if (clock) clock.stop();
      if (wx) wx.stop();
    },
  };
}
