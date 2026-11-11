/**
 * @fileoverview 页面入口：旷野（/wild/，中文 /zh/wild/；2026-11 对齐 PR-B）= 公共 core + 旷野页模块（apps/space.js）
 * + 服务状态模块（apps/space-status.js：systemctl 窗取 /api/status，每 60 秒刷新）。原 entry-space-status.js（/status/ 页）并进来。
 */
import { initCore } from '../shell/core.js';
import { mountSpace } from '../apps/space.js';
import '../apps/space-status.js';
mountSpace();
initCore();
