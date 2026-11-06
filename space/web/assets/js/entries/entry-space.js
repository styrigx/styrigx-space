/**
 * @fileoverview 页面入口：旷野页（/，中文 /zh/） = 公共 core + 首页小组件（apps/index.js：日刻今日一句）+ 旷野页模块（apps/space.js）。
 * P4-3 PR-4b（2026-11-07）：主页和设置合成一页，顶栏只剩「旷野 / Space」一个标签；原 entry-tab-home / entry-tab-settings / lazy-* 和页内切换删除。
 * 旷野子页（/theme/ 等）走 entry-space-sub.js。
 */
import { initCore } from '../shell/core.js';
import { mountHome } from '../apps/index.js';
import { mountSpace } from '../apps/space.js';

/* 页面模块先跑，core 后初始化（同以前） */
mountHome({ direct: true });
mountSpace();
initCore();
