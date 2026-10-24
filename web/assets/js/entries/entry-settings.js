/**
 * @fileoverview 页面入口：设置子页（/settings/<cat>/）= 公共 core + 设置模块。
 * 设置首页（/settings/）是顶栏三栏之一，走 entry-tab-settings.js（页内切换）。
 */
import { initCore } from '../shell/core.js';
import { mountSettings } from '../apps/settings.js';
mountSettings();
initCore();
