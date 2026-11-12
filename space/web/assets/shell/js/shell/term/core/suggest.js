/**
 * @fileoverview 打错命令时给最近的真命令（Gray 2026-11-09）：`command not found: X — did you mean Y?`。纯函数、不 import。
 * 终端统一 T1（设计稿 v1.5 §4）：唯一一份。站内终端 shell/terminal.js、锁屏 / 盾牌（shell/space/*）、账号下拉（shell/account/term.js）都用这里；
 * shell/suggest.js 只转出（原有 import 路径不坏）。单测 tests/space/ui/shell/suggest.test.mjs。
 */

/** 编辑距离（Levenshtein） @param {string} a @param {string} b @returns {number} */
export function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * 最近的真命令：整行和每个命令比，第一个词也和每个命令的第一个词比（`sdo` → `sudo`，`mna` → `man`）。
 * 距离 ≤ 2 且不超过较长那个的一半才算像；一样近取列表里靠前的。没有像的 → ''
 * @param {string} raw @param {string[]} cands @returns {string}
 */
export function suggest(raw, cands) {
  const x = String(raw || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!x) return '';
  const w = x.split(' ')[0];
  let best = '';
  let bd = Infinity;
  for (const c of cands) {
    let d = lev(x, c);
    let ok = d <= 2 && d * 2 <= Math.max(x.length, c.length);
    if (c.indexOf(' ') === -1 && w !== x) {
      const d2 = lev(w, c);
      if (d2 <= 2 && d2 * 2 <= Math.max(w.length, c.length) && d2 < d) { d = d2; ok = true; }
    }
    if (ok && d > 0 && d < bd) { bd = d; best = c; }
  }
  return best;
}
