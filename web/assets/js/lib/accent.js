/**
 * @fileoverview 自定义主题色（轻量部分：读 / 清除 / 插缓存，不含色板引擎；算角色在 lib/accent-roles.js）。
 * 自定义主题色（localStorage sgx-accent = #rrggbb）→ 整套色彩角色（PR3 色彩角色 token）。
 * - 角色由 lib/palette-scheme.js 算（与 13 套预设同一条管线：最近的手调预设 → 转到种子色相 → 亮度阶梯 → 对比度审计 + 修正），
 *   变量名与 input.css 里 @gen-palettes 生成的预设完全一致（--sgx-primary、--sgx-text-primary …，亮 / 暗两段）。
 * - 写成 <style id="sgx-accent-roles">（不进 @layer，所以盖过 tokens 层里的预设），并把 CSS 文本缓存到 sgx-accent-css，
 *   baseof 内联脚本首屏直接插缓存，不用等这个模块。
 * - 没有 JS / 缓存对不上时：页面用当前预设（data-palette）的角色，<html> 上的 --sgx-seed 仍是自定义色（ui-cookie 同步给子站）。
 */
import { get as sget, set as sset, remove as sremove } from './storage.js';

export const ACCENT_KEY = 'sgx-accent';
export const ACCENT_CSS_KEY = 'sgx-accent-css';
export const ACCENT_STYLE_ID = 'sgx-accent-roles';
/** 缓存格式版本：色板引擎 / 角色名变了就加一，旧缓存自动作废（baseof 内联脚本认同一个前缀） */
export const ACCENT_CACHE_VER = 'v3';
const HEX = /^#[0-9a-fA-F]{6}$/;

/** @returns {string} 当前自定义主题色（小写 #rrggbb），没有返回 '' */
export function accent() {
  const v = sget(ACCENT_KEY) || '';
  return HEX.test(v) ? v.toLowerCase() : '';
}

/** 缓存首行：版本|种子 @param {string} seed */
export function cacheHead(seed) {
  return ACCENT_CACHE_VER + '|' + seed.toLowerCase() + '\n';
}

/** 写 / 更新 <style id="sgx-accent-roles"> @param {string} css */
export function injectAccentCss(css) {
  let el = document.getElementById(ACCENT_STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = ACCENT_STYLE_ID;
    document.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

/** 清除自定义主题色，回到预设色板（快捷面板 / 设置页点预设时用）。 */
export function clearAccent() {
  if (!sget(ACCENT_KEY) && !document.getElementById(ACCENT_STYLE_ID)) return;
  sremove(ACCENT_KEY);
  sremove(ACCENT_CSS_KEY);
  const el = document.getElementById(ACCENT_STYLE_ID);
  if (el) el.remove();
  document.documentElement.style.removeProperty('--sgx-seed');
}
