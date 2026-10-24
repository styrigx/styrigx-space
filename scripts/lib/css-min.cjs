/**
 * @fileoverview 保守的 CSS 压缩（scripts/build-css.cjs --minify 用，2026-10-24 PR3）。
 *
 * 只做两件事：删注释、把空白收成最少。不合并规则、不改写颜色 / 简写、不调顺序、不动引号里的字符串，
 * 所以压缩前后每条规则的选择器、每条声明的属性和值（按 token 看）完全一样——
 * tests/web/ui/css-min.test.mjs 用 postcss 逐条核对 input.css 压缩前后一致。
 * 为什么不用 lightningcss / Hugo minify：它们会合并、改写声明（tdewolff 还不认 @view-transition），
 * 要求的是画面逐像素不变，宁可少压一点。
 */
const postcss = require('postcss');

/**
 * 引号外的连续空白收成一个空格；引号里的原样保留。
 * @param {string} v
 */
function squash(v) {
  let out = '';
  let q = '';
  let ws = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (q) {
      out += c;
      if (c === '\\' && i + 1 < v.length) { out += v[++i]; continue; }
      if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'") { if (ws) { out += ' '; ws = false; } q = c; out += c; continue; }
    if (/\s/.test(c)) { ws = true; continue; }
    if (ws) { out += ' '; ws = false; }
    out += c;
  }
  return out.trim();
}

/** 选择器：收空白，再去掉逗号两边的空格（引号外） @param {string} sel */
function squashSelector(sel) {
  const s = squash(sel);
  let out = '';
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      out += c;
      if (c === '\\' && i + 1 < s.length) { out += s[++i]; continue; }
      if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'") { q = c; out += c; continue; }
    if (c === ',') { out = out.replace(/ $/, '') + ','; if (s[i + 1] === ' ') i++; continue; }
    out += c;
  }
  return out;
}

/**
 * @param {string} css
 * @returns {string}
 */
function minifyCss(css) {
  const root = postcss.parse(css);
  root.walkComments((c) => { c.remove(); });
  root.walk((n) => {
    n.raws.before = '';
    n.raws.after = '';
    if (n.type === 'decl') {
      /* 值里夹着注释时 postcss 把原文放在 raws.value：用去掉注释后的值 */
      if (n.raws.value) delete n.raws.value;
      const v = squash(n.value);
      /* 空的自定义属性（--x: ;）保留一个空格，避免旧浏览器把 --x:; 当成无效 */
      n.raws.between = v === '' ? ': ' : ':';
      n.value = v;
      if (n.important) n.raws.important = '!important';
    } else if (n.type === 'rule') {
      if (n.raws.selector) delete n.raws.selector;
      n.selector = squashSelector(n.selector);
      n.raws.between = '';
      n.raws.semicolon = false;
    } else if (n.type === 'atrule') {
      if (n.raws.params) delete n.raws.params;
      n.params = squash(n.params);
      n.raws.afterName = n.params ? ' ' : '';
      n.raws.between = '';
      n.raws.semicolon = false;
    }
  });
  root.raws.after = '';
  root.raws.semicolon = false;
  return root.toString() + '\n';
}

module.exports = { minifyCss, squash, squashSelector };
