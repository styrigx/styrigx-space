/**
 * @fileoverview tab 补全 / 补全影子（终端统一 T3：从 shell/terminal.js 搬来，候选改从注册表取）。纯函数。
 */

/** 一组字符串的公共前缀 @param {string[]} list */
export function commonPrefix(list) {
  if (!list.length) return '';
  let p = list[0];
  for (const s of list) {
    let i = 0;
    while (i < p.length && i < s.length && p[i] === s[i]) i++;
    p = p.slice(0, i);
  }
  return p;
}

/**
 * tab 补全：只补最后一个词（第一个词补命令名，第二个词按命令补参数）。
 * 唯一候选 → 补全并在带参数的命令名后加空格；多个 → 补到公共前缀，options 列出全部；没有 → 原样。
 * @param {string} line
 * @param {{ names: string[], argsOf: (cmd: string) => string[], takesArgs: (cmd: string) => boolean }} src
 * @returns {{line: string, options: string[]}}
 */
export function completeLine(line, src) {
  const s = String(line == null ? '' : line);
  const lead = s.replace(/^\s+/, '');
  const pad = s.slice(0, s.length - lead.length);
  const words = lead.split(/\s+/);
  /** @type {string[]} */
  let pool;
  const idx = words.length - 1;
  if (idx === 0) pool = src.names;
  else if (idx === 1) pool = src.argsOf(words[0].toLowerCase());
  else pool = [];
  const word = words[idx];
  const hits = pool.filter(function (c) { return c.indexOf(word) === 0; });
  if (!hits.length) return { line: s, options: [] };
  const head = pad + words.slice(0, idx).join(' ') + (idx ? ' ' : '');
  if (hits.length === 1) {
    const one = hits[0];
    return { line: head + one + (idx === 0 && src.takesArgs(one) ? ' ' : ''), options: [] };
  }
  return { line: head + commonPrefix(hits), options: hits };
}

/**
 * 补全的「影子」：只有唯一候选时，返回还没打的那一截
 * @param {string} line @param {(line: string) => {line: string, options: string[]}} complete @returns {string}
 */
export function ghostOf(line, complete) {
  const s = String(line == null ? '' : line);
  if (!s.trim()) return '';
  const c = complete(s);
  if (c.options.length || c.line === s) return '';
  const full = c.line.replace(/\s+$/, '');
  return full.indexOf(s) === 0 ? full.slice(s.length) : '';
}

/**
 * 命令表 { names, args } → 补全函数（锁屏 / 盾牌 / 账号用；有参数候选的命令补全后加空格）
 * @param {{ names: readonly string[], args: Readonly<Record<string, readonly string[]>> }} table
 * @returns {(line: string) => {line: string, options: string[]}}
 */
export function completerOf(table) {
  const has = function (/** @type {string} */ c) { return Object.prototype.hasOwnProperty.call(table.args, c); };
  return function (line) {
    return completeLine(line, {
      names: table.names.slice(),
      argsOf: function (c) { return has(c) ? table.args[c].slice() : []; },
      takesArgs: has,
    });
  };
}
