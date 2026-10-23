/**
 * @fileoverview 共享 UI 设置 cookie（5.2）：主站写入，书站读取。
 * 只含 UI 设置（时区、时钟、天气；B2-7 起加外观：深浅色、调色板、字体大小、减弱动效），不含任何凭证或会话信息。
 * 子站（blog / daymark / curio）首帧前用共享外壳的 ui-cookie-read.js 读它，让外观跟主站一致（主站 localStorage 是唯一来源，cookie 只是镜像，子站只读不写）。
 * 契约测试：tests/fixtures/ui-cookie-contract.json（本写端真实产出的 cookie + 读端期望结果，共享外壳原样带给子站）。
 * cookie：sgx-ui=<base64url JSON>; Domain=styrigx.com; Path=/; Max-Age=34560000; SameSite=Lax; Secure
 * 不加 HttpOnly（书站要用 JS 读）。
 */

/* 字段表 / 版本 / 编解码和子站读端共用一份（lib/ui-cookie-read.js，经典脚本，挂 window.SgxUI；共享外壳原样分发给子站） */
import './ui-cookie-read.js';

var U = /** @type {any} */ (window).SgxUI;
var COOKIE_NAME = U.NAME;
var COOKIE_MAX_AGE = 34560000; /* 400 天 */
var COOKIE_ATTRS = '; Domain=styrigx.com; Path=/; Max-Age=' + COOKIE_MAX_AGE + '; SameSite=Lax; Secure';

/**
 * 从 localStorage 读原始值（features.js 的存储格式）。
 * @param {string} k
 * @returns {string|null}
 */
function ls(k) {
  try {
    var v = window.localStorage.getItem(k);
    return v === null ? null : v;
  } catch (e) {
    return null;
  }
}

/**
 * bool 型 feature：storage on=null/off="0" 时，缺失或非 "0" 即为真。
 * @param {string} k
 * @returns {boolean}
 */
function boolOnNull(k) {
  return ls(k) !== '0';
}

/**
 * 安全解析 JSON，失败返回 null。
 * @param {string|null} s
 * @returns {any}
 */
function parseJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

/**
 * 读当前 cookie 值（用于比较，避免无变化重写）。
 * @returns {string}
 */
function readCookie() {
  var m = document.cookie.match(/(?:^|;\s*)sgx-ui=([^;]*)/);
  return m ? m[1] : '';
}

/**
 * 解码 cookie 值（base64url JSON），失败返回 null。
 * @param {string} v
 * @returns {any}
 */
function decodeCookie(v) {
  return U.decode(v);
}

/**
 * 同步 UI 设置到共享 cookie。值没变就不重写。
 * 字段→key 对应（v1.1 勘误）：
 *   tz1←sgx-tz1（sgx-tz1-auto 为真写 "auto"）；tz2←sgx-tz2；h12←sgx-hour12；
 *   clock←sgx-gl-clockstyle；wx←sgx-weather-show；unit←sgx-temp-unit；
 *   loc←sgx-weather-loc；city←sgx-weather-city；precise←sgx-weather-precise。
 *   B2-7（v2）外观：mode←sgx-theme-mode（system/light/dark）；pal←sgx-palette（缺省 lake）；
 *   accent：当前主题色种子 #rrggbb（PR3 色彩角色 token；sgx-accent 自定义优先，否则读 --sgx-seed 即预设色板的种子），
 *   子站拿它派生同一套角色；读不到为 ''。
 *   fs / rm：固定 'standard' / 0（2026-10-23 PR-E 删了字体大小、减弱动效设置；子站减弱动效跟系统 prefers-reduced-motion）；
 *   mat：mode 最近一次变化的时间戳（毫秒）。子站自己也能切深浅色，两边谁后改听谁的。
 * sgx-weather 是数据缓存，不进 cookie。
 */
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

export function syncUiCookie() {
  var tz1Auto = boolOnNull('sgx-tz1-auto');
  var payload = {
    v: U.V,
    tz1: tz1Auto ? 'auto' : (ls('sgx-tz1') || ''),
    tz2: ls('sgx-tz2') || '',
    h12: ls('sgx-hour12') === '12' ? 1 : 0,
    clock: ls('sgx-gl-clockstyle') === '1' ? 'analog' : 'digital',
    wx: boolOnNull('sgx-weather-show') ? 1 : 0,
    unit: ls('sgx-temp-unit') === 'f' ? 'f' : 'c',
    loc: ls('sgx-weather-loc') || 'auto',
    city: parseJson(ls('sgx-weather-city')),
    precise: parseJson(ls('sgx-weather-precise')),
    mode: U.MODES.indexOf(ls('sgx-theme-mode') || '') >= 0 ? ls('sgx-theme-mode') : 'system',
    /* 只写读端认识的预设（未知 id 主站本来也渲染成默认 lake） */
    pal: Object.prototype.hasOwnProperty.call(U.PRESETS, ls('sgx-palette') || '') ? ls('sgx-palette') : U.DEFAULT_PAL,
    accent: currentSeed(),
    /* fs / rm：字体大小、减弱动效两个设置 2026-10-23 删除，字段保留（子站读端认识它们）但固定写默认值，旧 localStorage 值不再带给子站 */
    fs: 'standard',
    rm: 0,
  };
  /* mat：深浅色没变就沿用旧时间戳，变了（或第一次写）记当前时间 */
  var old = decodeCookie(readCookie());
  payload.mat = old && old.mode === payload.mode && typeof old.mat === 'number' ? old.mat : Date.now();
  /* base64url 编码（中文城市名需先 UTF-8） */
  var b64 = U.encode(payload);
  if (readCookie() === b64) return; /* 没变就不重写 */
  document.cookie = COOKIE_NAME + '=' + b64 + COOKIE_ATTRS;
}
