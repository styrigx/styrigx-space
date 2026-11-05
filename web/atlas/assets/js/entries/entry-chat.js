/**
 * @fileoverview 页面入口：聊天（/chat/） = 公共 core + 聊天模块。
 * 2026-11-04 P5-1：顶栏去掉「聊天」标签（主站标签只剩 主页 / 设置），/chat/ 变成普通页（长条显示页名，不再参与页内切换）；
 * 新的聊天入口是顶栏的 AI 窗口（共享外壳 ai.js）。/chat/ 页、本入口和后端 styrigx-chat 在 P4-2 一起退役。
 */
import { initCore } from '../shell/core.js';
import { mountChat } from '../apps/chat.js';

mountChat();
initCore();
