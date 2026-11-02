/**
 * @fileoverview 奇趣跟主站语言：读主站写的 sgx-ui cookie（Domain=styrigx.com），语言（lang）和当前页不同就换到另一种语言的同一页。
 * 这里只读不写 cookie。
 *
 * 外观（深浅色、色板、自定义主题色、字号、减弱动效）不在这里：首帧前由主站共享外壳的读端 ui-cookie-read.js 落到 <html>
 * （baseof.html 原样内联，挂 window.SgxUI；ui-inherit-run.js 调 SgxUI.apply）。契约见主站 styrigx-space docs/ui-cookie-contract.md，
 * 夹具 tests/fixtures/ui-cookie-contract.json 由 tests/web/ui-cookie-contract.test.mjs 逐个跑。
 *
 * 语言只认共享读端 SgxUI.read() 校验过的 lang（主站 2026-10-27 起写：用户明确选的 'zh' | 'en'，跟随系统 = '' 不跳）；
 * 版本 v 不认识 / 乱码 / 没有 cookie = 不跳，大写、en-US 之类读端判为 '' 也不跳。不再自己解 cookie 的原始 JSON。
 */

/**
 * cookie 里的语言。
 * @param {any} U 共享读端（window.SgxUI）
 * @param {string} cookieHeader document.cookie
 * @returns {'zh'|'en'|''}
 */
export function cookieLang(U, cookieHeader) {
  const ui = U && typeof U.read === 'function' ? U.read(String(cookieHeader || '')) : null;
  const lang = ui ? ui.lang : '';
  return lang === 'zh' || lang === 'en' ? lang : '';
}

/** 本站在图志（atlas.styrigx.com）下的前缀：中文 /curio/xxx，英文 /curio/en/xxx */
export const BASE = '/curio/';

/**
 * 语言跟主站：want 和本页语言不同时，返回另一种语言的同一页（保留查询串和 #页签）；不用跳返回 ''。
 * 奇趣每页都有中英两版：{base}xxx ↔ {base}en/xxx。不在 base 下的地址不跳。
 * @param {'zh'|'en'|''} want cookieLang() 的结果
 * @param {{pathname: string, search?: string, hash?: string}} loc
 * @param {'zh'|'en'} pageLang
 * @param {string} [base] 本站前缀（以 / 开头和结尾）
 */
export function langTarget(want, loc, pageLang, base = BASE) {
  if ((want !== 'zh' && want !== 'en') || want === pageLang) return '';
  const p = loc.pathname || base;
  if (!p.startsWith(base) && p + '/' !== base) return '';
  const rest = p.slice(base.length);
  const to = want === 'en' ? base + 'en/' + rest : base + rest.replace(/^en(\/|$)/, '');
  return to + (loc.search || '') + (loc.hash || '');
}
