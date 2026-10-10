/**
 * @fileoverview 首页：双时钟、天气小组件、正在播放、封面批注、数字花园筛选。
 */
import { on } from '../lib/events.js';
import { get as featGet } from '../lib/features.js';
import { visibleInterval } from '../lib/scheduler.js';
import { openSheet } from '../shell/sheet.js';
import { toast } from '../lib/toast.js';
import { SGX } from '../lib/sgx.js';
import { markAppIcon } from '../lib/vt.js';

/* 双时钟 */
(function () {
  const root = document.getElementById('dual-clock');
  if (!root) return;
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
    try {
      return localStorage.getItem('sgx-gl-clockstyle') === '1';
    } catch (e) {
      return false;
    }
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
  visibleInterval(tick, 60000);
  on(window, 'sgx-settings-changed', tick);
})();

/* 天气（2.4.0-G：SGX_FEAT_WEATHER_SHOW 编译期可移除） */
if (SGX_FEAT_WEATHER_SHOW)
(function () {
  const root = document.getElementById('weather');
  if (!root) return;
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
  on(window, 'sgx-settings-changed', renderWeather);
  function cached() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE) || 'null');
      if (c && Date.now() - c.ts < 30 * 60 * 1000) return c.data;
    } catch (e) {}
    return null;
  }
  /** @param {any} data */
  function save(data) {
    try {
      localStorage.setItem(CACHE, JSON.stringify({ ts: Date.now(), data: data }));
    } catch (e) {}
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
    return;
  }
  const LA = { lat: 34.05, lon: -118.24, city: null };
  /* 2.7.0 定位顺序：手动城市 > 精确定位 > IP 兜底 > LA */
  function resolveLocation() {
    try {
      const mode = localStorage.getItem('sgx-weather-loc') || 'auto';
      if (mode === 'manual') {
        const mc = JSON.parse(localStorage.getItem('sgx-weather-city') || 'null');
        if (mc && isFinite(mc.lat) && isFinite(mc.lon)) {
          return Promise.resolve({ lat: mc.lat, lon: mc.lon, city: mc.name });
        }
      }
      if (mode === 'precise') {
        const pc = JSON.parse(localStorage.getItem('sgx-weather-precise') || 'null');
        if (pc && isFinite(pc.lat) && isFinite(pc.lon)) {
          return Promise.resolve({ lat: pc.lat, lon: pc.lon, city: null });
        }
      }
    } catch (e) {}
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
          try {
            const oc = JSON.parse(localStorage.getItem(CACHE) || 'null');
            if (oc && oc.data) old = oc.data;
          } catch (e) {}
          if (old) render(old, true);
          else noData();
        });
    });
})();

/* ===== 正在播放：真播放器（Apple 30s 试听） ===== */
(function () {
  const w = /** @type {any} */ (window);
  /** @type {Array<any>} */
  let songs = [];
  try {
    songs = JSON.parse(document.getElementById('np-data').textContent || '[]') || [];
  } catch (e) {}
  const npW = document.getElementById('np-widget');
  let seedIdx = 0;
  try {
    seedIdx = parseInt((npW && npW.dataset.idx) || '0', 10) || 0;
  } catch (e) {}
  /* 上次听的歌（head 预读）优先，没有则用模板按日期固定的那首，绝不随机切换 */
  let mi = seedIdx;
  if (typeof w.__npIdx === 'number' && w.__npIdx >= 0 && w.__npIdx < songs.length) mi = w.__npIdx;
  if (!songs.length) return;
  const cov = /** @type {HTMLImageElement} */ (document.getElementById('np-cover'));
  const ti = document.getElementById('np-title'),
    ar = document.getElementById('np-art'),
    lk = /** @type {HTMLAnchorElement} */ (document.getElementById('np-link')),
    au = /** @type {HTMLAudioElement} */ (document.getElementById('np-audio')),
    badge = document.getElementById('np-badge'),
    prog = document.getElementById('np-prog'),
    bar = /** @type {HTMLElement} */ (document.getElementById('np-bar')),
    curT = document.getElementById('np-cur'),
    durT = document.getElementById('np-dur'),
    btnPlay = /** @type {HTMLElement} */ (document.getElementById('np-play')),
    icPlay = document.getElementById('np-ic-play'),
    icPause = document.getElementById('np-ic-pause'),
    icExt = document.getElementById('np-ic-ext');
  if (!cov || !au || !btnPlay) return;
  const en = document.documentElement.lang === 'en';
  let playing = false,
    retried = false;
  /** @param {number} s */
  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function npSave() {
    try {
      localStorage.setItem('sgx-np-idx', String(mi));
    } catch (e) {}
  }
  function hasPv() {
    return !!(songs[mi] && songs[mi].preview);
  }
  function setIcons() {
    const hp = hasPv();
    if (icPlay) icPlay.classList.toggle('hidden', !hp || playing);
    if (icPause) icPause.classList.toggle('hidden', !hp || !playing);
    if (icExt) icExt.classList.toggle('hidden', hp);
    if (badge) badge.style.display = hp ? '' : 'none';
    if (prog) prog.style.display = hp ? '' : 'none';
    btnPlay.setAttribute(
      'aria-label',
      hp ? (playing ? (en ? 'Pause' : '暂停') : en ? 'Play' : '播放') : en ? 'Open link' : '打开链接'
    );
  }
  function mediaSession() {
    if (!('mediaSession' in navigator) || !songs[mi]) return;
    try {
      /** @type {any} */ (navigator).mediaSession.metadata = new /** @type {any} */ (window).MediaMetadata({
        title: songs[mi].title || '',
        artist: songs[mi].artist || '',
        artwork: songs[mi].cover ? [{ src: songs[mi].cover, sizes: '512x512', type: 'image/webp' }] : [],
      });
      /** @type {any} */ (navigator).mediaSession.setActionHandler('previoustrack', function () {
        step(-1);
        play();
      });
      /** @type {any} */ (navigator).mediaSession.setActionHandler('nexttrack', function () {
        step(1);
        play();
      });
      /** @type {any} */ (navigator).mediaSession.setActionHandler('play', function () {
        play();
      });
      /** @type {any} */ (navigator).mediaSession.setActionHandler('pause', function () {
        pause();
      });
    } catch (e) {}
  }
  /** @param {boolean} show */
  function dexNote(show) {
    const n = document.getElementById('nav-music-note');
    if (n) n.style.display = show ? '' : 'none';
    if (!show) {
      const p = document.getElementById('dex-music-pop');
      if (p) p.classList.add('hidden');
    }
  }
  /** @type {{fn: (() => void)|null}} */
  const syncPopRef = { fn: null };
  function syncPop() {
    if (syncPopRef.fn) syncPopRef.fn();
  }
  /* DeX 迷你窗：内容同步 + 开关 + 按钮 */
  (function () {
    const note = document.getElementById('nav-music-note'),
      pop = document.getElementById('dex-music-pop');
    if (!note || !pop) return;
    /** 同步迷你窗内容（模块内共享，不再挂 window） */
    function npSyncPop() {
      if (!songs[mi]) return;
      /** @param {string} id @param {string|number} v */
    const setT = function (id, v) {
        const el = document.getElementById(id);
        if (el) el.textContent = String(v);
      };
      const cover = /** @type {HTMLImageElement|null} */ (document.getElementById('dmp-cover'));
      if (cover) {
        cover.src = songs[mi].cover;
        cover.alt = songs[mi].title;
      }
      setT('dmp-title', songs[mi].title);
      setT('dmp-artist', songs[mi].artist || '');
      const ip = document.getElementById('dmp-ic-play'),
        ipa = document.getElementById('dmp-ic-pause');
      if (ip) ip.classList.toggle('hidden', playing);
      if (ipa) ipa.classList.toggle('hidden', !playing);
    }
    syncPopRef.fn = npSyncPop;
    on(note, 'click', function (e) {
      e.stopPropagation();
      npSyncPop();
      pop.classList.toggle('hidden');
    });
    on(document, 'click', function (/** @type {MouseEvent} */ e) {
      const t = /** @type {Element|null} */ (e.target);
      if (!pop.classList.contains('hidden') && t && !t.closest('#dex-music-pop') && !t.closest('#nav-music-note'))
        pop.classList.add('hidden');
    });
    const dp = document.getElementById('dmp-prev'),
      dn = document.getElementById('dmp-next'),
      dpl = document.getElementById('dmp-play');
    if (dp)
      on(dp, 'click', function () {
        step(-1);
        npSyncPop();
      });
    if (dn)
      on(dn, 'click', function () {
        step(1);
        npSyncPop();
      });
    if (dpl)
      on(dpl, 'click', function () {
        if (playing) pause();
        else play();
        npSyncPop();
      });
  })();
  function render() {
    if (!songs.length) return;
    const s = songs[mi];
    cov.src = s.cover;
    cov.alt = s.title;
    if (ti) ti.textContent = s.title;
    if (ar) ar.textContent = s.artist || '';
    lk.href = s.url;
    pause(true);
    au.removeAttribute('src');
    au.load();
    bar.style.width = '0%';
    if (curT) curT.textContent = '0:00';
    if (durT) durT.textContent = s.preview ? '0:30' : '--:--';
    retried = false;
    setIcons();
    mediaSession();
    syncPop();
  }
  /** @param {number} d */
  function step(d) {
    mi = (mi + d + songs.length) % songs.length;
    npSave();
    render();
  }
  function play() {
    if (!hasPv()) {
      window.open(songs[mi].url, '_blank', 'noopener');
      return;
    }
    if (!au.src) au.src = songs[mi].preview;
    au.play().catch(function () {});
  }
  /** @param {boolean} [silent] */
  function pause(silent) {
    if (!au.paused) au.pause();
    if (playing || !silent) {
      playing = false;
      setIcons();
      dexNote(false);
    }
  }
  on(au, 'play', function () {
    playing = true;
    setIcons();
    dexNote(true);
    mediaSession();
    syncPop();
  });
  on(au, 'pause', function () {
    playing = false;
    setIcons();
    dexNote(false);
    syncPop();
  });
  on(au, 'timeupdate', function () {
    const d = au.duration || 30;
    bar.style.width = Math.min(100, (au.currentTime / d) * 100) + '%';
    if (curT) curT.textContent = fmt(au.currentTime);
    if (durT) durT.textContent = fmt(d);
  });
  on(au, 'ended', function () {
    /* 播完自动下一首，跳过没有试听的歌 */
    let n = mi;
    for (let k = 0; k < songs.length; k++) {
      n = (n + 1) % songs.length;
      if (songs[n].preview) break;
    }
    mi = n;
    npSave();
    render();
    play();
  });
  on(au, 'error', function () {
    /* 报错时用 iTunes lookup(JSONP)重取一次 */
    if (retried || !songs[mi] || !songs[mi].apple_id) return;
    retried = true;
    const cb = '__npPv' + Date.now();
    const w2 = /** @type {any} */ (window);
    w2[cb] = function (/** @type {any} */ d) {
      try {
        const pu = d && d.results && d.results[0] && d.results[0].previewUrl;
        if (pu) {
          songs[mi].preview = pu;
          au.src = pu;
          au.play().catch(function () {});
        }
      } catch (e) {}
      try {
        delete w2[cb];
      } catch (e) {}
      if (sc.parentNode) sc.remove();
    };
    const sc = document.createElement('script');
    sc.src =
      'https://itunes.apple.com/lookup?callback=' + cb + '&id=' + encodeURIComponent(songs[mi].apple_id) +
      '&country=' + encodeURIComponent(songs[mi].apple_country || 'us');
    sc.onerror = function () {
      try {
        delete w2[cb];
      } catch (e) {}
      if (sc.parentNode) sc.remove();
    };
    document.head.appendChild(sc);
    window.setTimeout(function () {
      if (w2[cb]) {
        try {
          delete w2[cb];
        } catch (e) {}
        if (sc.parentNode) sc.remove();
      }
    }, 12000);
  });
  /* 供歌单页调用：暂停首页试听（经 SGX 桥接） */
  SGX.npPause = function () {
    pause();
  };
  render();
  const prev = document.getElementById('np-prev'),
    next = document.getElementById('np-next');
  if (prev)
    on(prev, 'click', function () {
      step(-1);
    });
  if (next)
    on(next, 'click', function () {
      step(1);
    });
  on(btnPlay, 'click', function () {
    if (playing) pause();
    else play();
  });
  /* 首页刷新回到顶部 */
  if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
  }
  window.scrollTo(0, 0);
})();

/* 触屏：手机上用 bottom sheet 显示批注，大屏触屏仍用封面浮层 */
(function () {
  const isMobile = function () {
    return window.matchMedia('(max-width:639px)').matches;
  };
  /**
   * @param {string} title
   * @param {string} comment
   */
  function openCommentSheet(title, comment) {
    openSheet({
      title: title,
      html: '<p class="text-sm leading-relaxed text-m-on-surface px-1">' + comment.replace(/</g, '&lt;') + '</p>',
    });
  }
  if (window.matchMedia('(hover: none)').matches) {
    document.querySelectorAll('.cover-toggle').forEach(function (el) {
      const isLink = el.tagName === 'A';
      const commentEl = el.querySelector('.cover-comment p');
      const comment = commentEl ? commentEl.textContent || '' : '';
      const title = el.getAttribute('aria-label') || '';
      /** @param {Event} [e] */
      function toggle(e) {
        if (isMobile() && comment) {
          if (e) e.preventDefault();
          openCommentSheet(title, comment);
          return;
        }
        if (el.classList.contains('comment-open')) {
          if (!isLink) {
            el.classList.remove('comment-open');
          }
        } else {
          if (e) e.preventDefault();
          document.querySelectorAll('.cover-toggle.comment-open').forEach(function (o) {
            if (o !== el) o.classList.remove('comment-open');
          });
          el.classList.add('comment-open');
        }
      }
      on(el, 'click', toggle);
      on(el, 'keydown', function (/** @type {KeyboardEvent} */ e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle(e);
        }
      });
    });
    on(document, 'click', function (/** @type {MouseEvent} */ e) {
      const t = /** @type {Element|null} */ (e.target);
      if (t && !t.closest('.cover-toggle')) {
        document.querySelectorAll('.cover-toggle.comment-open').forEach(function (o) {
          o.classList.remove('comment-open');
        });
      }
    });
  }
})();

/* 数字花园筛选 */
(function () {
  const pills = document.querySelectorAll('#garden-filters .garden-pill'),
    stagePills = document.querySelectorAll('#garden-filters .stage-pill'),
    cards = document.querySelectorAll('#garden-grid .garden-card');
  if (!pills.length && !stagePills.length) return;
  let activeTag = '',
    activeStage = '';
  const activeCls = 'rounded-full px-4 py-1.5 text-sm font-medium bg-m-primary text-m-on-primary transition-colors';
  const idleCls =
    'rounded-full px-4 py-1.5 text-sm font-medium border border-m-outline text-m-on-surface-variant hover:border-m-primary transition-colors';
  function apply() {
    cards.forEach(function (c) {
      const el = /** @type {HTMLElement} */ (c);
      const tags = (el.dataset.tags || '').split(',');
      const okTag = !activeTag || tags.indexOf(activeTag) !== -1,
        okStage = !activeStage || el.dataset.stage === activeStage;
      el.style.display = okTag && okStage ? '' : 'none';
    });
  }
  /**
   * @param {NodeListOf<Element>} list
   * @param {string} kind
   * @param {(v: string) => void} set
   */
  function bind(list, kind, set) {
    list.forEach(function (p) {
      on(p, 'click', function () {
        list.forEach(function (x) {
          x.className = (kind === 'garden' ? 'garden-pill ' : 'stage-pill ') + idleCls;
        });
        p.className = (kind === 'garden' ? 'garden-pill ' : 'stage-pill ') + activeCls;
        set(kind === 'garden' ? p.getAttribute('data-tag') || '' : p.getAttribute('data-stage') || '');
        apply();
      });
    });
  }
  bind(pills, 'garden', function (v) {
    activeTag = v;
  });
  bind(stagePills, 'stage', function (v) {
    activeStage = v;
  });
})();

/* 2.4.0 D：App 图标点击 → View Transitions 共享元素标记 */
(function () {
  document.querySelectorAll('.app-tile[href]').forEach(function (tile) {
    on(tile, 'click', function () {
      const icon = tile.querySelector('span');
      if (icon) markAppIcon(/** @type {HTMLElement} */ (icon));
    }, { capture: true });
  });
})();
