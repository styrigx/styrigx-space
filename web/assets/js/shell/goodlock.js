/**
 * @fileoverview 全站生效的小模块（文件名沿用旧的 goodlock.js；设置里叫「高级功能」）：
 * 快捷键（设置 › 高级功能）、本机到访计时 + 15 分钟提醒（设置 › 数字健康，只存本地）。
 * 2026-10-23 PR-E：视差壁纸、点击音效、边缘光效删除；数字健康不再有总开关（计时一直开，提醒只看 well-tip）。
 * 开关经 features.js 统一读写；各模块另有 SGX_FEAT_* 编译期开关。
 */
import { on } from '../lib/events.js';
import { get, set } from '../lib/storage.js';
import { get as featGet } from '../lib/features.js';
import { loadI18n } from '../lib/i18n.js';
import { openSheet } from './sheet.js';
import { visibleInterval } from '../lib/scheduler.js';
import { sgxNavigate } from '../lib/diag-jumptrace.js';

/**
 * 读模块开关（经 features.js，带编译期 build 默认）。
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
  /* 设置首页和各设置子页都算「设置」（旧数据里的 'goodlock' 区域在数字健康卡里并进设置） */
  if (/^(\/en)?\/settings\//.test(p)) return 'settings';
  /* 区域键沿用 'browser'（历史数据不丢）：2026-10-21 主站书签下线后只剩 /search/ */
  if (p === '/search/' || p === '/en/search/') return 'browser';
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
 * 页内切换顶栏三栏后（地址已经换了）：把上一段时长结算到旧区域，之后算到新区域。
 */
export function wellRetarget() {
  try {
    wellFlush();
  } catch (e) {}
  sessArea = areaOf();
}

/**
 * 初始化全站模块（快捷键、本机到访计时 / 15 分钟提醒）。
 */
export function initGoodLock() {
  const T = loadI18n('sgx-i18n-core');
  const en = document.documentElement.lang === 'en';
  sessArea = areaOf();

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
        links = en ? 'https://curio.styrigx.com/en/' : 'https://curio.styrigx.com/', /* g l：奇趣 Curio（主站书签已迁走） */
        setUrl = en ? '/en/settings/' : '/settings/';
      if (pending) {
        pending = false;
        if (timer) clearTimeout(timer);
        const map = { h: home, l: links, b: 'https://blog.styrigx.com', s: setUrl };
        const u = map[e.key];
        if (u) {
          e.preventDefault();
          if (u.indexOf('http') === 0) window.open(u, '_blank');
          else sgxNavigate(u);
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

  /* ---- 本机到访计时（只存本地；设置 › 数字健康 没登录时显示它） ---- */
  {
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
  } /* /本机到访计时 */
}
