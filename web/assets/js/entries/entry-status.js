/**
 * @fileoverview 页面入口：状态页（/status/）= 公共 core + 状态页模块（取 /api/status，每 60 秒刷新）。
 */
import { initCore } from '../shell/core.js';
import '../apps/status.js';
initCore();
