/**
 * @fileoverview 界面文案（语言包化 2026-11-07）：页面里的 <script id="sgx-i18n-<表>" type="application/json"> 扁平字典 {"key": "文案"}。
 * 字典由模板从字符串表 data/common/i18n/<语言>.yaml 的 js.<表> 输出，已经是「英文表 ← 页面语言表」的合并（partials/common/sgx-tr.html），
 * 所以缺键的语言拿到的是英文；JS 不再认识任何语言，也不按 <html lang> 二选一。加一种语言 = 加一份 yaml，这里不用改。
 * 旧形状 {"key": {"zh": …, "en": …}} 不再支持（模板都已改成扁平字典）。
 */

/**
 * @typedef {Object} I18nDict
 * @property {(key: string) => string} t 取文案（缺失返回 ''）
 * @property {(key: string, vars?: Record<string, string|number>) => string} fmt 带 {name} 占位替换
 */

/** @param {string} id @param {Document} [doc] @returns {Record<string, string>} */
function readDict(id, doc) {
  try {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    const el = d && d.getElementById(id);
    const o = el && el.textContent ? JSON.parse(el.textContent) : null;
    return o && typeof o === 'object' ? o : {};
  } catch (e) {
    return {};
  }
}

/**
 * {name} 占位替换
 * @param {string} s
 * @param {Record<string, string|number>} [vars]
 */
export function fill(s, vars) {
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(String(vars[k]));
  return s;
}

/**
 * 读取页面内指定 id 的文案块（马上读）。
 * @param {string} id script 块的 id（如 'sgx-i18n-core'）
 * @param {Document} [doc]
 * @returns {I18nDict}
 */
export function loadI18n(id, doc) {
  const dict = readDict(id, doc);
  /** @param {string} key */
  function t(key) {
    const v = dict[key];
    return v == null ? '' : String(v);
  }
  /** @param {string} key @param {Record<string, string|number>} [vars] */
  function fmt(key, vars) { return fill(t(key), vars); }
  return { t, fmt };
}

/**
 * 模块级的取文案函数（第一次调用时才读页面，模块可以在 DOM 解析前加载、也能在 Node 单测里 import）。
 * 用法：const tx = i18nTable('core'); tx('lockWelcomeBack')；tx('key', { n: 3 }) 替换 {n}。
 * @param {string} table 表名（页面块 id = sgx-i18n-<table>）
 * @returns {(key: string, vars?: Record<string, string|number>) => string}
 */
export function i18nTable(table) {
  /** @type {Record<string, string>} */
  let dict = {};
  /** @type {string|null} */
  let src = null;
  return function tx(key, vars) {
    /* 每次对一下页面块的原文：页面不变时只是一次字符串比较；单测换了假页面（换语言）也能跟上 */
    let text = '';
    try {
      const el = typeof document !== 'undefined' && document.getElementById ? document.getElementById('sgx-i18n-' + table) : null;
      text = (el && el.textContent) || '';
    } catch (e) {
      text = '';
    }
    if (text !== src) {
      src = text;
      try {
        const o = text ? JSON.parse(text) : null;
        dict = o && typeof o === 'object' ? o : {};
      } catch (e) {
        dict = {};
      }
    }
    const v = dict[key];
    return fill(v == null ? '' : String(v), vars);
  };
}

/** 页面语言代码（<html lang>；没写 = 英文，英文是源语言） @param {Document} [doc] */
export function pageLang(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  return (d && d.documentElement && d.documentElement.lang) || 'en';
}
