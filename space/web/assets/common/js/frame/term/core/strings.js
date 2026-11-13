/**
 * @fileoverview 终端公共件（终端统一 T1，设计稿 v1.5 §4）：外壳字符串表 #sgx-i18n-frame 的读取、嵌套表拍平、按键提示行英文底。
 * 纯函数、不 import 本目录以外的东西。term/terminal.js、ai/panel.js、term/view/keyhint.js、shell/space/term.js、account/term.js 共用这一份。
 */

/**
 * 外壳字符串表（#sgx-i18n-frame，当前语言已叠在英文上）的一节；读不到 / 不是对象 → {}
 * @param {Document|null|undefined} doc 缺省用 document
 * @param {string} sec 例如 'term'、'kh'、'ai'、'space'
 * @returns {Record<string, any>}
 */
export function frameSection(doc, sec) {
  try {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    const el = d && d.getElementById ? d.getElementById('sgx-i18n-frame') : null;
    const o = el && el.textContent ? JSON.parse(el.textContent) : null;
    const v = o && o[sec];
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    return {};
  }
}

/**
 * 嵌套字符串表 → 点号键（space.common.termAria → 'common.termAria'）
 * @param {any} tree @param {string} [pre] @param {Record<string, string>} [acc]
 * @returns {Record<string, string>}
 */
export function flatStrings(tree, pre, acc) {
  const out = acc || {};
  if (!tree || typeof tree !== 'object') return out;
  for (const k in tree) {
    const v = tree[k];
    const key = pre ? pre + '.' + k : k;
    if (v && typeof v === 'object') flatStrings(v, key, out);
    else if (typeof v === 'string') out[key] = v;
  }
  return out;
}

/** 英文底（源文本）；页面上以 #sgx-i18n-frame 的 kh 节为准。键名 = 状态 */
export const KH_EN = Object.freeze({
  /** 窗口里的命令行（盾牌 / 账号下拉首层、抽屉终端）：esc 关窗口 */
  cmd: 'enter run · esc close',
  /** 窗口里的下一层命令行：esc 回上一层 */
  cmdLayer: 'enter run · esc back',
  /** 抽屉终端 */
  cmdDrawer: 'tab complete · enter run · esc close',
  /** 选择 [1] [2] … */
  pick: '[n] pick · enter default · esc back · ^C quit',
  /** 不回显的秘密输入 */
  secret: 'enter submit · hidden input · esc back · ^C quit',
  /** 起名（通行密钥名字，可空） */
  name: 'enter save · esc back · ^C quit',
  /** 等待中、能中断（通行密钥） */
  busy: '^C cancel',
  /** AI 窗口 */
  ai: 'enter send · shift+enter newline · esc close',
  /** 触屏的出口按钮 */
  back: '‹ back',
  backAria: 'Back',
});
