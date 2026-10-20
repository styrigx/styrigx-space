/**
 * @fileoverview 共享 UI 设置 cookie（5.2）：主站写入，书站读取。
 * 只含 UI 设置（时区、时钟、天气；B2-7 起加外观：深浅色、调色板、字体大小、减弱动效），不含任何凭证或会话信息。
 * 子站（blog / daymark）首帧前读它，让外观跟主站一致（主站 localStorage 是唯一来源，cookie 只是镜像，子站只读不写）。
 * cookie：sgx-ui=<base64url JSON>; Domain=styrigx.com; Path=/; Max-Age=34560000; SameSite=Lax; Secure
 * 不加 HttpOnly（书站要用 JS 读）。
 */

var COOKIE_NAME = 'sgx-ui';
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
  var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE_NAME + '=([^;]*)'));
  return m ? m[1] : '';
}

/**
 * 解码 cookie 值（base64url JSON），失败返回 null。
 * @param {string} v
 * @returns {any}
 */
function decodeCookie(v) {
  if (!v) return null;
  try {
    var b = v.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    return JSON.parse(decodeURIComponent(escape(atob(b))));
  } catch (e) {
    return null;
  }
}

/**
 * 同步 UI 设置到共享 cookie。值没变就不重写。
 * 字段→key 对应（v1.1 勘误）：
 *   tz1←sgx-tz1（sgx-tz1-auto 为真写 "auto"）；tz2←sgx-tz2；h12←sgx-hour12；
 *   clock←sgx-gl-clockstyle；wx←sgx-weather-show；unit←sgx-temp-unit；
 *   loc←sgx-weather-loc；city←sgx-weather-city；precise←sgx-weather-precise。
 *   B2-7（v2）外观：mode←sgx-theme-mode（system/light/dark）；pal←sgx-palette（缺省 lake）；
 *   fs←sgx-font-size（small/standard/large）；rm←sgx-reduced-motion（"1" 为 1）；
 *   mat：mode 最近一次变化的时间戳（毫秒）。子站自己也能切深浅色，两边谁后改听谁的。
 * sgx-weather 是数据缓存，不进 cookie。
 */
export function syncUiCookie() {
  var tz1Auto = boolOnNull('sgx-tz1-auto');
  var payload = {
    v: 2,
    tz1: tz1Auto ? 'auto' : (ls('sgx-tz1') || ''),
    tz2: ls('sgx-tz2') || '',
    h12: ls('sgx-hour12') === '12' ? 1 : 0,
    clock: ls('sgx-gl-clockstyle') === '1' ? 'analog' : 'digital',
    wx: boolOnNull('sgx-weather-show') ? 1 : 0,
    unit: ls('sgx-temp-unit') === 'f' ? 'f' : 'c',
    loc: ls('sgx-weather-loc') || 'auto',
    city: parseJson(ls('sgx-weather-city')),
    precise: parseJson(ls('sgx-weather-precise')),
    mode: ['light', 'dark'].indexOf(ls('sgx-theme-mode') || '') >= 0 ? ls('sgx-theme-mode') : 'system',
    pal: /^[a-z]{2,16}$/.test(ls('sgx-palette') || '') ? ls('sgx-palette') : 'lake',
    fs: ['small', 'large'].indexOf(ls('sgx-font-size') || '') >= 0 ? ls('sgx-font-size') : 'standard',
    rm: ls('sgx-reduced-motion') === '1' ? 1 : 0,
  };
  /* mat：深浅色没变就沿用旧时间戳，变了（或第一次写）记当前时间 */
  var old = decodeCookie(readCookie());
  payload.mat = old && old.mode === payload.mode && typeof old.mat === 'number' ? old.mat : Date.now();
  var json = JSON.stringify(payload);
  /* base64url 编码（中文城市名需先 UTF-8） */
  var b64 = btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (readCookie() === b64) return; /* 没变就不重写 */
  document.cookie = COOKIE_NAME + '=' + b64 + COOKIE_ATTRS;
}
