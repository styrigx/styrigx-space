/**
 * 页面跳转的统一入口：全站跳转都走这里，方便以后统一加过渡 / 拦截。
 * （文件名沿用旧的诊断模块名，诊断留痕早已删除。）
 */

/** 跳转（location.href）。 @param {string} url */
export function sgxNavigate(url) {
  location.href = url;
}

/** 跳转但不留历史（location.replace）。 @param {string} url */
export function sgxReplace(url) {
  location.replace(url);
}

/** 重载当前页。 */
export function sgxReload() {
  location.reload();
}
