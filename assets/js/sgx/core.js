/**
 * @fileoverview 全站公共 core：所有页面入口先初始化它。
 * 包含：搜索快捷键/返回历史、子页面标题联动、主题、Dock/顶栏/抽屉、
 * Good Lock 全站模块、应用可见性、滚动边缘效果、布局钩子。
 * 必须跨脚本共享的最小 API 挂到 window.SGX（见 sgx.js）。
 */
import { SGX } from './sgx.js';
import { getScheduler, visibleInterval } from './scheduler.js';
import { initNavHistory } from './navhistory.js';
import { initSubHead } from './subhead.js';
import { initThemeListener } from './theme.js';
import { applyTheme, setThemeMode } from './theme.js';
import { initNav } from './nav.js';
import { initGoodLock } from './goodlock.js';
import { initAppVisibility } from './appvis.js';
import { initScrollFx } from './scrollfx.js';
import { initDexBridge } from './layout.js';
import { toast } from './toast.js';
import { openSheet, closeSheet } from './sheet.js';
import { voiceInput } from './voice.js';
import { voiceSheet } from './voice-sheet.js';
import { engines } from './engines.js';

let inited = false;

/**
 * 初始化全站公共行为（幂等）。
 */
export function initCore() {
  if (inited) return;
  inited = true;
  const S = getScheduler();
  initDexBridge();
  initNavHistory();
  initSubHead(S);
  initThemeListener();
  initNav(S);
  initGoodLock();
  initAppVisibility();
  initScrollFx(S);
  engines.init();

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
