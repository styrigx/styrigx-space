/**
 * @fileoverview 终端窗口底部的按键提示行（Gray 2026-11-09 细节 1）：一行淡灰等宽小字，跟着终端状态换，
 * 例如命令行「enter 执行 · esc 关闭」、选择「[n] 选择 · enter 默认项 · esc 返回 · ^C 退出」。
 * 触屏不显示按键（没有键盘），改成一个「‹ 返回」按钮，按下 = 这个状态的退出路径（同 esc）——每个终端状态都要有出口（Gray 2026-11-09）。
 *
 * 用在锁屏、盾牌（shell/space/term.js 的宿主）和账号下拉（account/term.js）。主页 / 抽屉终端（term/terminal.js）和 AI 窗口（ai/panel.js）
 * 只许 import term/**，各自画几行，英文底同用 term/core/strings.js 的 KH_EN；文案同一张表：#sgx-i18n-shell 的 kh 节（data/common/frame/i18n/<语言>.yaml，缺键回退英文）。
 *
 * 读屏：按键文字是装饰（aria-hidden），「‹ 返回」是真按钮（有名字，读屏能点）。
 */
import { KH_EN, shellSection } from '../core/strings.js';

/** 英文底（源文本）：终端统一 T1 起放在 term/core/strings.js，这里转出 */
export { KH_EN };

/**
 * #sgx-i18n-shell 的 kh 节叠在英文上
 * @param {Document} [doc] @returns {Record<string, string>}
 */
export function khStrings(doc) {
  return Object.assign({}, KH_EN, shellSection(doc, 'kh'));
}

/**
 * 输入行模式 → 提示键（space/term.js、account/term.js 的 mode）。cmd 由宿主按层给（cmd / cmdLayer / cmdDrawer），返回 '' = 不显示
 * @param {string} mode @param {string} cmdKey @param {boolean} [busyCancel] @returns {string}
 */
export function khKeyFor(mode, cmdKey, busyCancel) {
  if (mode === 'cmd') return cmdKey;
  if (mode === 'pick') return 'pick';
  if (mode === 'pkname') return 'name';
  if (mode === 'busy') return busyCancel ? 'busy' : '';
  if (mode === 'done') return '';
  return 'secret';
}

/** 触屏（没有精确指针）：同 space/term.js focusIn 的判断 */
export function isTouch() {
  try { return !window.matchMedia('(pointer: fine)').matches; } catch (e) { return false; }
}

/**
 * 把一个 <p class="sgx-kh"> 接上。set(key, canBack)：桌面显示 key 对应的按键文字（'' = 整行隐藏）；
 * 触屏 canBack 时显示「‹ 返回」按钮（按下调 onBack），否则整行隐藏。
 * @param {HTMLElement} el
 * @param {{ onBack: () => void, str?: Record<string, string>, touch?: () => boolean }} o
 */
export function mountKeyHint(el, o) {
  const doc = el.ownerDocument || document;
  const S = o.str || khStrings(doc);
  const touch = o.touch || isTouch;
  el.textContent = '';
  const keys = doc.createElement('span');
  keys.className = 'sgx-kh-k';
  keys.setAttribute('aria-hidden', 'true');
  keys.setAttribute('translate', 'no');
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'sgx-kh-b';
  btn.setAttribute('data-kh-back', '');
  btn.setAttribute('aria-label', S.backAria);
  btn.textContent = S.back;
  btn.hidden = true;
  el.appendChild(keys);
  el.appendChild(btn);
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    o.onBack();
  });
  /** @param {string} key @param {boolean} canBack */
  function set(key, canBack) {
    if (touch()) {
      keys.textContent = '';
      btn.hidden = !canBack;
      el.hidden = !canBack;
      return;
    }
    btn.hidden = true;
    keys.textContent = (key && S[key]) || '';
    el.hidden = !keys.textContent;
  }
  return { set: set, el: el, button: btn };
}
