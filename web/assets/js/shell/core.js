/**
 * @fileoverview 全站公共 core：所有页面入口先初始化它。
 * 包含：搜索快捷键/返回历史、子页面标题联动、主题、Dock/顶栏/抽屉、
 * 高级功能全站模块（快捷键）+ 本机到访计时 / 15 分钟提醒、滚动边缘效果、布局钩子。
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
import { initLock } from './lock.js';
import { initUpgrade } from './upgrade.js';
import { on as featOn } from '../lib/features.js';
import { normPalette, DEFAULT_PALETTE } from '../lib/prefs.js';
import { toast } from '../lib/toast.js';
import { syncUiCookie } from '../lib/ui-cookie.js';
import { initCloudSync } from '../lib/cloud-sync.js';
import { initWbTrack } from '../lib/wb-track.js';
import { loadWb } from '../lib/wb-view.js';
import { wbAreaOf } from '../lib/wb-area.js';
import { openSheet, closeSheet } from './sheet.js';
import { engines } from './engines.js';
import { initFavicon } from './favicon.js';
import { initSearchHost } from './search-host.js';
import { initTabSwipe } from './tab-swipe.js';

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
    const p = normPalette(v);
    if (p === DEFAULT_PALETTE) d.removeAttribute('data-palette');
    else d.setAttribute('data-palette', p);
  });
  /* 字体大小、减弱动效两个开关 2026-10-23 删除（减弱动效只跟系统，baseof 内联脚本监听 prefers-reduced-motion） */
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
  /* 标签页图标跟主题色（换色板 / 自定义色 / 深浅色时换 SVG 图标的底色） */
  initFavicon();
  /* 带 ?q= 进来（旧 /search/?q=、opensearch）：打开原地搜索层并预填 */
  initSearchHost();
  /* 主页 / 聊天 / 状态：内容里左右滑切上一栏 / 下一栏（同子站手感） */
  initTabSwipe();

  /* 5.2：写共享 UI cookie sgx-ui（老用户补写；设置变更时再写一次） */
  syncUiCookie();
  window.addEventListener('sgx-settings-changed', syncUiCookie);
  /* 账号云同步：登录了账号的站长，设置项跨设备同步（lib/cloud-sync.js；访客 / 没登录账号不请求） */
  initCloudSync().catch(function () {});

  /* B2-7：网站数字健康——本页计时上报；页面上有数字健康卡片就拉今天的数据 */
  if (!SGX_TEST_NO_WB) initWbTrack({ key: wbAreaOf(location.pathname) });
  if (!SGX_TEST_NO_WB) loadWb();

  /* 跨脚本/模板桥接的最小公共 API */
  Object.assign(SGX, {
    toast,
    openSheet,
    closeSheet,
    engines,
    applyTheme,
    setThemeMode,
    scheduler: S,
    visibleInterval,
  });
}
