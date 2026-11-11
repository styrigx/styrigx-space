/**
 * @fileoverview 「要进站」的唯一出口（v5 S3 整站放开，三处上锁）：AI 窗口的锁、状态页 status 窗的按钮、奇趣音乐的播放，
 * 以及任何接口回 401（没进站）时，都只发这一个事件；shell/topbar-panel.js 接它：打开终端、预填 `su `。
 * topbar-panel.js 不 import 任何东西，抄了一份 SUDO_EVENT；子站的 IIFE 脚本（curio / daymark）直接写同一个字符串。
 */

/** document 上的事件名（detail 不用） */
export const SUDO_EVENT = 'sgx:sudo';

/**
 * 请人进站：打开终端并预填 su （v6 割接）。line 给了（如 /status/ 403 的 'su root'，#404 未决项第 5 项）= 已登录、只是权限不够：
 * 终端预填这一行，页面标记不改成 locked。
 * @param {Document} [doc] @param {string} [line]
 */
export function askSudo(doc, line) {
  const d = doc || document;
  try { d.dispatchEvent(line ? new CustomEvent(SUDO_EVENT, { detail: { line: line } }) : new CustomEvent(SUDO_EVENT)); } catch (e) {}
}
