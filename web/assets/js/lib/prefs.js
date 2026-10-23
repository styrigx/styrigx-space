/**
 * @fileoverview 外观 / 语言偏好的统一读写（设置页和顶栏快捷面板共用同一套 setter，两边永远同步）。
 * - 存储一律经 features.js（key 不变：sgx-theme-mode / sgx-palette / sgx-layout / sgx-lang），
 *   features.set 内派发 sgx-settings-changed + 订阅回调，
 *   别的页面部件（设置页的开关、快捷面板的磁贴）各自订阅 features.on 重绘。
 * - 能即时生效的（主题、调色板、布局）这里直接改 <html>，不刷新；
 *   （2026-10-23 PR-E：字体大小、减弱动效两个设置删除；减弱动效只跟系统 prefers-reduced-motion，见 baseof）
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

/** 默认调色板（2026-10-23 PR-G 七色调色板：雾霾蓝；= features.yaml palette.default = palettes.json default） */
export const DEFAULT_PALETTE = 'dustyblue';

/** 存的调色板值 → 合法 id：旧撞色 x<id> 迁到 <id>（PR-G 合并单色 / 撞色），空值 → 默认。
 *  不认识的 id 原样返回（CSS 里没有对应规则，页面本来就渲染成默认；baseof 内联脚本按色板清单清掉）。 @param {any} v @returns {string} */
export function normPalette(v) {
  if (typeof v !== 'string' || !v) return DEFAULT_PALETTE;
  return /^x[a-z]+$/.test(v) ? v.slice(1) : v;
}

/** @returns {string} 调色板 id（默认 dustyblue） */
export function palette() {
  return normPalette(featGet('palette'));
}

/** 设置调色板并立即生效（自定义主题色 sgx-accent 优先于预设，所以选预设时先清掉它）。 @param {string} p */
export function setPalette(p) {
  const v = normPalette(p);
  clearAccent();
  featSet('palette', v);
  const d = document.documentElement;
  if (v === DEFAULT_PALETTE) d.removeAttribute('data-palette');
  else d.setAttribute('data-palette', v);
}

/** 存的布局值 → 合法偏好（旧值 pc 迁到 dex，其他未知值 → auto）。 @param {any} v @returns {'auto'|'mobile'|'dex'} */
export function normLayout(v) {
  if (v === 'pc') return 'dex';
  return v === 'mobile' || v === 'dex' ? v : 'auto';
}

/** @returns {'auto'|'mobile'|'dex'} 布局偏好 */
export function layoutPref() {
  return normLayout(featGet('layout'));
}

/**
 * DeX 需要的「大屏」：可用视口 w ≥ 840 且 h ≥ 500（与 baseof.html __layoutMode 一致）。
 * 手机横屏视口高 ≤ ~450（最大手机短边 448 CSS px，再减浏览器栏），折叠屏内屏 / 平板 / 笔记本 / 显示器 ≥ ~600 高，
 * 500 落在中间；840 让 Z Fold 内屏横屏（841×673）仍是 DeX。
 * @param {number} w @param {number} h @returns {boolean}
 */
export function layoutBig(w, h) {
  return w >= 840 && h >= 500;
}

/**
 * 偏好 + 视口 → 实际布局。自动：横屏（w > h）且大屏 → dex，否则 mobile；手动 DeX 不是大屏时按 mobile。
 * @param {any} pref @param {number} w @param {number} h @returns {'mobile'|'dex'}
 */
export function resolveLayout(pref, w, h) {
  const p = normLayout(pref);
  if (p === 'mobile') return 'mobile';
  if (p === 'dex') return layoutBig(w, h) ? 'dex' : 'mobile';
  return layoutBig(w, h) && w > h ? 'dex' : 'mobile';
}

/** 当前视口不够 DeX（w < 840 或 h < 500）：DeX 偏好不生效。 @returns {boolean} */
export function layoutNarrow() {
  return !layoutBig(window.innerWidth || 1280, window.innerHeight || 800);
}

/** 设置布局偏好并立即重算布局。 @param {string} v */
export function setLayout(v) {
  featSet('layout', normLayout(v));
  const w = /** @type {any} */ (window);
  if (typeof w.__applyLayout === 'function') w.__applyLayout();
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
