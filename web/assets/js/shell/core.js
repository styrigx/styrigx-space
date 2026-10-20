/**
 * @fileoverview 全站公共 core：所有页面入口先初始化它。
 * 包含：搜索快捷键/返回历史、子页面标题联动、主题、Dock/顶栏/抽屉、
 * Good Lock 全站模块、滚动边缘效果、布局钩子。
 * 必须跨脚本共享的最小 API 挂到 window.SGX（见 sgx.js）。
 */
import { SGX } from '../lib/sgx.js';
import { getScheduler, visibleInterval } from '../lib/scheduler.js';
import { initNavHistory } from './navhistory.js';
import { initHeadButtons } from './head-buttons.js';
import { initThemeListener } from '../lib/theme.js';
import { applyTheme, setThemeMode } from '../lib/theme.js';
import { initNav } from './nav.js';
import { initGoodLock } from './goodlock.js';
import { initScrollFx } from './scrollfx.js';
import { initDexBridge } from './layout.js';
import { initLock } from './lock.js';
import { initUpgrade } from './upgrade.js';
import { on as featOn } from '../lib/features.js';
import { toast } from '../lib/toast.js';
import { syncUiCookie } from '../lib/ui-cookie.js';
import { initWbTrack } from '../lib/wb-track.js';
import { loadWb } from '../lib/wb-view.js';
import { wbAreaOf } from '../lib/wb-area.js';
import { openSheet, closeSheet } from './sheet.js';
import { voiceInput } from './voice.js';
import { voiceSheet } from './voice-sheet.js';
import { engines } from './engines.js';

let inited = false;

/**
 * 跨标签页外观同步：别的标签页改了外观开关，本页即时重应用（不刷新）。
 * 2.4.0-G。
 */
function initFeatSync() {
  const d = document.documentElement;
  featOn('theme-mode', function () {
    applyTheme();
  });
  featOn('palette', function (v) {
    if (!v || v === 'lake') d.removeAttribute('data-palette');
    else d.setAttribute('data-palette', v);
  });
  featOn('font-size', function (v) {
    d.style.fontSize = v === 'large' ? '112.5%' : v === 'small' ? '87.5%' : '';
    try {
      d.setAttribute('data-font-size', v || 'standard');
    } catch (e) {}
  });
  featOn('reduced-motion', function (v) {
    d.classList.toggle('reduced-motion', !!v);
    try {
      d.setAttribute('data-reduced-motion', v ? '1' : '0');
    } catch (e) {}
  });
  featOn('layout', function () {
    const w = /** @type {any} */ (window);
    if (typeof w.__applyLayout === 'function') w.__applyLayout();
  });
}

/**
 * 初始化全站公共行为（幂等）。
 */
export function initCore() {
  if (inited) return;
  inited = true;
  const S = getScheduler();
  initDexBridge();
  initNavHistory();
  initHeadButtons();
  initThemeListener();
  initNav(S);
  initGoodLock();
  initScrollFx(S);
  initFeatSync();
  /* Hark：CI 测试构建禁用锁屏（构建期摇掉，线上无残留） */
  if (!SGX_TEST_NO_LOCK) initLock();
  initUpgrade();
  engines.init();

  /* 5.2：写共享 UI cookie sgx-ui（老用户补写；设置变更时再写一次） */
  syncUiCookie();
  window.addEventListener('sgx-settings-changed', syncUiCookie);

  /* B2-7：网站数字健康——本页计时上报；页面上有数字健康卡片就拉今天的数据 */
  if (!SGX_TEST_NO_WB) initWbTrack({ key: wbAreaOf(location.pathname) });
  if (!SGX_TEST_NO_WB) loadWb();

  /* 跨脚本/模板桥接的最小公共 API */
  Object.assign(SGX, {
    toast,
    openSheet,
    closeSheet,
    voiceInput,
    voiceSheet,
    engines,
    applyTheme,
    setThemeMode,
    scheduler: S,
    visibleInterval,
  });
}
