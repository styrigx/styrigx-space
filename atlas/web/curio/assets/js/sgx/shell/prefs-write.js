/* @sgx-shell:begin styrigx/styrigx-space@tree:3822028fba77 space/web/shared/shell v805a6b85695e（space/scripts/curio/sync-shell.mjs 写入，勿手改） */
/* ---- prefs-write.js ---- */
/**
 * @fileoverview 外观写端（2026-11-04 P5-1，定案第 5 条：四站共用一个写端）。
 * 源在这里（从 lib/prefs.js / lib/ui-cookie.js 抽出），gen-shell 原样复制成共享外壳 space/web/shared/shell/prefs-write.js，三个子站 sync-shell 同步。
 * 自成一体：不 import 任何东西（子站原样复制）；cookie 的字段表 / 编解码用页面上已有的 window.SgxUI（ui-cookie-read.js：主站 lib/ui-cookie.js 引入，子站 <head> 内联）。
 *
 * 写什么：
 * - localStorage（PR3 起四站同源，同一份）：sgx-theme-mode（跟随系统 = 删 key，同 features.yaml 默认）、sgx-palette（默认 dustyblue = 删 key）、
 *   sgx-lang（'zh' / 'en'；跟随系统 = 删 key）；选预设色板时清掉自定义主题色 sgx-accent / sgx-accent-css。
 * - sgx-ui cookie（syncUiCookie，原 lib/ui-cookie.js 的写法原样搬来）：子站首帧前读它；主站读 localStorage。
 * 主站：lib/prefs.js 的 setter 仍经 features.js 写同一批 key（features 的订阅 / 云同步要用），cookie 由 core.js 在 sgx-settings-changed 时调本文件的 syncUiCookie；
 *   DEFAULT_PALETTE / normPalette 也从这里取。
 * 子站：快捷面板（共享外壳 topbar.js）调本文件的 setThemeMode / toggleFollowSystem / setPalette / setLangPref：写 key → 改 <html>（SgxUI.apply）→ 写 cookie。
 *   子站写入的外观在本设备生效（同源，主站下次打开就是新的）；跨设备以账号云同步为准（主站同步时上传），云同步覆盖这些设置之前不承诺跨设备。
 */

/** 默认调色板（= features.yaml palette.default = palettes.json default） */
export const DEFAULT_PALETTE = 'dustyblue';

var COOKIE_MAX_AGE = 34560000; /* 400 天 */

/**
 * cookie 属性：Domain=styrigx.com 只在 styrigx.com 及其子域上带，Secure 只在 https 上带（localhost / http 上浏览器会拒收，生产不变）。
 * @param {{hostname: string, protocol: string}} loc
 * @returns {string}
 */
export function cookieAttrs(loc) {
  var h = String((loc && loc.hostname) || '');
  var dom = h === 'styrigx.com' || /\.styrigx\.com$/.test(h) ? '; Domain=styrigx.com' : '';
  var sec = loc && loc.protocol === 'https:' ? '; Secure' : '';
  return dom + '; Path=/; Max-Age=' + COOKIE_MAX_AGE + '; SameSite=Lax' + sec;
}

/** @returns {any} */
function U() {
  return /** @type {any} */ (window).SgxUI || null;
}

/** @param {string} k @returns {string|null} */
function ls(k) {
  try {
    var v = window.localStorage.getItem(k);
    return v === null ? null : v;
  } catch (e) {
    return null;
  }
}
/** @param {string} k @param {string|null} v */
function lsSet(k, v) {
  try {
    if (v === null) window.localStorage.removeItem(k);
    else window.localStorage.setItem(k, v);
  } catch (e) {}
}

/** 存的调色板值 → 合法 id：旧撞色 x<id> 迁到 <id>，空值 → 默认；不认识的 id 原样返回。 @param {any} v @returns {string} */
export function normPalette(v) {
  if (typeof v !== 'string' || !v) return DEFAULT_PALETTE;
  return /^x[a-z]+$/.test(v) ? v.slice(1) : v;
}

/* ---------------- sgx-ui cookie（原 lib/ui-cookie.js） ---------------- */

function readCookie() {
  var m = document.cookie.match(/(?:^|;\s*)sgx-ui=([^;]*)/);
  return m ? m[1] : '';
}
/** 当前主题色种子（#rrggbb）：自定义 sgx-accent 优先，否则读 <html> 上计算出的 --sgx-seed；都没有返回 '' */
function currentSeed() {
  var ac = ls('sgx-accent') || '';
  if (/^#[0-9a-fA-F]{6}$/.test(ac)) return ac.toLowerCase();
  try {
    var v = getComputedStyle(document.documentElement).getPropertyValue('--sgx-seed').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  } catch (e) {}
  return '';
}
/** 明确的语言偏好：'zh' / 'en' 原样返回；跟随系统返回 '' */
function langPref() {
  var l = ls('sgx-lang');
  return l === 'zh' || l === 'en' ? l : '';
}

/**
 * 同步 UI 设置到共享 cookie sgx-ui（只含 UI 设置，不含任何凭证或会话信息）。值没变就不重写。
 * P4-2c（2026-11-05）：日期和时间、天气设置删除，tz1 / tz2 / h12 / clock / wx / unit / loc / city / precise 不再写（读端忽略不认识的字段，旧 cookie 里的照样无害）。
 * 字段→key：mode←sgx-theme-mode；pal←sgx-palette；accent：当前主题色种子；fs / rm 固定 'standard' / 0；
 *   mat：mode 最近一次变化的时间戳；lang←sgx-lang（明确选的 zh / en，跟随系统写 ''）。
 * cookie：sgx-ui=<base64url JSON>; Domain=styrigx.com; Path=/; Max-Age=34560000; SameSite=Lax; Secure（Domain / Secure 按主机名和协议，见 cookieAttrs；不加 HttpOnly：子站要用 JS 读）。
 */
export function syncUiCookie() {
  var u = U();
  if (!u) return;
  var payload = {
    v: u.V,
    mode: u.MODES.indexOf(ls('sgx-theme-mode') || '') >= 0 ? ls('sgx-theme-mode') : 'system',
    pal: u.normPal(ls('sgx-palette')),
    accent: currentSeed(),
    fs: 'standard',
    rm: 0,
    lang: langPref(),
  };
  var old = u.decode(readCookie());
  /** @type {any} */ (payload).mat = old && old.mode === payload.mode && typeof old.mat === 'number' ? old.mat : Date.now();
  var b64 = u.encode(payload);
  if (readCookie() === b64) return;
  document.cookie = u.NAME + '=' + b64 + cookieAttrs(typeof location === 'undefined' ? null : location);
}

/* ---------------- 子站快捷设置用的 setter ---------------- */

/** <html> 按刚写的值重落一遍（子站：读端 SgxUI.apply 读 cookie；没有读端时只管 dark） */
function reapply() {
  var u = U();
  if (u && typeof u.apply === 'function') {
    try {
      u.apply(document.documentElement, { watch: true });
    } catch (e) {}
  }
  try {
    window.dispatchEvent(new Event('sgx-theme-changed'));
  } catch (e) {}
}

/** @returns {'light'|'dark'|'system'} */
export function themeMode() {
  var m = ls('sgx-theme-mode');
  return m === 'light' || m === 'dark' ? m : 'system';
}
/** @returns {boolean} 当前实际是否深色 */
export function isDark() {
  return document.documentElement.classList.contains('dark');
}
/** @returns {string} 当前调色板 id */
export function palette() {
  return normPalette(ls('sgx-palette'));
}
/** @returns {boolean} 有没有自定义主题色 */
export function hasAccent() {
  return /^#[0-9a-fA-F]{6}$/.test(ls('sgx-accent') || '');
}

/** 设置主题模式（子站）。 @param {'light'|'dark'|'system'} mode */
export function setThemeMode(mode) {
  lsSet('sgx-theme-mode', mode === 'light' || mode === 'dark' ? mode : null);
  syncUiCookie();
  reapply();
}
/** 「跟随系统」开 → 关并固定为当前深 / 浅色；关 → 改回跟随系统（同主站 lib/prefs.js）。 */
export function toggleFollowSystem() {
  if (themeMode() === 'system') setThemeMode(isDark() ? 'dark' : 'light');
  else setThemeMode('system');
}
/** 选预设色板（子站）：清掉自定义主题色，默认 dustyblue 不存。 @param {string} p */
export function setPalette(p) {
  var v = normPalette(p);
  lsSet('sgx-accent', null);
  lsSet('sgx-accent-css', null);
  lsSet('sgx-palette', v === DEFAULT_PALETTE ? null : v);
  var d = document.documentElement;
  d.style.removeProperty('--sgx-seed');
  if (v === DEFAULT_PALETTE) d.removeAttribute('data-palette');
  else d.setAttribute('data-palette', v);
  var st = document.getElementById('sgx-accent-roles');
  if (st && st.parentNode) st.parentNode.removeChild(st);
  syncUiCookie();
  reapply();
}
/** 写语言偏好（'zh' / 'en'；'system' = 删 key）；跳到哪种语言的页面由调用方决定。 @param {'system'|'zh'|'en'} v */
export function setLangPref(v) {
  lsSet('sgx-lang', v === 'zh' || v === 'en' ? v : null);
  syncUiCookie();
}
/* @sgx-shell:end */
