/**
 * @fileoverview 全站公共 core：所有页面入口先初始化它。
 * 包含：搜索快捷键/返回历史、子页面标题联动、主题、Dock/顶栏/抽屉、
 * 滚动边缘效果、布局钩子（本机到访计时与数字健康 v6 P4 删除，定稿 v5.5 §四）。
 * 必须跨脚本共享的最小 API 挂到 window.SGX（见 sgx.js）。
 */
import { SGX } from '../core/sgx.js';
import { getScheduler, visibleInterval } from '../ui/scheduler.js';
import { initNavHistory } from '../nav/navhistory.js';
import { initHeadButtons } from '../topbar/head-buttons.js';
import { initNav } from '../nav/nav.js';
import { initScrollFx } from '../ui/scrollfx.js';
/* 锁屏 / 升级只放守卫进 core；界面在 space/guard.js 里按需 import()（frontend-js #6） */
import { initLock } from '../auth/guard.js';
import { on as featOn } from '../features/features.js';
import { normPalette } from '../prefs/prefs.js';
import { paintPalette } from '../prefs/prefs-write.js';
import { toast } from '../ui/toast.js';
import { syncUiCookie } from '../prefs/ui-cookie.js';
import { initCloudSync, bindSessionSync } from '../prefs/cloud-sync.js';
import { openSheet, closeSheet } from '../ui/sheet.js';
import { initFavicon } from '../ui/favicon.js';
import { initProfile } from '../prefs/profile.js';

let inited = false;

/**
 * 跨标签页外观同步：别的标签页改了外观开关，本页即时重应用（不刷新）。
 * 2.4.0-G。
 */
function initFeatSync() {
  /* 调色板 v4（2026-11-12）：深浅只由调色板决定，换调色板 = 换深浅（SgxUI.paint） */
  featOn('palette', function (v) {
    paintPalette(normPalette(v));
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
  initNav(S);
  initScrollFx(S);
  initFeatSync();
  /* Hark：CI 测试构建禁用锁屏（构建期摇掉，线上无残留） */
  if (!SGX_TEST_NO_LOCK) initLock();
  /* 标签页图标跟调色板（换调色板时换 SVG 图标的底色） */
  initFavicon();
  /* 2026-11-07 个人资料：页面上有 [data-sgx-profile]（首页名片、账号卡、关于页页脚）才动：先画本机缓存，已进门再问 /api/profile（lib/profile.js） */
  initProfile();

  /* 5.2：写共享 UI cookie sgx-ui（老用户补写；设置变更时再写一次） */
  syncUiCookie();
  window.addEventListener('sgx-settings-changed', syncUiCookie);
  /* 账号云同步：登录了账号，设置项跨设备同步（lib/cloud-sync.js；锁屏没解锁不请求，没登录账号 401 account 后不再请求；
     普通拉取最多 5 分钟一次，回到前台也按这个节流，账号页 / 云同步页 / 登录 / 打开开关时强制） */
  initCloudSync().catch(function () {});
  /* 2c：v6 su 之后页面标记就地切成 valid → 立即强制拉一次；exit / lock 回访客 → 丢掉没推的改动 */
  bindSessionSync();

  /* 跨脚本/模板桥接的最小公共 API */
  Object.assign(SGX, {
    toast,
    openSheet,
    closeSheet,
    scheduler: S,
    visibleInterval,
  });

  /* 入口脚本这次加载成功：清掉「同一地址只自动重试一次」的标记（baseof 内联脚本写的 sgx-js-retry） */
  try {
    if (sessionStorage.getItem('sgx-js-retry') === location.pathname) sessionStorage.removeItem('sgx-js-retry');
  } catch (e) {}
}
