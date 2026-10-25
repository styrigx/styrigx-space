/**
 * @fileoverview Cloudflare Pages `_headers` 的最小解析 / 匹配（gen-csp.mjs --check 和单测用）。
 *
 * 按 CF 文档的语义（https://developers.cloudflare.com/pages/configuration/headers/）：
 * - 一条规则 = 不缩进的 URL 模式一行 + 下面缩进的 `名字: 值` 若干行；# 开头是注释
 * - 一个请求命中多条规则时继承所有规则的头；同名头出现两次，值用「, 」拼起来
 * - `! 名字` 去掉更宽规则加上的头
 * - 模式里的 * 贪婪匹配任意字符（只允许一个）；:name 占位符匹配到下一个 / 为止
 * 只实现本仓库用到的部分（路径模式，不含绝对 URL）。
 */

/**
 * @param {string} text
 * @returns {Array<{pattern: string, line: number, set: Array<[string, string]>, detach: string[]}>}
 */
export function parseHeaders(text) {
  /** @type {Array<{pattern: string, line: number, set: Array<[string, string]>, detach: string[]}>} */
  const rules = [];
  let cur = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      cur = { pattern: t, line: i + 1, set: [], detach: [] };
      rules.push(cur);
      continue;
    }
    if (!cur) throw new Error('_headers:' + (i + 1) + ' 头没有所属的路径规则');
    if (t.startsWith('! ')) {
      cur.detach.push(t.slice(2).trim().toLowerCase());
      continue;
    }
    const c = t.indexOf(':');
    if (c <= 0) throw new Error('_headers:' + (i + 1) + ' 不是 `名字: 值`：' + t);
    cur.set.push([t.slice(0, c).trim(), t.slice(c + 1).trim()]);
  }
  return rules;
}

/** @param {string} pattern @param {string} pathname */
export function matchPattern(pattern, pathname) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      re += '(.*)';
    } else if (ch === ':' && /[A-Za-z]/.test(pattern[i + 1] || '')) {
      let j = i + 1;
      while (j < pattern.length && /\w/.test(pattern[j])) j++;
      re += '([^/]+)';
      i = j - 1;
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$').test(pathname);
}

/**
 * 某个路径最终拿到的头（小写名字 → 值；同名多次按 CF 规则用 ", " 拼接）。
 * @param {ReturnType<typeof parseHeaders>} rules
 * @param {string} pathname
 * @returns {{headers: Map<string, string>, counts: Map<string, number>}}
 */
export function headersFor(rules, pathname) {
  /** @type {Map<string, string[]>} */
  const acc = new Map();
  for (const r of rules) {
    if (!matchPattern(r.pattern, pathname)) continue;
    for (const [k, v] of r.set) {
      const key = k.toLowerCase();
      if (!acc.has(key)) acc.set(key, []);
      /** @type {string[]} */ (acc.get(key)).push(v);
    }
  }
  for (const r of rules) {
    if (!matchPattern(r.pattern, pathname)) continue;
    for (const d of r.detach) acc.delete(d);
  }
  const headers = new Map();
  const counts = new Map();
  for (const [k, vs] of acc) {
    headers.set(k, vs.join(', '));
    counts.set(k, vs.length);
  }
  return { headers, counts };
}
