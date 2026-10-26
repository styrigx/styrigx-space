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
import { initGoodLock, wellRetarget } from './goodlock.js';
import { initScrollFx } from './scrollfx.js';
/* 锁屏 / 升级只放守卫进 core；界面在 lock-guard.js 里按需 import()（frontend-js #6） */
import { initLock, initUpgrade } from './lock-guard.js';
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
  /* 主页 / 聊天 / 设置：内容里左右滑切上一栏 / 下一栏（同子站手感；有页内切换时走 shell/inpage-tabs.js） */
  initTabSwipe();

  /* 5.2：写共享 UI cookie sgx-ui（老用户补写；设置变更时再写一次） */
  syncUiCookie();
  window.addEventListener('sgx-settings-changed', syncUiCookie);
  /* 账号云同步：登录了账号的管理员，设置项跨设备同步（lib/cloud-sync.js；访客 / 没登录账号不请求；
     普通拉取最多 5 分钟一次，回到前台也按这个节流，账号页 / 云同步页 / 登录 / 打开开关时强制） */
  initCloudSync().catch(function () {});

  /* B2-7：网站数字健康——本页计时上报；页面上有数字健康卡片就拉今天的数据。
     2026-10-24：区域键每次现取（顶栏三栏页内切换后地址变了，区域跟着变）；切栏前先把这一段记到旧区域（shell/inpage-tabs.js 发 sgx-tab-leave / sgx-tab-enter） */
  const wbArea0 = wbAreaOf(location.pathname);
  const wbt = !SGX_TEST_NO_WB && wbArea0 ? initWbTrack({ key: function () { return wbAreaOf(location.pathname); } }) : null;
  if (!SGX_TEST_NO_WB) loadWb();
  window.addEventListener('sgx-tab-leave', function () {
    if (wbt) wbt.tick();
  });
  window.addEventListener('sgx-tab-enter', function () {
    wellRetarget();
  });

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

  /* 入口脚本这次加载成功：清掉「同一地址只自动重试一次」的标记（baseof 内联脚本 / shell/inpage-tabs.js 写的 sgx-js-retry） */
  try {
    if (sessionStorage.getItem('sgx-js-retry') === location.pathname) sessionStorage.removeItem('sgx-js-retry');
  } catch (e) {}
}
