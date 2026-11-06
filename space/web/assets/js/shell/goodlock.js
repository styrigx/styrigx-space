/**
 * @fileoverview 全站生效的小模块（文件名沿用旧的 goodlock.js）：本机到访计时 + 15 分钟提醒（设置 › 数字健康，只存本地）。
 * P4-2c（2026-11-05）：快捷键随高级功能分类删除。
 * 2026-10-23 PR-E：视差壁纸、点击音效、边缘光效删除；数字健康不再有总开关（计时一直开，提醒只看 well-tip）。
 * 开关经 features.js 统一读写。
 */
import { on } from '../lib/events.js';
import { get, set } from '../lib/storage.js';
import { get as featGet } from '../lib/features.js';
import { loadI18n } from '../lib/i18n.js';
import { visibleInterval } from '../lib/scheduler.js';

/** @returns {string} YYYY-M-D */
function dayStr(d) {
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

/**
 * 读今日访问数据。
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
  /* 区域键沿用 'browser'（历史数据不丢）：2026-10-21 主站书签下线后只剩 /search/ */
  if (p === '/search/' || p === '/en/search/') return 'browser';
  /* P4-3 PR-4b：旷野页和旷野子页（lib/wb-area.js SPACE_SUB_RE）都记 'space'（只写新键）。
     今天的本机记录里旧键 'home' / 'settings'（更早的 'goodlock'）照旧留着，数字健康卡读的时候并进旷野（apps/space.js） */
  return 'space';
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
 * 初始化全站模块（本机到访计时 / 15 分钟提醒）。
 */
export function initGoodLock() {
  const T = loadI18n('sgx-i18n-core');
  sessArea = areaOf();

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
