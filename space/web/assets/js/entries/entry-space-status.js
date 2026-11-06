/**
 * @fileoverview 页面入口：旷野 → 服务状态（/status/；2026-10-24 PR4 从顶栏「状态」页挪进账号页，之后搬到设置，P4-3 PR-4b 去掉 settings 一层）
 * = 公共 core + 服务状态模块（取 /api/status，每 60 秒刷新）。
 */
import { initCore } from '../shell/core.js';
import '../apps/space-status.js';
initCore();
