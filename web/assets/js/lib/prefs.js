/**
 * @fileoverview 外观 / 语言偏好的统一读写（设置页和顶栏快捷面板共用同一套 setter，两边永远同步）。
 * - 存储一律经 features.js（key 不变：sgx-theme-mode / sgx-palette / sgx-font-size / sgx-layout /
 *   sgx-reduced-motion / sgx-lang），features.set 内派发 sgx-settings-changed + 订阅回调，
 *   别的页面部件（设置页的开关、快捷面板的磁贴）各自订阅 features.on 重绘。
 * - 能即时生效的（主题、调色板、字体、布局、减弱动效）这里直接改 <html>，不刷新；
 *   语言需要换到另一种语言的页面，setLang 只写偏好并返回要去的地址，由调用方决定怎么跳。
 */
import { get as featGet, set as featSet } from './features.js';
import { set as sset, remove as sremove } from './storage.js';
import { setThemeMode } from './theme.js';
import { clearAccent } from './accent.js';

/** @returns {'light'|'dark'|'system'} 主题模式偏好 */
export function themeMode() {
  const m = featGet('theme-mode');
  return m === 'light' || m === 'dark' ? m : 'system';
}

/** @returns {boolean} 当前实际是否深色（含跟随系统算出来的） */
export function isDark() {
  return document.documentElement.classList.contains('dark');
}

/** 设置主题模式（浅色 / 深色 / 跟随系统）。 @param {'light'|'dark'|'system'} mode */
export function setTheme(mode) {
  setThemeMode(mode);
}

/**
 * 切换「跟随系统」（设置页 显示 › 跟随系统 开关的语义）：
 * 开着 → 关掉并固定为当前看到的深 / 浅色；关着 → 改回跟随系统。
 */
export function toggleFollowSystem() {
  if (themeMode() === 'system') setThemeMode(isDark() ? 'dark' : 'light');
  else setThemeMode('system');
}

/** @returns {string} 调色板 id（默认 lake） */
export function palette() {
  return featGet('palette') || 'lake';
}

/** 设置调色板并立即生效（自定义主题色 sgx-accent 优先于预设，所以选预设时先清掉它）。 @param {string} p */
export function setPalette(p) {
  const v = p || 'lake';
  clearAccent();
  featSet('palette', v);
  const d = document.documentElement;
  if (v === 'lake') d.removeAttribute('data-palette');
  else d.setAttribute('data-palette', v);
}

/** @returns {'small'|'standard'|'large'} 字体大小 */
export function fontSize() {
  const v = featGet('font-size');
  return v === 'small' || v === 'large' ? v : 'standard';
}

/** 设置字体大小并立即生效。 @param {string} v */
export function setFontSize(v) {
  const s = v === 'small' || v === 'large' ? v : 'standard';
  featSet('font-size', s);
  const d = document.documentElement;
  d.style.fontSize = s === 'large' ? '112.5%' : s === 'small' ? '87.5%' : '';
  try {
    d.setAttribute('data-font-size', s);
  } catch (e) {}
}

/** @returns {'auto'|'mobile'|'dex'|'pc'} 布局偏好 */
export function layoutPref() {
  const v = featGet('layout');
  return v === 'mobile' || v === 'dex' || v === 'pc' ? v : 'auto';
}

/** 窄屏（< 840px）时 DeX / PC 偏好不生效（与 baseof.html __layoutMode 一致）。 @returns {boolean} */
export function layoutNarrow() {
  return (window.innerWidth || 1280) < 840;
}

/** 设置布局偏好并立即重算布局。 @param {string} v */
export function setLayout(v) {
  featSet('layout', v === 'mobile' || v === 'dex' || v === 'pc' ? v : 'auto');
  const w = /** @type {any} */ (window);
  if (typeof w.__applyLayout === 'function') w.__applyLayout();
}

/** @returns {boolean} 减弱动效是否开启 */
export function reducedMotionPref() {
  return !!featGet('reduced-motion');
}

/** 设置减弱动效并立即生效。 @param {boolean} on */
export function setReducedMotion(on) {
  featSet('reduced-motion', !!on);
  const d = document.documentElement;
  d.classList.toggle('reduced-motion', !!on);
  try {
    d.setAttribute('data-reduced-motion', on ? '1' : '0');
  } catch (e) {}
}

/** @returns {'system'|'zh'|'en'} 语言偏好（sgx-lang） */
export function langPref() {
  const v = featGet('lang');
  return v === 'zh' || v === 'en' ? v : 'system';
}

/**
 * 写语言偏好，返回当前页在目标语言下的地址（保留查询参数与 hash）。
 * 调用方用 location.replace 跳过去（不产生历史，与设置页一致）。
 * @param {'system'|'zh'|'en'} v
 * @returns {string}
 */
export function setLang(v) {
  if (v === 'system') sremove('sgx-lang');
  else sset('sgx-lang', v);
  featSet('lang', v === 'system' ? 'system' : v);
  const p = location.pathname,
    q = location.search,
    h = location.hash;
  let want = v;
  if (v === 'system') {
    try {
      const nav = /** @type {any} */ (navigator);
      const bl = (nav.language || nav.userLanguage || 'zh').toLowerCase();
      want = bl.indexOf('zh') === 0 ? 'zh' : 'en';
    } catch (e) {
      want = 'zh';
    }
  }
  let np;
  if (want === 'en') {
    np = p === '/' ? '/en/' : p === '/en' || p.indexOf('/en/') === 0 ? p : '/en' + p;
  } else {
    np = p.replace(/^\/en(\/|$)/, '/');
    if (np === '' || np.charAt(0) !== '/') np = '/';
  }
  return np + q + h;
}
