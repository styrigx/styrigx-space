/**
 * @fileoverview 「要进站」的唯一出口（v5 S3 整站放开，三处上锁）：AI 窗口的锁、旷野 status 卡的按钮、奇趣音乐的播放，
 * 以及任何接口回 401（没进站）时，都只发这一个事件；shell/topbar-panel.js 接它：打开终端、预填 `sudo styrigx`。
 * topbar-panel.js 不 import 任何东西，抄了一份 SUDO_EVENT；子站的 IIFE 脚本（curio / daymark）直接写同一个字符串。
 */

/** document 上的事件名（detail 不用） */
export const SUDO_EVENT = 'sgx:sudo';

/** 请人进站：打开终端并预填 sudo styrigx @param {Document} [doc] */
export function askSudo(doc) {
  const d = doc || document;
  try { d.dispatchEvent(new CustomEvent(SUDO_EVENT)); } catch (e) {}
}
