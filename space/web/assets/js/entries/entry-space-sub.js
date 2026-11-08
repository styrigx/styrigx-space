/**
 * @fileoverview 页面入口：风格子页（/theme/，中文 /zh/theme/）= 公共 core + 旷野页模块（调色板）。
 * 2026-11 对齐 PR-B：/wellbeing/、/about/ 并进旷野页 /wild/（entry-space-wild.js），这里只剩风格页。
 */
import { initCore } from '../shell/core.js';
import { mountSpace } from '../apps/space.js';
mountSpace();
initCore();
