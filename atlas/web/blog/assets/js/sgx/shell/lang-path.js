/* @sgx-shell:begin styrigx/styrigx-space@tree:2febb3997635 space/web/shared/shell v7cce785f2ada（space/scripts/blog/sync-shell.mjs 写入，勿手改） */
/* ---- lang-path.js ---- */
/**
 * @fileoverview 语言路径（P4-3 PR-4c，§6.8；语言包化 2026-11-07）：四站英文是默认语言、不带前缀，其他语言统一加 /<语言>/（现在只有 /zh/）。
 * 这是拼 / 拆语言前缀的唯一函数。
 *
 * - 主站：英文 /security/lock/ ↔ 中文 /zh/security/lock/；根 / ↔ /zh/。
 * - 子站（/blog/、/curio/、/daymark/）：前缀加在站名后面：/blog/post/x/ ↔ /blog/zh/post/x/。
 * - 旧的 /en/… 不再是语言前缀（删除不 301），这里不认它：/en/x/ 就是一条普通路径（线上 404）。
 * - 路径段各语言完全相同、全是英文，非默认语言只多一个 /<语言>/。
 *
 * 语言列表不写死在这里：来自各站 hugo.yaml 的 languages（模板把它写进 <html data-sgx-langs="en zh">，第一项是默认语言）。
 * 加一种语言 = 各站 hugo.yaml 加一项 + 放字符串文件，这里不用改。没有 DOM 的环境（单测、构建脚本）用 FALLBACK_LANGS，
 * 或调 setLangs() 显式给。
 *
 * 纯函数，无依赖：主站 ES 模块直接 import；共享外壳原样复制成 lang-path.js 给三个子站 import；
 * 首帧语言跳转（lang-boot.js，四站同一份）把它打进 IIFE 内联进 <head>（挂 window.SgxLang）。
 */

/** 默认语言（源文本，不带前缀） */
export const DEFAULT_LANG = 'en';
/** 读不到页面配置时的语言列表（单测 / 构建脚本用；页面上以 <html data-sgx-langs> 为准） */
export const FALLBACK_LANGS = Object.freeze(['en', 'zh']);
/** 子站站名：语言前缀加在 /<站>/ 后面 */
export const SUBSITES = ['blog', 'curio', 'daymark'];

const SITE_RE = new RegExp('^/(' + SUBSITES.join('|') + ')(?=/|$)');
const CODE_RE = /^[a-z]{2,3}$/;

/** @type {string[]|null} */
let explicit = null;

/**
 * 显式设定语言列表（第一项之外的都是带前缀的语言；默认语言总在列表里）。传 null 恢复成读页面配置。
 * @param {string[]|null} list
 */
export function setLangs(list) {
  explicit = list ? normList(list) : null;
}

/** @param {any} list */
function normList(list) {
  /** @type {string[]} */
  const out = [DEFAULT_LANG];
  for (const l of list || []) {
    const v = String(l || '').toLowerCase();
    if (CODE_RE.test(v) && out.indexOf(v) < 0) out.push(v);
  }
  return out;
}

/**
 * 当前配置的语言列表（默认语言在第一位）。
 * @returns {string[]}
 */
export function langs() {
  if (explicit) return explicit;
  try {
    const d = typeof document !== 'undefined' ? document.documentElement : null;
    const a = d && d.getAttribute ? d.getAttribute('data-sgx-langs') : '';
    if (a) return normList(a.split(/[\s,]+/));
  } catch (e) {}
  return FALLBACK_LANGS.slice();
}

/** 带前缀的语言（默认语言之外的） */
export function prefixedLangs() {
  return langs().filter(function (l) { return l !== DEFAULT_LANG; });
}

/**
 * 是不是配置里的语言。
 * @param {any} v
 */
export function isLang(v) {
  return typeof v === 'string' && langs().indexOf(v) >= 0;
}

function prefixRe() {
  const p = prefixedLangs();
  return p.length ? new RegExp('^/(' + p.join('|') + ')(?=/|$)') : null;
}

/**
 * 把站内路径拆成站前缀（'' 或 '/blog' 这类）和站内剩余部分（以 / 开头）。
 * @param {string} path
 * @returns {{ site: string, rest: string }}
 */
function split(path) {
  const p = String(path || '/');
  const m = p.match(SITE_RE);
  const site = m ? m[0] : '';
  const rest = p.slice(site.length) || '/';
  return { site, rest: rest.charAt(0) === '/' ? rest : '/' + rest };
}

/**
 * 路径的语言：站内剩余部分以 /<带前缀的语言>/（或就是 /<语言>）开头 = 那种语言，其余都是默认语言。
 * @param {string} path location.pathname 这类以 / 开头的路径
 * @returns {string}
 */
export function pathLang(path) {
  const re = prefixRe();
  const m = re ? split(path).rest.match(re) : null;
  return m ? m[1] : DEFAULT_LANG;
}

/**
 * 去掉语言前缀，得到默认语言（英文）地址。
 * @param {string} path
 * @returns {string}
 */
export function stripLang(path) {
  const { site, rest } = split(path);
  const re = prefixRe();
  const r = (re ? rest.replace(re, '') : rest) || '/';
  return site + (r.charAt(0) === '/' ? r : '/' + r);
}

/**
 * 同一页在某语言下的地址。默认语言 = 去掉前缀；其他语言 = 站前缀后面加 /<语言>。
 * langPath('/account/', 'zh') → '/zh/account/'；langPath('/blog/post/x/', 'zh') → '/blog/zh/post/x/'；
 * langPath('/zh/account/', 'en') → '/account/'。不认识的语言按默认语言。
 * @param {string} path
 * @param {string} lang
 * @returns {string}
 */
export function langPath(path, lang) {
  const base = stripLang(path);
  if (lang === DEFAULT_LANG || !isLang(lang)) return base;
  const { site, rest } = split(base);
  return site + '/' + lang + rest;
}

/**
 * 换语言要去的地址（保留查询串和 #）；want 不是配置里的语言或和当前页语言相同 → ''（不用跳）。
 * @param {string} want
 * @param {{ pathname: string, search?: string, hash?: string }} loc
 * @returns {string}
 */
export function langSwitch(want, loc) {
  if (!isLang(want)) return '';
  const p = loc.pathname || '/';
  if (pathLang(p) === want) return '';
  return langPath(p, want) + (loc.search || '') + (loc.hash || '');
}

/**
 * 浏览器语言 → 配置里的语言（「跟随系统」用）：先看 navigator.language，再按 navigator.languages 的顺序，取第一个主语言子标签在列表里的（zh-CN → zh），
 * 都不在就是默认语言（英文）。
 * @param {{ language?: string, userLanguage?: string, languages?: readonly string[] }} [nav]
 * @returns {string}
 */
export function systemLang(nav) {
  try {
    const n = nav || /** @type {any} */ (typeof navigator !== 'undefined' ? navigator : {});
    /* navigator.language（首选）在前，再按 navigator.languages 的顺序 */
    const list = [].concat(n.language || n.userLanguage || [], n.languages && n.languages.length ? Array.from(n.languages) : []);
    for (const raw of list) {
      const base = String(raw || '').toLowerCase().split(/[-_]/)[0];
      if (isLang(base)) return base;
    }
  } catch (e) {}
  return DEFAULT_LANG;
}
/* @sgx-shell:end */
