/**
 * @fileoverview 自定义主题色 → 角色（带色板引擎 lib/palette-scheme.js，只给设置页打包；轻量部分在 lib/accent.js）。
 */
import { rolesCss } from './palette-scheme.js';
import { set as sset, get as sget } from './storage.js';
import { ACCENT_KEY, ACCENT_CSS_KEY, accent, cacheHead, injectAccentCss, clearAccent } from './accent.js';

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * 按种子算出角色并立即生效（写 <style> + 缓存 + <html> 上的 --sgx-seed）。
 * @param {string} seed #rrggbb
 * @returns {string} 生效的 CSS 文本（种子不合法返回 ''）
 */
export function applyAccent(seed) {
  if (!HEX.test(seed || '')) return '';
  const s = seed.toLowerCase();
  const css = rolesCss(s);
  sset(ACCENT_CSS_KEY, cacheHead(s) + css);
  injectAccentCss(css);
  document.documentElement.style.setProperty('--sgx-seed', s);
  return css;
}

/**
 * 设置 / 清除自定义主题色。传 '' 或 null = 回到预设色板。
 * @param {string|null} seed
 */
export function setAccent(seed) {
  if (seed && HEX.test(seed)) {
    sset(ACCENT_KEY, seed.toLowerCase());
    applyAccent(seed);
  } else {
    clearAccent();
  }
  try {
    window.dispatchEvent(new CustomEvent('sgx-settings-changed', { detail: { id: 'accent' } }));
  } catch (e) {}
}

/** 页面加载后核对：设了自定义色但缓存缺失 / 过期（引擎升级、别的页改过） → 重新算一遍。 */
export function syncAccent() {
  const s = accent();
  if (!s) return;
  const c = sget(ACCENT_CSS_KEY) || '';
  if (c.indexOf(cacheHead(s)) === 0) {
    injectAccentCss(c.slice(cacheHead(s).length));
    return;
  }
  applyAccent(s);
}
