/**
 * 页面跳转的统一入口（B2：诊断留痕已删除，只剩跳转本身）。
 * 参数 who / reason 仅为兼容旧调用保留，不再记录。
 */

/**
 * 跳转（location.href）。
 * @param {string} url 目标 URL
 * @param {string} [_who]
 * @param {string} [_reason]
 */
export function sgxNavigate(url, _who, _reason) {
  location.href = url;
}

/**
 * 跳转（location.replace，不留历史）。
 * @param {string} url 目标 URL
 * @param {string} [_who]
 * @param {string} [_reason]
 */
export function sgxReplace(url, _who, _reason) {
  location.replace(url);
}

/**
 * history.back()。
 * @param {string} [_who]
 * @param {string} [_reason]
 */
export function sgxGoBack(_who, _reason) {
  history.back();
}

/**
 * 重载当前页（location.reload）。
 * @param {string} [_who]
 * @param {string} [_reason]
 */
export function sgxReload(_who, _reason) {
  location.reload();
}

/**
 * 整页跳转（location.assign）。
 * @param {string} url 目标 URL
 * @param {string} [_who]
 * @param {string} [_reason]
 */
export function sgxAssign(url, _who, _reason) {
  location.assign(url);
}
