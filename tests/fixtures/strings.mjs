// 字符串表测试工具（语言包化 2026-11-07）：读各站 data/i18n/<语言>.yaml（主站；2026-11 合站后奇趣 / 日刻在 data/<站>/i18n/）和共享外壳表（data/sgx-shell-i18n/，四站同一份），
// 和 partials/shell/sgx-tr.html 同一规则：英文表打底，页面语言表覆盖（深合并），缺键回退英文。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** 2026-11 合站：一个 Hugo 站 space/web/；站内表 = data/i18n（主站）或 data/<站>/i18n（子站），外壳表只有 data/sgx-shell-i18n 一份 */
const tableDir = (site, kind) => path.join(REPO, 'space/web/data', kind === 'i18n' && site !== 'space' ? site + '/i18n' : kind);

/** @param {string} p */
const load = (p) => (existsSync(p) ? /** @type {any} */ (yaml.load(readFileSync(p, 'utf8'))) || {} : {});

/** 原始表（不合并）：site = space | curio | daymark；kind = 'i18n'（站内表）| 'sgx-shell-i18n'（外壳表） */
export function rawTable(site, lang, kind = 'i18n') {
  return load(path.join(tableDir(site, kind), lang + '.yaml'));
}

/** 本站有哪些语言的表 */
export function tableLangs(site, kind = 'i18n') {
  const dir = tableDir(site, kind);
  return existsSync(dir) ? readdirSync(dir).filter((f) => /^[a-z]{2,3}\.yaml$/.test(f)).map((f) => f.slice(0, -5)).sort() : [];
}

/** @param {any} a @param {any} b */
export function deepMerge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
  const out = { ...(a && typeof a === 'object' ? a : {}) };
  for (const k of Object.keys(b)) out[k] = deepMerge(out[k], b[k]);
  return out;
}

/** 页面实际拿到的表（同 sgx-tr.html）：站内表在根上，外壳表在 .shell */
export function strings(site, lang) {
  const t = deepMerge(rawTable(site, 'en'), lang === 'en' ? {} : rawTable(site, lang));
  t.shell = deepMerge(rawTable(site, 'en', 'sgx-shell-i18n'), lang === 'en' ? {} : rawTable(site, lang, 'sgx-shell-i18n'));
  return t;
}

/** 主站页面 JS 文案表 js.<name>，旧测试用的 { key: { zh, en } } 形状（每种语言都已回退英文） */
export function jsDict(name, site = 'space') {
  const en = strings(site, 'en').js[name] || {};
  const zh = strings(site, 'zh').js[name] || {};
  /** @type {Record<string, {zh: string, en: string}>} */
  const out = {};
  for (const k of Object.keys(en)) out[k] = { en: en[k], zh: zh[k] };
  return out;
}

/** 扁平键（a.b.c）列表，用来比对各语言键集 */
export function flatKeys(o, pre = '') {
  /** @type {string[]} */
  const out = [];
  for (const [k, v] of Object.entries(o || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flatKeys(v, pre + k + '.'));
    else out.push(pre + k);
  }
  return out;
}
