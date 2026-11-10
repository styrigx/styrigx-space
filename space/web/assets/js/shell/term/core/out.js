/**
 * @fileoverview 输出模型（终端统一 T3）：一行 = 片段 [类, 文字, 链接?]，只用 textContent 渲染。fill 把文案里的 {x} 等占位换成片段。
 * @typedef {Array<[string, string, string?]>} Seg
 * @typedef {{ t: 'line', seg: Seg, cls?: string } | { t: 'help', head: Seg, rows: Array<[string, string]> }} Out
 * @typedef {{ out: Out[], clear?: boolean, after?: () => void }} Result
 */

/**
 * 文案里的 {x} / {help} 等占位换成片段：返回 [[类, 文字], …]
 * @param {string} s @param {Record<string, [string, string]|[string, string, string]>} map 占位名 → [类, 文字]
 * @returns {Array<[string, string]>}
 */
export function fill(s, map) {
  /** @type {Array<[string, string]>} */
  const out = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  let m;
  const str = String(s || '');
  while ((m = re.exec(str))) {
    if (m.index > last) out.push(['', str.slice(last, m.index)]);
    const v = map[m[1]];
    out.push(v ? /** @type {any} */ (v) : ['', m[0]]);
    last = m.index + m[0].length;
  }
  if (last < str.length) out.push(['', str.slice(last)]);
  return out;
}

/**
 * 命令用的输出小工具（按当前文案表 S）
 * @param {Record<string, string>} S
 */
export function outKit(S) {
  return {
    /** @param {string} s @param {string} [cls] @returns {Out} */
    plain: function (s, cls) { return { t: 'line', seg: [['', s]], cls: cls || 'o' }; },
    /** @param {string} key @param {string} x @param {string} [cls] @param {string} [href] @returns {Out} */
    tpl: function (key, x, cls, href) { return { t: 'line', seg: fill(S[key], { x: [href ? 'a' : 'k', x, href || ''] }), cls: cls || 'o' }; },
    /** @param {string} c @param {string} x @returns {Out} */
    noDir: function (c, x) { return { t: 'line', seg: fill(S.noDir, { c: ['', c], x: ['k', x] }), cls: 'err' }; },
    /** @param {Seg} seg @returns {Out} */
    arrow: function (seg) { return { t: 'line', seg: /** @type {Seg} */ ([['ok', '→ ']]).concat(seg), cls: 'o' }; },
  };
}
