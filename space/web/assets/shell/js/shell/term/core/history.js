/**
 * @fileoverview 命令历史（终端统一 T3：从 shell/terminal.js 搬来）：↑ 从最近一条往前、第一次按先存草稿，↓ 到底回草稿；相邻重复只记一次；上限 50。
 * 有 storage + key 就落盘（tty2 sessionStorage sgx-term-hist，键名不变）；没有就只在内存。秘密 / 选择输入不进历史（由调用方决定不 push）。
 */

export const HIST_MAX = 50;

/** @param {{ storage?: Storage|null, key?: string, max?: number }} [o] */
export function createHistory(o) {
  const store = (o && o.storage) || null;
  const key = (o && o.key) || '';
  const max = (o && o.max) || HIST_MAX;
  /** @type {string[]} */
  let hist = [];
  try {
    const raw = store && key ? store.getItem(key) : null;
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) hist = arr.filter(function (x) { return typeof x === 'string'; }).slice(-max);
  } catch (e) {}
  let hi = hist.length;
  let draft = '';
  function save() {
    try { if (store && key) store.setItem(key, JSON.stringify(hist.slice(-max))); } catch (e) {}
  }
  return {
    /** @param {string} line */
    push: function (line) {
      const s = String(line == null ? '' : line).trim();
      if (s && hist[hist.length - 1] !== s) {
        hist.push(s);
        if (hist.length > max) hist = hist.slice(-max);
        save();
      }
      hi = hist.length;
      draft = '';
    },
    /** ↑ @param {string} cur @returns {string|null} */
    prev: function (cur) {
      if (!hist.length) return null;
      if (hi === hist.length) draft = cur;
      if (hi > 0) hi--;
      return hist[hi];
    },
    /** ↓ @returns {string|null} */
    next: function () {
      if (hi >= hist.length) return null;
      hi++;
      return hi === hist.length ? draft : hist[hi];
    },
    list: function () { return hist.slice(); },
  };
}
