/**
 * #1 诊断：跳转追踪与门内页信标（诊断专用，定位后删除）。
 *
 * - sgxNavigate / sgxReplace / sgxGoBack：跳转前在 sessionStorage 留痕，
 *   记录触发点、来源路径、data-sgx-* 状态、时间戳；安全页加载时显示一次。
 * - 门内页信标：门内页 <head> 内联脚本在 HTML 到达浏览器时即写
 *   sessionStorage（'sgx-door-beacon'）；安全页显示最近一条。
 *   无信标 = 门内页 HTML 根本没到浏览器（服务端问题）；有信标 = 前端跳走的。
 *
 * 不记录密钥、Cookie 值；不改认证逻辑。
 */

/* #1 诊断：门内页跳转留痕。跳转前记「谁触发的 + 原因」，
   安全页加载时取出来显示一次（取即清除）。 */
const JUMP_KEY = 'sgx-last-jump';
/**
 * @param {string} who 触发方（如 probe-fail-back、needVerify、clear-stepup、lockout）
 * @param {string} [reason] 原因（服务端 reason 码等，不含密钥或 Cookie 值）
 */
export function recordJump(who, reason) {
  try {
    sessionStorage.setItem(JUMP_KEY, JSON.stringify({ who: who, reason: reason || '', at: Date.now() }));
  } catch (e) {}
}
/** @returns {{who:string, reason:string, at:number}|null} 取出并清除记录 */
export function takeJumpRecord() {
  try {
    const raw = sessionStorage.getItem(JUMP_KEY);
    sessionStorage.removeItem(JUMP_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && o.who ? o : null;
  } catch (e) {
    return null;
  }
}

/** @returns {string} 当前页 data-sgx-* 状态摘要 */
function sgxStateSummary() {
  try {
    const h = document.documentElement;
    return [
      'from=' + location.pathname,
      'session=' + h.getAttribute('data-sgx-session'),
      'role=' + h.getAttribute('data-sgx-role'),
      'upgrade=' + h.getAttribute('data-sgx-upgrade'),
      'build=' + h.getAttribute('data-sgx-build'),
    ].join(',');
  } catch (e) {
    return 'from=' + location.pathname;
  }
}

/**
 * 记录并跳转（location.href）。
 * @param {string} url 目标 URL
 * @param {string} who 触发点（如 'lock.js:1102'）
 * @param {string} [reason] 原因说明
 */
export function sgxNavigate(url, who, reason) {
  try {
    recordJump(who, (reason ? reason + ';' : '') + 'to=' + url + ';' + sgxStateSummary());
  } catch (e) {}
  location.href = url;
}

/**
 * 记录并跳转（location.replace，不留历史）。
 * @param {string} url 目标 URL
 * @param {string} who 触发点
 * @param {string} [reason] 原因说明
 */
export function sgxReplace(url, who, reason) {
  try {
    recordJump(who, (reason ? reason + ';' : '') + 'to=' + url + ';replace;' + sgxStateSummary());
  } catch (e) {}
  location.replace(url);
}

/**
 * 记录并 history.back()。
 * @param {string} who 触发点
 * @param {string} [reason] 原因说明
 */
export function sgxGoBack(who, reason) {
  try {
    recordJump(who, (reason ? reason + ';' : '') + 'to=history.back;' + sgxStateSummary());
  } catch (e) {}
  history.back();
}

/** 门内页信标的 sessionStorage 键 */
export const BEACON_KEY = 'sgx-door-beacon';

/**
 * 写门内页信标（模块版；<head> 内联脚本用自包含版本，逻辑保持一致）。
 */
export function recordBeacon() {
  try {
    const h = document.documentElement;
    sessionStorage.setItem(BEACON_KEY, JSON.stringify({
      path: location.pathname,
      at: Date.now(),
      session: h.getAttribute('data-sgx-session'),
      role: h.getAttribute('data-sgx-role'),
      upgrade: h.getAttribute('data-sgx-upgrade'),
      build: h.getAttribute('data-sgx-build'),
    }));
  } catch (e) {}
}

/**
 * 取出并清除门内页信标。
 * @returns {{path:string,at:number,session:string|null,role:string|null,upgrade:string|null,build:string|null}|null}
 */
export function takeBeaconRecord() {
  try {
    const raw = sessionStorage.getItem(BEACON_KEY);
    sessionStorage.removeItem(BEACON_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && o.path ? o : null;
  } catch (e) {
    return null;
  }
}
