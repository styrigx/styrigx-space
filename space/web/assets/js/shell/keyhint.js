/**
 * @fileoverview 终端窗口底部的按键提示行（Gray 2026-11-09 细节 1）：一行淡灰等宽小字，跟着终端状态换，
 * 例如命令行「enter 执行 · esc 关闭」、选择「[n] 选择 · enter 默认项 · esc 返回 · ^C 退出」。
 * 触屏不显示按键（没有键盘），改成一个「‹ 返回」按钮，按下 = 这个状态的退出路径（同 esc）——每个终端状态都要有出口（Gray 2026-11-09）。
 *
 * 用在锁屏、盾牌（shell/space/term.js 的宿主）和账号下拉（shell/account/term.js）。主页 / 抽屉终端（shell/terminal.js）和 AI 窗口（shell/ai-panel.js）
 * 是不 import 的共享外壳组件，各自内联同样的几行，文案同一张表：#sgx-i18n-shell 的 kh 节（data/sgx-shell-i18n/<语言>.yaml，缺键回退下面的英文）。
 *
 * 读屏：按键文字是装饰（aria-hidden），「‹ 返回」是真按钮（有名字，读屏能点）。
 */

/** 英文底（源文本）；页面上以 #sgx-i18n-shell 的 kh 节为准。键名 = 状态 */
export const KH_EN = Object.freeze({
  /** 窗口里的命令行（盾牌 / 账号下拉首层、抽屉终端）：esc 关窗口 */
  cmd: 'enter run · esc close',
  /** 窗口里的下一层命令行：esc 回上一层 */
  cmdLayer: 'enter run · esc back',
  /** 锁屏命令行（进站之前没有别处可去） */
  cmdEntry: 'enter run · ↑↓ history · ^L clear',
  /** 主页嵌入的终端（标题栏已有 tab / ↑ / Ctrl K） */
  cmdHome: 'enter run · ^C cancel · ^L clear',
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

/**
 * #sgx-i18n-shell 的 kh 节叠在英文上
 * @param {Document} [doc] @returns {Record<string, string>}
 */
export function khStrings(doc) {
  /** @type {Record<string, string>} */
  let page = {};
  try {
    const d = doc || document;
    const el = d.getElementById('sgx-i18n-shell');
    const j = el && el.textContent ? JSON.parse(el.textContent) : null;
    if (j && j.kh && typeof j.kh === 'object') page = j.kh;
  } catch (e) {}
  return Object.assign({}, KH_EN, page);
}

/**
 * 输入行模式 → 提示键（space/term.js、account/term.js 的 mode）。cmd 由宿主按层给（cmd / cmdLayer / cmdEntry），返回 '' = 不显示
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
