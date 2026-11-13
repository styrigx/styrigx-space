/**
 * @fileoverview 终端选择（[1] [2] …，锁屏 / 盾牌 shell/space/term.js、账号下拉 account/term.js）的高亮跟着输入走（Gray 2026-11-09 手机截图：
 * 在 `>` 后面打了 2，回车之前 [1] 还亮着）。桌面单键直接选中不经过这里；手机输入法的按键不报具体键（keydown 是 Unidentified），字进了输入框，靠 input 事件重画高亮。
 */

/**
 * 输入框里的字 → 该亮哪一项：空 = 默认项；是某个选项（去掉 [ ]、不分大小写）= 那一项；别的 = 都不亮
 * @param {string} value @param {string[]} keys @param {string} def @returns {string}
 */
export function pickKeyOf(value, keys, def) {
  const v = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!v) return keys.indexOf(def) !== -1 ? def : '';
  return keys.indexOf(v) !== -1 ? v : '';
}

/**
 * 重画输出区里最后一组选项按钮的 is-on
 * @param {HTMLElement} log 输出区 @param {string} attr 选项按钮上的键属性（data-term-pick / data-at-pick） @param {string} value @param {string[]} keys @param {string} def
 */
export function paintPick(log, attr, value, keys, def) {
  const btns = /** @type {HTMLElement[]} */ (Array.from(log.querySelectorAll('[' + attr + ']')));
  if (!btns.length) return;
  /* 只动最后一组（同一行里的按钮）：更早的选项行是历史 */
  const row = btns[btns.length - 1].parentElement;
  const on = pickKeyOf(value, keys, def);
  btns.forEach(function (b) {
    if (b.parentElement !== row) return;
    b.classList.toggle('is-on', !!on && b.getAttribute(attr) === on);
  });
}

/**
 * 选择时输入框的 inputmode：每个选项键都是数字才用 numeric（数字键盘），否则 text——[y/N] 在手机数字键盘上打不出 y（Gray 2026-11-11 三星实机）
 * @param {string[]} keys @returns {'numeric'|'text'}
 */
export function pickInputMode(keys) {
  return keys.length > 0 && keys.every(function (k) { return /^[0-9]+$/.test(k); }) ? 'numeric' : 'text';
}
