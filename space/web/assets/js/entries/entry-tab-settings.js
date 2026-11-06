/**
 * @fileoverview 页面入口：设置首页（/settings/） = 公共 core + 这一栏的模块 + 页内切换（shell/inpage-tabs.js）。
 * 设置子页（/settings/<cat>/）走 entry-settings.js。
 * 顶栏两栏（主页 / 设置；2026-11-04 P5-1 去掉聊天）各一个入口（2026-10-24 JS 拆分，以前三栏共用 entry-tabs.js 一份全带）：
 * 当前栏的模块静态 import（随入口一起到，挂载时机同以前）；另一栏用 import() 按需取（lazy-*.js），
 * 页内切换空闲时预取、按下标签时还没取到就当场取，取不到（部署后旧 chunk 404 / 断网）整页导航到目标地址。
 * 两个入口的 registerTab 参数（keep / top）必须一致（tests/space/ui/build/js-split.test.mjs 检查）。
 */
import { initCore } from '../shell/core.js';
import { initInpageTabs, registerTab } from '../shell/inpage-tabs.js';
import { mountSettings } from '../apps/settings.js';

registerTab('home', { keep: true, top: true, load: () => import('./lazy-home.js').then((m) => (o) => m.mountHome(o)) });
registerTab('settings', { keep: false, mount: () => mountSettings() });
/* 先挂当前这一栏（同以前：页面模块先跑，core 后初始化） */
initInpageTabs();
initCore();
