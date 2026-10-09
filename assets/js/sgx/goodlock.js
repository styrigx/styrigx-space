/**
 * @fileoverview Good Lock 实验室：全站生效的模块（旧 sgx-base-a.js 末尾）。
 * 视差壁纸 / 点击音效 / 快捷键 / 边缘光效 / 访客数字健康（只存本地）。
 * 2.4.0-G：开关经 features.js 统一读写；各模块另有 SGX_FEAT_* 编译期开关。
 */
import { on } from './events.js';
import { get, set } from './storage.js';
import { get as featGet } from './features.js';
import { loadI18n } from './i18n.js';
import { openSheet } from './sheet.js';
import { reducedMotion } from './util.js';
import { visibleInterval } from './scheduler.js';

/**
 * 读 Good Lock 模块开关（经 features.js，带编译期 build 默认）。
 * @param {string} id 功能 id（gl-*）
 */
function modOn(id) {
  return !!featGet(id);
}

/** @returns {string} YYYY-M-D */
function dayStr(d) {
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

/**
 * 读今日访客数据。
 * @returns {{day: string, min: number, areas: Record<string, number>}}
 */
export function wellLoad() {
  const today = dayStr(new Date());
  try {
    const v = JSON.parse(get('sgx-well-v') || 'null');
    if (v && v.day === today) return v;
  } catch (e) {}
  return { day: today, min: 0, areas: {} };
}

/**
 * @param {{day: string, min: number, areas: Record<string, number>}} v
 */
function wellSave(v) {
  set('sgx-well-v', JSON.stringify(v));
}

let sessStart = Date.now();
let sessArea = '';

function areaOf() {
  const p = location.pathname;
  if (p === '/goodlock/' || p === '/en/goodlock/') return 'goodlock';
  if (p === '/settings/' || p === '/en/settings/') return 'settings';
  if (p === '/browser/' || p === '/en/browser/') return 'browser';
  return 'home';
}

/**
 * 结算本段会话时长并写回。
 * @returns {{day: string, min: number, areas: Record<string, number>}}
 */
export function wellFlush() {
  const v = wellLoad();
  const add = (Date.now() - sessStart) / 60000;
  v.min += add;
  v.areas[sessArea] = (v.areas[sessArea] || 0) + add;
  sessStart = Date.now();
  wellSave(v);
  return v;
}

/**
 * 初始化 Good Lock 全站模块。
 */
export function initGoodLock() {
  const T = loadI18n('sgx-i18n-core');
  const en = document.documentElement.lang === 'en';
  sessArea = areaOf();

  /* ---- 视差壁纸 ---- */
  function parallaxOn() {
    return modOn('gl-parallax');
  }
  /** @param {number} x @param {number} y */
  function applyParallax(x, y) {
    if (!parallaxOn() || reducedMotion()) return;
    const wp = document.getElementById('sgx-wallpaper');
    if (wp) wp.style.backgroundPosition = x.toFixed(1) + 'px ' + y.toFixed(1) + 'px';
  }
  /* ---- 视差壁纸（2.4.0-G：SGX_FEAT_GL_PARALLAX 编译期可移除） ---- */
  if (SGX_FEAT_GL_PARALLAX && parallaxOn() && !reducedMotion()) {
    let raf = null,
      lx = 0,
      ly = 0;
    on(
      window,
      'mousemove',
      function (/** @type {MouseEvent} */ e) {
        lx = (e.clientX / window.innerWidth - 0.5) * 22;
        ly = (e.clientY / window.innerHeight - 0.5) * 22;
        if (!raf)
          raf = requestAnimationFrame(function () {
            raf = null;
            applyParallax(lx, ly);
          });
      },
      { passive: true }
    );
    on(
      window,
      'deviceorientation',
      function (/** @type {any} */ e) {
        if (e.gamma === null || e.beta === null) return;
        applyParallax(e.gamma * 0.35, e.beta * 0.2);
      },
      { passive: true }
    );
  }

  /* ---- 点击音效（Web Audio 合成；2.4.0-G：SGX_FEAT_GL_SOUND 编译期可移除） ---- */
  if (SGX_FEAT_GL_SOUND) {
  /** @type {any} */
  let ac = null;
  function blip() {
    try {
      const AC = /** @type {any} */ (window).AudioContext || /** @type {any} */ (window).webkitAudioContext;
      if (!AC) return;
      const ctx = ac || (ac = new AC());
      if (ctx.state === 'suspended') ctx.resume();
      const o = ctx.createOscillator(),
        g = ctx.createGain(),
        t = ctx.currentTime;
      o.type = 'sine';
      o.frequency.setValueAtTime(1250, t);
      o.frequency.exponentialRampToValueAtTime(880, t + 0.05);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.06, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.1);
    } catch (e) {}
  }
  on(
    document,
    'click',
    function (/** @type {MouseEvent} */ e) {
      if (!modOn('gl-sound')) return;
      const t = /** @type {HTMLElement|null} */ (e.target);
      if (t && t.closest && t.closest('.app-tile,.dock-btn,.nav-act')) blip();
    },
    { passive: true }
  );
  } /* /SGX_FEAT_GL_SOUND */

  /* ---- 快捷键（桌面端；2.4.0-G：SGX_FEAT_GL_KEYS 编译期可移除） ---- */
  if (SGX_FEAT_GL_KEYS) {
  (function () {
    let pending = false;
    /** @type {number|null} */
    let timer = null;
    on(document, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (!modOn('gl-keys')) return;
      const t = /** @type {HTMLElement|null} */ (e.target);
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const home = en ? '/en/' : '/',
        links = en ? '/en/browser/' : '/browser/',
        setUrl = en ? '/en/settings/' : '/settings/';
      if (pending) {
        pending = false;
        if (timer) clearTimeout(timer);
        const map = { h: home, l: links, b: 'https://blog.styrigx.com', s: setUrl };
        const u = map[e.key];
        if (u) {
          e.preventDefault();
          if (u.indexOf('http') === 0) window.open(u, '_blank');
          else location.href = u;
        }
        return;
      }
      if (e.key === 'g') {
        pending = true;
        timer = window.setTimeout(function () {
          pending = false;
        }, 900);
      } else if (e.key === '?') {
        e.preventDefault();
        openSheet({
          title: T.t('kbdTitle'),
          html:
            '<div class="px-2 pb-2 text-sm space-y-2">' +
            '<div class="flex justify-between"><span><kbd class="kbd">g</kbd> <kbd class="kbd">h</kbd></span><span class="text-m-on-surface-variant">' +
            T.t('kbdHome') +
            '</span></div>' +
            '<div class="flex justify-between"><span><kbd class="kbd">g</kbd> <kbd class="kbd">l</kbd></span><span class="text-m-on-surface-variant">' +
            T.t('kbdBrowser') +
            '</span></div>' +
            '<div class="flex justify-between"><span><kbd class="kbd">g</kbd> <kbd class="kbd">b</kbd></span><span class="text-m-on-surface-variant">' +
            T.t('kbdBlog') +
            '</span></div>' +
            '<div class="flex justify-between"><span><kbd class="kbd">g</kbd> <kbd class="kbd">s</kbd></span><span class="text-m-on-surface-variant">' +
            T.t('kbdSettings') +
            '</span></div>' +
            '</div>',
        });
      }
    });
  })();
  } /* /SGX_FEAT_GL_KEYS */

  /* ---- 边缘光效（2.4.0-G：SGX_FEAT_GL_EDGEGLOW 编译期可移除） ---- */
  if (SGX_FEAT_GL_EDGEGLOW && modOn('gl-edgeglow')) document.body.classList.add('gl-edgeglow');

  /* ---- 访客数字健康（只存本地；2.4.0-G：SGX_FEAT_GL_WELLBEING 编译期可移除） ---- */
  if (SGX_FEAT_GL_WELLBEING) {
  on(window, 'pagehide', function () {
    wellFlush();
  });
  on(document, 'visibilitychange', function () {
    if (document.visibilityState === 'hidden') wellFlush();
    else sessStart = Date.now();
  });

  /* 15 分钟温和提示（每天一次） */
  function showTip() {
    const txt = T.t('wellTip');
    const t = document.createElement('div');
    t.id = 'well-toast';
    t.setAttribute('role', 'status');
    t.innerHTML =
      '<span class="flex-1">' +
      txt +
      '</span><button type="button" id="well-toast-x" aria-label="' +
      T.t('wellDismiss') +
      '" class="w-9 h-9 -m-1 rounded-full flex items-center justify-center shrink-0">✕</button>';
    document.body.appendChild(t);
    requestAnimationFrame(function () {
      t.classList.add('show');
    });
    function hide() {
      t.classList.remove('show');
      window.setTimeout(function () {
        t.remove();
      }, 300);
    }
    const x = document.getElementById('well-toast-x');
    if (x) on(x, 'click', hide);
    window.setTimeout(hide, 12000);
  }
  function checkTip() {
    if (!modOn('gl-wellbeing')) return;
    if (!SGX_FEAT_WELL_TIP || !featGet('well-tip')) return;
    const today = dayStr(new Date());
    if (get('sgx-well-tipday') === today) return;
    const v = wellLoad(),
      total = v.min + (Date.now() - sessStart) / 60000;
    if (total >= 15) {
      set('sgx-well-tipday', today);
      showTip();
    }
  }
  visibleInterval(checkTip, 30000);
  } /* /SGX_FEAT_GL_WELLBEING */

  /* ---- 设置变更时重应用 ---- */
  on(window, 'sgx-settings-changed', function () {
    if (SGX_FEAT_GL_EDGEGLOW) document.body.classList.toggle('gl-edgeglow', modOn('gl-edgeglow'));
    if (SGX_FEAT_GL_PARALLAX && parallaxOn() && reducedMotion()) {
      const wp2 = document.getElementById('sgx-wallpaper');
      if (wp2) wp2.style.backgroundPosition = '';
    }
  });
}
