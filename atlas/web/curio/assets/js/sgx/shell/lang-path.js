/* @sgx-shell:begin styrigx/styrigx-space@tree:3cd80b385c27 space/web/shared/shell v30d425ac5d63（space/scripts/curio/sync-shell.mjs 写入，勿手改） */
/* ---- lang-path.js ---- */
/**
 * @fileoverview 语言路径（P4-3 PR-4c，§6.8）：四站英文是默认语言、不带前缀，中文统一加 /zh/。这是拼 / 拆语言前缀的唯一函数。
 *
 * - 主站：英文 /security/lock/ ↔ 中文 /zh/security/lock/；根 / ↔ /zh/。
 * - 子站（/blog/、/curio/、/daymark/）：前缀加在站名后面：/blog/post/x/ ↔ /blog/zh/post/x/。
 * - 旧的 /en/… 不再是语言前缀（删除不 301），这里不认它：/en/x/ 就是一条普通路径（线上 404）。
 * - 路径段中英两版完全相同、全是英文，中文只多一个 /zh/。
 *
 * 纯函数，无依赖、不碰 DOM：主站 ES 模块直接 import；共享外壳原样复制成 lang-path.js 给三个子站 import；
 * 主站 baseof.html 的首帧语言跳转经 js/lang-path-inline.js 打成 IIFE 内联（挂 window.SgxLang），同一份规则。
 */

/** 默认语言（不带前缀） */
export const DEFAULT_LANG = 'en';
/** 带前缀的语言 */
export const PREFIXED_LANG = 'zh';
/** 子站站名：语言前缀加在 /<站>/ 后面 */
export const SUBSITES = ['blog', 'curio', 'daymark'];

const SITE_RE = new RegExp('^/(' + SUBSITES.join('|') + ')(?=/|$)');
const ZH_RE = /^\/zh(?=\/|$)/;

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
 * 路径的语言：站内剩余部分以 /zh/（或就是 /zh）开头 = 'zh'，其余都是 'en'。
 * @param {string} path location.pathname 这类以 / 开头的路径
 * @returns {'zh'|'en'}
 */
export function pathLang(path) {
  return ZH_RE.test(split(path).rest) ? 'zh' : 'en';
}

/**
 * 去掉语言前缀，得到英文（默认语言）地址。
 * @param {string} path
 * @returns {string}
 */
export function stripLang(path) {
  const { site, rest } = split(path);
  const r = rest.replace(ZH_RE, '') || '/';
  return site + (r.charAt(0) === '/' ? r : '/' + r);
}

/**
 * 同一页在某语言下的地址。英文 = 去掉前缀；中文 = 站前缀后面加 /zh。
 * langPath('/account/', 'zh') → '/zh/account/'；langPath('/blog/post/x/', 'zh') → '/blog/zh/post/x/'；
 * langPath('/zh/account/', 'en') → '/account/'。
 * @param {string} path
 * @param {string} lang 'zh' 之外一律按英文
 * @returns {string}
 */
export function langPath(path, lang) {
  const en = stripLang(path);
  if (lang !== PREFIXED_LANG) return en;
  const { site, rest } = split(en);
  return site + '/zh' + rest;
}

/**
 * 换语言要去的地址（保留查询串和 #）；want 不是 zh / en 或和当前页语言相同 → ''（不用跳）。
 * @param {string} want
 * @param {{ pathname: string, search?: string, hash?: string }} loc
 * @returns {string}
 */
export function langSwitch(want, loc) {
  if (want !== 'zh' && want !== 'en') return '';
  const p = loc.pathname || '/';
  if (pathLang(p) === want) return '';
  return langPath(p, want) + (loc.search || '') + (loc.hash || '');
}

/**
 * 浏览器语言 → 'zh' | 'en'（「跟随系统」用）：zh 开头 = 中文，其余英文；取不到按默认语言。
 * @param {{ language?: string, userLanguage?: string }} [nav]
 * @returns {'zh'|'en'}
 */
export function systemLang(nav) {
  try {
    const n = nav || /** @type {any} */ (typeof navigator !== 'undefined' ? navigator : {});
    const bl = String(n.language || n.userLanguage || DEFAULT_LANG).toLowerCase();
    return bl.indexOf('zh') === 0 ? 'zh' : 'en';
  } catch (e) {
    return 'en';
  }
}
/* @sgx-shell:end */
