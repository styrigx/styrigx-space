/**
 * @fileoverview 进站终端外壳（进站 v3，SPACE-V3 §1.3「前端文件」/ §2.2）：锁屏（shell/space/entry.js，全屏）和盾牌（shell/space/shield.js，下拉）共用的
 * 一行真输入框 + 输出区：输出行、命令回显、选项（可点）、不回显的秘密输入、^C / esc、↑↓ 历史、手机输入法回车补提交（#333 的 IME 修正）、
 * 触屏 ^C 键、一轮结束后把焦点还给输入行。写法照账号终端外壳 shell/account/term.js（那边是一个宿主，这边两个宿主）。
 *
 * 不认识任何命令：宿主传 onCmd(raw)（命令模式下回车）和 ps()（命令行提示符）。类名都带宿主给的前缀 p
 * （锁屏 sgx-entry、盾牌复用账号下拉的 sgx-at），行样式 `<p>-l` + `<p>-l--<d|er|warn|ok|echo|opts>`。
 * 终端统一 T2 起实现在 shell/term/view/input-line.js（和账号下拉同一份），这里只转出，原有导出照旧。
 */
import { createInputLine, SECRET_MODES } from '../term/view/input-line.js';
import { flatStrings, shellSection } from '../term/core/strings.js';

/** 输入不回显的模式：解锁密码、临时钥匙、恢复钥匙、新密码两次 */
export { SECRET_MODES };

/**
 * 锁屏 / 盾牌的输入行（参数见 shell/term/view/input-line.js 的 InputLineOpts；这两处都用缺省的那一套）
 * @param {import('../term/view/input-line.js').InputLineOpts} o
 */
export function createTerm(o) {
  return createInputLine(o);
}

/** 嵌套字符串表 → 点号键：终端统一 T1 起在 shell/term/core/strings.js，这里转出 */
export { flatStrings };

/**
 * 外壳字符串表（#sgx-i18n-shell，四站同一份，当前语言已叠在英文上）的一节 → 取文案函数（缺键回 ''）。
 * @param {Document} doc @param {string} sec 例如 'space' @returns {(k: string) => string}
 */
export function shellTable(doc, sec) {
  const S = flatStrings(shellSection(doc, sec));
  return function (k) { return S[k] || ''; };
}
