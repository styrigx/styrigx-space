/**
 * @fileoverview 外观 / 语言偏好的统一读写（设置页和顶栏快捷面板共用同一套 setter，两边永远同步）。
 * 2026-11-04 P5-1：cookie 写法、默认色板和存值归一搬进共享外壳的外观写端 lib/prefs-write.js（子站快捷设置也用它）；这里的 setter 仍经 features.js（订阅 / 云同步要用），写的 key 和写端一样。
 * - 存储一律经 features.js（key 不变：sgx-palette / sgx-layout / sgx-lang；2026-11-12 调色板 v4 删除 sgx-theme-mode 和自定义主题色），
 *   features.set 内派发 sgx-settings-changed + 订阅回调，
 *   别的页面部件（设置页的开关、快捷面板的磁贴）各自订阅 features.on 重绘。
 * - 能即时生效的（调色板 = 深浅、布局）这里直接改 <html>，不刷新；
 *   （2026-10-23 PR-E：字体大小、减弱动效两个设置删除；减弱动效只跟系统 prefers-reduced-motion，见 baseof）
 *   语言需要换到另一种语言的页面，setLang 只写偏好并返回要去的地址，由调用方决定怎么跳。
 */
import { get as featGet, set as featSet } from '../features/features.js';
import { set as sset } from './storage.js';
import { DEFAULT_PALETTE, normPalette, paintPalette } from './prefs-write.js';
import { langPath, systemLang, isLang } from '../i18n/lang-path.js';

export { DEFAULT_PALETTE, normPalette };

/** @returns {boolean} 当前是不是深套（深浅只由调色板决定） */
export function isDark() {
  return document.documentElement.classList.contains('dark');
}

/* 默认调色板 DEFAULT_PALETTE、存值归一 normPalette：2026-11-04 P5-1 起定义在外观写端 lib/prefs-write.js（四站共用，见上面的 import / export） */

/** @returns {string} 调色板 id（默认 terra） */
export function palette() {
  return normPalette(featGet('palette'));
}

/** 设置调色板并立即生效（深浅、浏览器底色跟着本套走）。 @param {string} p */
export function setPalette(p) {
  const v = normPalette(p);
  featSet('palette', v);
  paintPalette(v);
}

/**
 * 存的布局值 → 合法偏好（P4-3 PR-4b：只有手机 / 自动 / 桌面）。旧值兼容：mobile → phone，dex / pc → desktop；其他未知值 → auto。
 * @param {any} v @returns {'auto'|'phone'|'desktop'}
 */
export function normLayout(v) {
  if (v === 'phone' || v === 'mobile') return 'phone';
  if (v === 'desktop' || v === 'dex' || v === 'pc') return 'desktop';
  return 'auto';
}

/** @returns {'auto'|'phone'|'desktop'} 布局偏好 */
export function layoutPref() {
  return normLayout(featGet('layout'));
}

/**
 * 浏览器是不是「手机版网站」模式（同共享外壳 layout-mode.js __sgxUaMobile）：有 userAgentData 就看 .mobile，
 * 没有就看 UA 里的 Mobi / Android…Mobile / iPhone。不看视口像素。
 * @param {{ userAgentData?: { mobile?: boolean }, userAgent?: string }} [nav] @returns {boolean}
 */
export function uaMobile(nav) {
  const n = nav || /** @type {any} */ (typeof navigator !== 'undefined' ? navigator : {});
  const u = n.userAgentData;
  if (u && typeof u.mobile === 'boolean') return u.mobile;
  return /Mobi|Android.*Mobile|iPhone/.test(n.userAgent || '');
}

/**
 * 偏好 + 浏览器 + 视口宽 → 实际布局（同 baseof.html / 共享外壳 layout-mode.js __sgxLayout）：
 * 手动手机 / 桌面照办；自动 = 视口宽 < 720 → phone（窄窗口 / 分屏 / 手机竖屏）；否则不是手机版网站模式 → desktop；
 * UA 报手机但浏览器在用「桌面版网站」的虚拟视口（desktopSite，同 __sgxDesktopSite）→ desktop；其余 phone。
 * @param {any} pref @param {boolean} mobile uaMobile() 的结果 @param {number} [w] 视口宽（innerWidth）
 * @param {boolean} [desktopSite] 布局视口比屏幕宽 1.25 倍以上（浏览器不理 viewport meta） @returns {'phone'|'desktop'}
 */
export function resolveLayout(pref, mobile, w, desktopSite) {
  const p = normLayout(pref);
  if (p !== 'auto') return p;
  if (typeof w === 'number' && w > 0 && w < 720) return 'phone';
  return !mobile || desktopSite ? 'desktop' : 'phone';
}

/**
 * 设备档（同共享外壳 layout-mode.js __sgxDevice）：UA 报手机，或粗指针 + 屏幕短边 < 600 → phone；其余 desktop。
 * 只给桌面布局的顶栏宽分档（手机开桌面版网站 = 窄档），和布局模式无关。
 * @param {boolean} mobile uaMobile() 的结果 @param {boolean} coarse (pointer: coarse) @param {number} [screenShort] 屏幕短边 CSS px
 * @returns {'phone'|'desktop'}
 */
export function resolveDevice(mobile, coarse, screenShort) {
  if (mobile) return 'phone';
  return coarse && typeof screenShort === 'number' && screenShort > 0 && screenShort < 600 ? 'phone' : 'desktop';
}

/** 旧接口（P4-3 PR-4b 前「不够 DeX 时 DeX 置灰」）：模式不再按视口定，桌面任何时候都能选。 @returns {boolean} */
export function layoutNarrow() {
  return false;
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
  const pick = isLang(v) ? v : 'system';
  featSet('lang', pick);
  /* 语言清理（2026-11-07）：偏好明确存 'system'（features.set 遇到默认值会删 key，这里再写一次）；旧版存的空 / 没有也按跟随系统读 */
  sset('sgx-lang', pick);
  const want = pick === 'system' ? systemLang() : pick;
  /* P4-3 PR-4c：英文无前缀、中文 /zh/，地址统一由 lib/lang-path.js 拼 */
  return langPath(location.pathname, want) + location.search + location.hash;
}
