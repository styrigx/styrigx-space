/**
 * @fileoverview 页面入口：状态页（/status/，中文 /zh/status/；2026-11-12 旷野删除，状态单独成页）= 公共 core + 页面模块（apps/space.js）
 * + 服务状态模块（apps/space-status.js：systemctl 窗取 /api/status，每 60 秒刷新）。
 */
import { initCore } from '../shell/core.js';
import { mountSpace } from '../apps/space.js';
import '../apps/space-status.js';
mountSpace();
initCore();
