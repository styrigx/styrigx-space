/* @sgx-shell:begin styrigx/styrigx-space@tree:ac554cfd0c49 space/web/shared/shell v78e250b5b44e（space/scripts/blog/sync-shell.mjs 写入，勿手改） */
/* ---- lang-boot.js ---- */
/**
 * @fileoverview 首帧语言跳转（语言清理 2026-11-07：「跟随系统」四站一致）。主站、/blog/、/curio/、/daymark/ 内联同一份：
 * 主站 baseof.html、子站各自 <head> 用 js.Build（iife）把本文件打包后原样内联（共享外壳 gen-shell 生成 lang-boot.js，sync-shell 同步）。
 *
 * 规则（每一页都一样，不只首页）：
 * 1. 偏好 = localStorage sgx-lang：配置里的语言（en / zh …）= 明确选择；'system' = 跟随系统；旧版存的空 / 没有 = 跟随系统（兼容）。
 *    localStorage 没有明确值时再看主站写的 sgx-ui cookie 的 lang（同一规则；cookie 的 'system' / '' / 没有都 = 跟随系统）。
 * 2. 跟随系统 → systemLang()（navigator.languages 里第一个配置过的语言，都没有 = 英文）。
 * 3. 要的语言和本页不同 → location.replace 到同一页的那种语言（保留查询串和 #），不产生历史。
 *    页面声明了自己的语言版本（<meta name="sgx-alt-<语言>" content="…">，博客文章有的只有一种语言）就只去声明过的地址；
 *    声明了但没有那种语言 → 不跳。没声明 → 按 lang-path.js 的 langSwitch 拼。
 * 4. 爬虫不跳。
 * 5. 跳之前把这次打开的来源记进 sessionStorage sgx-lang-hop（{go, ref}）：跳过去那份文档的 referrer 变成本页（同源），
 *    主站 navhistory.js 读它还原「直接打开子页」（只认跳到的那个地址，用一次就删），返回一次回主页的行为不变。
 *
 * 同时挂 window.SgxLang（lang-path.js 的函数），给页面里其他经典脚本用。
 */
import { pathLang, stripLang, langPath, langSwitch, systemLang, langs, isLang } from './lang-path.js';

/** 爬虫 UA（和子站原来的一致） */
export const BOT_RE = /bot|crawl|spider|slurp|mediapartners|baidu|bingpreview|facebookexternalhit|twitterbot|linkedinbot|embedly|quora|pinterest|slackbot|discordbot|telegrambot|whatsapp|applebot|duckduckbot|yandex|sogou|exabot|semrush|ahrefs/i;

/**
 * sgx-ui cookie 里的 lang 原始值（不校验版本以外的东西；版本不认识 = 没有）。
 * @param {string} cookieHeader
 * @returns {string}
 */
export function cookieLangRaw(cookieHeader) {
  try {
    const m = String(cookieHeader || '').match(/(?:^|;\s*)sgx-ui=([^;]*)/);
    if (!m) return '';
    let s = decodeURIComponent(m[1]);
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const txt = typeof atob === 'function' ? atob(s) : '';
    let json = txt;
    try { json = decodeURIComponent(escape(txt)); } catch (e) {}
    const o = JSON.parse(json);
    if (!o || (o.v !== 1 && o.v !== 2)) return '';
    return typeof o.lang === 'string' ? o.lang : '';
  } catch (e) {
    return '';
  }
}

/**
 * 语言偏好：配置里的语言 = 明确选择；其余（'system'、旧版的空、没有、不认识）= 'system'。
 * @param {string|null|undefined} stored localStorage sgx-lang
 * @param {string} [cookieLang] sgx-ui cookie 的 lang
 * @returns {string}
 */
export function readLangPref(stored, cookieLang) {
  if (isLang(stored)) return /** @type {string} */ (stored);
  if (stored === 'system') return 'system';
  if (isLang(cookieLang)) return /** @type {string} */ (cookieLang);
  return 'system';
}

/**
 * 首帧要跳去的地址；不跳 → ''。
 * @param {{ pref: string, nav?: any, loc: { pathname: string, search?: string, hash?: string }, alt?: (lang: string) => (string|null), declared?: boolean, ua?: string }} o
 *   alt：页面声明的某语言版本地址；declared：页面有没有声明语言版本
 */
export function langBootTarget(o) {
  if (o.ua && BOT_RE.test(o.ua)) return '';
  const want = o.pref === 'system' ? systemLang(o.nav) : o.pref;
  if (!isLang(want)) return '';
  const p = o.loc.pathname || '/';
  if (pathLang(p) === want) return '';
  if (o.declared) {
    const href = o.alt ? o.alt(want) : null;
    if (!href || href === p) return '';
    return href + (o.loc.hash || '');
  }
  return langSwitch(want, o.loc);
}

/**
 * 在真实页面上执行（内联首帧）。返回要去的地址（已经 replace）或 ''。
 * @param {any} w window
 */
export function bootLang(w) {
  const d = w.document;
  let stored = null;
  try { stored = w.localStorage.getItem('sgx-lang'); } catch (e) {}
  const pref = readLangPref(stored, cookieLangRaw(d.cookie));
  const metas = d.querySelectorAll ? d.querySelectorAll('meta[name^="sgx-alt-"]') : [];
  const go = langBootTarget({
    pref,
    nav: w.navigator,
    loc: w.location,
    ua: (w.navigator && w.navigator.userAgent) || '',
    declared: metas.length > 0,
    alt: function (lang) {
      const m = d.querySelector('meta[name="sgx-alt-' + lang + '"]');
      return m ? m.getAttribute('content') : null;
    },
  });
  if (go) {
    w.__sgxLangGo = 1;
    try { w.sessionStorage.setItem('sgx-lang-hop', JSON.stringify({ go: go, ref: d.referrer || '' })); } catch (e) {}
    w.location.replace(go);
  }
  return go;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !(/** @type {any} */ (window)).__sgxLangBoot) {
  const w = /** @type {any} */ (window);
  w.__sgxLangBoot = 1;
  w.SgxLang = { pathLang, stripLang, langPath, langSwitch, systemLang, langs, isLang, readLangPref };
  try { bootLang(w); } catch (e) {}
}
/* @sgx-shell:end */
