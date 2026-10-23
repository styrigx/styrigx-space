/**
 * @fileoverview 页面入口：账号 → 服务状态（/account/status/，2026-10-24 PR4 从顶栏「状态」页挪进账号页）
 * = 公共 core + 服务状态模块（取 /api/status，每 60 秒刷新）。
 */
import { initCore } from '../shell/core.js';
import '../apps/account-status.js';
initCore();
