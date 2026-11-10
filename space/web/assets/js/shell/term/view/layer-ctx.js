/**
 * @fileoverview 一个输入行、几套命令上下文（v5 S5 终端合一）：钥匙层（shell/space/*）和账号层（shell/account/*）的模块各自往「自己的」上下文上挂函数
 * （两边都有 verify / cmdReset / cmdPasswd / authErr / reauthExp …，同名不同义），但输出、输入模式、秘密输入、选择都走同一个输入行（input-line.js 的 C）。
 *
 * layerCtx(C, own)：以 C 为原型的新对象 + own 里的字段。输入行自己读写的状态（mode / onSecret / onCancel / busyCancel / refocus）
 * 必须落在 C 上（input-line 的函数闭包里拿的是 C），所以这几个字段在子上下文上做成转发到 C 的读写器；其余字段（文案 t、api、票、列表…）各管各的。
 */

/** input-line.js 读写的共享状态 */
const SHARED = Object.freeze(['mode', 'onSecret', 'onCancel', 'busyCancel', 'refocus']);

/**
 * @param {any} C createInputLine 的上下文
 * @param {Record<string, any>} own 这一层自己的字段（t / tf / api / esc 以外的东西由各模块 mount 时挂）
 * @returns {any}
 */
export function layerCtx(C, own) {
  const R = Object.create(C);
  SHARED.forEach(function (k) {
    Object.defineProperty(R, k, {
      get: function () { return C[k]; },
      set: function (v) { C[k] = v; },
      enumerable: true,
    });
  });
  return Object.assign(R, own);
}
