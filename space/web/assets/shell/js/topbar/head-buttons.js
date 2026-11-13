/**
 * @fileoverview 顶栏（2026-11-04 P5-1 全大椭圆，四个站同一个）：[logo] [中间：现有导航内容] [快捷面板 · AI · 头像]。
 * - 标记在 partials/shell-topbar.html（共享外壳单一来源）；logo、头像都是普通链接（回本站首页 / 进账号页）。
 * - 九宫格按钮和导航抽屉已删除：站点切换在快捷面板第 1 页「导航」（不放搜索框，定案第 2 条）；
 *   原地搜索层（Ctrl+K、首页 ?q=）已在 P4-2 删除。
 * - 快捷面板和 AI 窗口：topbar/quick-panel.js → 共享外壳 topbar/topbar-panel.js。
 */
import { initQuickPanel } from './quick-panel.js';

export function initHeadButtons() {
  initQuickPanel();
}
