/**
 * @fileoverview 页面入口：旷野子页（/display/、/theme/、/wellbeing/、/about/，英文加 /en/）= 公共 core + 旷野页模块。
 * P4-3 PR-4b：原 entry-settings.js（设置子页）改名，地址去掉 settings 一层。旷野页本身走 entry-space.js。
 */
import { initCore } from '../shell/core.js';
import { mountSpace } from '../apps/space.js';
mountSpace();
initCore();
