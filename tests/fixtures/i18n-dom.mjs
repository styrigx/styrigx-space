// Node 单测用的页面字符串表（语言包化 2026-11-07）：lib/i18n.js 的 i18nTable / pageLang 读 document 上的
// <script id="sgx-i18n-<表>"> 和 <html lang>；单测没有 DOM，这里按 strings.mjs（与 partials/sgx-tr.html 同一规则：英文打底、缺键回退英文）
// 给出页面实际会拿到的扁平字典。
// 用法：installI18nDom('zh')（没有 document 就建一个最小桩；已有桩就只补 getElementById 和 lang），之后 setI18nLang('en') 换语言。
import { strings } from './strings.mjs';

/** @type {Record<string, Record<string, any>>} */
const cache = {};
let site = 'space';

/** @param {string} lang */
function tables(lang) {
  const k = site + ':' + lang;
  if (!cache[k]) {
    const t = strings(site, lang);
    cache[k] = { ...(t.js || {}), shell: t.shell || {} };
  }
  return cache[k];
}

/**
 * @param {string} [lang] 页面语言，默认 en
 * @param {{ site?: string }} [opts]
 */
export function installI18nDom(lang = 'en', opts = {}) {
  site = opts.site || 'space';
  const g = /** @type {any} */ (globalThis);
  if (!g.document) g.document = {};
  const doc = g.document;
  if (!doc.documentElement) doc.documentElement = { lang };
  doc.documentElement.lang = lang;
  const prev = typeof doc.getElementById === 'function' ? doc.getElementById.bind(doc) : null;
  doc.getElementById = function (/** @type {string} */ id) {
    const m = /^sgx-i18n-(.+)$/.exec(id);
    if (m) {
      const t = tables(doc.documentElement.lang || 'en')[m[1]];
      if (t) return { textContent: JSON.stringify(t) };
    }
    return prev ? prev(id) : null;
  };
  return doc;
}

/** @param {string} lang */
export function setI18nLang(lang) {
  installI18nDom(lang, { site });
}
