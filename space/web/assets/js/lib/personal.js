/**
 * @fileoverview 个人信息类（不走语言组，语言清理 2026-11-07）。
 *
 * 定义：只跟用户自己的设置 / 账号数据有关的值——名字、昵称、用户名、邮箱、头像（及其替代文字里的名字）、个人简介 / 签名、
 * 用户自己起的通行密钥名、自定义标签等。这类值从用户设置 / 账号数据读取后原样渲染：不进任何语言的字符串表，也不按语言分两份。
 *
 * 标记：元素带 translate="no" 和 data-sgx-personal。浏览器翻译、以后的「翻译此页」按钮、串语言 / 漏翻检测都跳过这类节点
 * （模板侧同一标记，见 layouts/partials/sgx-personal.html）。
 *
 * 系统给的默认值（例如没起名的通行密钥显示「Passkey / 通行密钥」）不是个人信息，是界面文案，走字符串表。
 */

/** 标记属性名 */
export const PERSONAL_ATTR = 'data-sgx-personal';

/**
 * 给元素打上个人信息类标记（原样、不翻译）。
 * @template {Element} E
 * @param {E} el
 * @returns {E}
 */
export function markPersonal(el) {
  if (el && el.setAttribute) {
    el.setAttribute('translate', 'no');
    el.setAttribute(PERSONAL_ATTR, '');
  }
  return el;
}

/**
 * 节点（或它的祖先）是否属于个人信息类。
 * @param {Node|null} node
 */
export function isPersonal(node) {
  let n = /** @type {any} */ (node);
  if (n && n.nodeType !== 1) n = n.parentElement;
  return !!(n && n.closest && n.closest('[' + PERSONAL_ATTR + ']'));
}
