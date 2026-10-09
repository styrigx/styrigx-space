/**
 * @fileoverview 首页全屏锁屏（2.3.14）：纯 JS 生成（渐进增强）。
 * 关了 JS 或搜索引擎抓取时，首页原内容不受影响。只在首页执行。
 */
import { on } from './events.js';
import { visibleInterval } from './scheduler.js';
import { reducedMotion } from './util.js';

const LOCK =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const UNLOCK =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.9-1"/></svg>';

/**
 * 初始化锁屏（非首页直接返回）。
 */
export function initLock() {
  const p = location.pathname;
  const isHome = p === '/' || p === '/en' || p === '/en/';
  if (!isHome) return;
  const force = /(?:^|[?&])lock=1(?:&|$)/.test(location.search);
  let seen = false;
  try {
    seen = sessionStorage.getItem('sgx-lock-shown') === '1';
  } catch (e) {}
  if (seen && !force) return;

  const en = document.documentElement.lang === 'en';

  /* 天气：和顶栏同一数据来源（localStorage sgx-weather 缓存），取不到就不显示 */
  /** @returns {{icon: string, temp: string}|null} */
  function wxData() {
    try {
      if (localStorage.getItem('sgx-weather-show') === '0') return null;
      const c = JSON.parse(localStorage.getItem('sgx-weather') || 'null');
      const d = c && c.data;
      if (!d || !d.current) return null;
      const WXI = {
        0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️', 45: '🌫️', 48: '🌫️', 51: '🌦️', 53: '🌦️',
        55: '🌧️', 61: '🌧️', 63: '🌧️', 65: '🌧️', 71: '🌨️', 73: '🌨️', 75: '❄️',
        80: '🌦️', 81: '🌧️', 82: '⛈️', 95: '⛈️', 96: '⛈️',
      };
      const unit = localStorage.getItem('sgx-temp-unit') === 'f' ? 'f' : 'c';
      let t = d.current.temperature_2m;
      t = unit === 'f' ? Math.round((t * 9) / 5 + 32) : Math.round(t);
      return { icon: WXI[d.current.weather_code] || '☁️', temp: t + '°' };
    } catch (e) {
      return null;
    }
  }

  /* 头像：复用顶栏左侧头像图片 */
  const navImg = /** @type {HTMLImageElement|null} */ (document.querySelector('#nav-brand img'));
  const avatarSrc = navImg ? navImg.src : '';

  const wx = wxData();
  const ov = document.createElement('div');
  ov.id = 'sgx-lock';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', en ? 'Lock screen' : '锁屏');
  ov.innerHTML =
    '<div class="sgx-lock-top" id="sgx-lock-ic">' +
    LOCK +
    '</div>' +
    '<div class="sgx-lock-clockwrap"><div class="sgx-lock-clock" id="sgx-lock-clock">--:--</div>' +
    '<div class="sgx-lock-date"><span id="sgx-lock-date"></span>' +
    (wx
      ? '<span class="sgx-lock-wx"><span aria-hidden="true">' +
        wx.icon +
        '</span><span>' +
        wx.temp +
        '</span></span>'
      : '') +
    '</div></div>' +
    '<div class="sgx-lock-user"><button type="button" id="sgx-lock-avatar" aria-label="' +
    (en ? 'Unlock' : '解锁进入首页') +
    '">' +
    '<span class="sgx-lock-halo" aria-hidden="true"></span>' +
    (avatarSrc
      ? '<img src="' + avatarSrc + '" alt="Styrigx" width="72" height="72">'
      : '<span class="sgx-lock-fb" aria-hidden="true">S</span>') +
    '</button><div class="sgx-lock-name">Styrigx</div></div>';
  document.body.appendChild(ov);
  document.body.classList.add('sgx-locked');
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';

  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WDZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  function tick() {
    const d = new Date();
    const c = document.getElementById('sgx-lock-clock');
    if (c) c.textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const de = document.getElementById('sgx-lock-date');
    if (de)
      de.textContent = en
        ? MON[d.getMonth()] + ' ' + d.getDate() + ', ' + WD[d.getDay()]
        : d.getMonth() + 1 + '月' + d.getDate() + '日 ' + WDZH[d.getDay()];
  }
  /* 每分钟刷新；页面不可见时暂停 */
  const stopTick = visibleInterval(tick, 60000);

  let done = false;
  function cleanup() {
    stopTick();
    if (ov.parentNode) ov.parentNode.removeChild(ov);
    document.body.classList.remove('sgx-locked');
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  }
  function unlock() {
    if (done) return;
    done = true;
    try {
      sessionStorage.setItem('sgx-lock-shown', '1');
    } catch (e) {}
    const ic = document.getElementById('sgx-lock-ic');
    if (ic) ic.innerHTML = UNLOCK;
    if (reducedMotion()) {
      ov.style.transition = 'opacity .25s ease';
      ov.style.opacity = '0';
      window.setTimeout(cleanup, 280);
    } else {
      document.body.classList.remove('sgx-locked');
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          ov.classList.add('sgx-lock-out');
        });
      });
      window.setTimeout(cleanup, 450);
    }
  }
  const av = document.getElementById('sgx-lock-avatar');
  if (av) {
    on(av, 'click', function (e) {
      e.stopPropagation();
      unlock();
    });
    try {
      av.focus(/** @type {any} */ ({ preventScroll: true }));
    } catch (e) {
      try {
        av.focus();
      } catch (_) {}
    }
  }
  /* 电脑上回车/空格解锁；锁屏上其他位置点击无反应 */
  on(document, 'keydown', function (/** @type {KeyboardEvent} */ e) {
    if (done || !document.getElementById('sgx-lock')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      const t = /** @type {HTMLElement|null} */ (e.target);
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      unlock();
    }
  });
}
