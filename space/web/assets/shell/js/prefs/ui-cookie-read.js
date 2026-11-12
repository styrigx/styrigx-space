/**
 * @fileoverview sgx-ui cookie 只读解析器（2026-10-22）：子站（博客 / 日刻 / 奇趣）首帧前读主站写的外观，<html> 落到和主站一样的状态。
 *
 * - 主站 lib/ui-cookie.js 写（localStorage 是唯一来源，cookie 只是镜像）；子站只读，永远不写 sgx-ui。
 *   写端也用这里的 NAME / V / FONT_SIZES / PRESETS / encode / decode，两边同一份字段表，不会各说各话。
 * - 经典脚本、ES5、无依赖：子站原样内联进 <head>（共享外壳 space/web/shared/shell/ui-cookie-read.js 就是本文件），
 *   也能被打包器当副作用模块 import。挂在 window.SgxUI 上。
 * - 2026-11-12 调色板 v4：没有深浅模式和自定义主题色了。深浅只由调色板决定（DARK = 深套 id，生成段），不读 prefers-color-scheme；
 *   旧 cookie 里的 mode / accent 字段读到也忽略（v 仍为 2，旧 cookie 照常能读）。
 * - 校验严格：v 只认 1 / 2；pal 必须是已知预设（旧撞色 x<id> 迁到 <id>）。
 *   cookie 缺失 / 乱码 / 版本不认识 → read() 返回 null，apply() 按默认（terra，深套）渲染，绝不抛错、绝不跳转。
 * - apply(root) 落的状态 = 主站 baseof 内联脚本：class dark（= 当前是深套）、data-dark、font-size、data-font-size、
 *   data-palette（默认 terra 不写）、class reduced-motion、data-reduced-motion；顺手清掉旧版自定义色留下的 <style id="sgx-accent-roles"> 和本站缓存。
 *
 * API：
 *   SgxUI.read([cookieString])  → 校验后的对象 {v, pal, fs, rm, lang} 或 null（旧 cookie 的 mode / accent / mat 忽略）
 *       （lang：主站用户明确选的语言代码（en / zh …，小写）；跟随系统 / 旧版的空 / 没有 / 不合法 = 'system'；首帧语言跳转（lang-boot.js）用，apply() 不管它）
 *   SgxUI.isDark(pal)           → 这套调色板是不是深套
 *   SgxUI.paint(pal, [root])    → 只落调色板：data-palette、dark 类 / data-dark、<meta name="color-scheme"> / <meta name="theme-color">（四站切换调色板都走它）
 *   SgxUI.resolve(ui)           → {dark, pal, fs, rm}
 *   SgxUI.apply([root])         → 读 cookie + 落到 root（默认 <html>），返回 resolve 的结果
 *   SgxUI.encode(obj) / SgxUI.decode(str) → base64url(UTF-8 JSON) 编解码（写端共用）
 */
(function (g) {
  'use strict';
  /* @ui-cookie-presets:begin（space/scripts/gen-shell.mjs 按 space/web/data/palette-roles.json + palette-scheme.js 生成，勿手改） */
  var PRESETS = {"cherry":"#86ad3f","tangerine":"#168f9c","terra":"#de7a58","amber":"#b54a88","matcha":"#c46a43","forest":"#f08a3c","teal":"#d6334a","lake":"#f17f72","indigo":"#f2559b","violet":"#d4628f","orchid":"#7a95ab","berry":"#e3a93b","rose":"#f2a86b","graphite":"#4f86b5","dustyrose":"#94a982","coral":"#168f9c","cream":"#168f9c","champagne":"#536dfa","mustard":"#7a95ab","lime":"#536dfa","sage":"#cf9494","aqua":"#f17f72","glacier":"#f17f72","dustyblue":"#d4a72c","lilac":"#168f9c"};
  /* 深套（底色 OKLCH L < 0.6）：dark 类只表示「当前是深套」 */
  var DARK = ["cherry","tangerine","terra","amber","matcha","forest","teal","lake","indigo","violet","orchid","berry","rose","graphite"];
  /* 每套页面底色：<meta name="theme-color"> 用 */
  var BG = {"cherry":"#2d0605","tangerine":"#2d0701","terra":"#161412","amber":"#211200","matcha":"#0b1b00","forest":"#001c0f","teal":"#001b1b","lake":"#01172b","indigo":"#0c1233","violet":"#180e30","orchid":"#270821","berry":"#29061b","rose":"#2b0615","graphite":"#12171b","dustyrose":"#faecec","coral":"#ffebe8","cream":"#f2f0eb","champagne":"#f7efe0","mustard":"#faefd6","lime":"#eef4d9","sage":"#edf2e8","aqua":"#e1f5f2","glacier":"#e0f4fc","dustyblue":"#ebf1f5","lilac":"#f8ebfb"};
  /* @ui-cookie-presets:end */

  var NAME = 'sgx-ui';
  /** 写端当前版本；读端认 VERSIONS 里的（v1 = 只有时钟 / 天气，v2 = B2-7 起加外观），别的一律当没有 cookie */
  var V = 2;
  var VERSIONS = [1, 2];
  var FONT_SIZES = ['standard', 'small', 'large'];
  var DEFAULT_PAL = 'terra';
  /* 旧版自定义主题色留下的东西（2026-11-12 删除），首帧顺手清掉 */
  var OLD_CACHE_KEY = 'sgx-shell-accent-css';
  var OLD_STYLE_ID = 'sgx-accent-roles';

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function inList(a, v) { for (var i = 0; i < a.length; i++) if (a[i] === v) return true; return false; }
  function isObj(v) { return !!v && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]'; }
  /** base64url(UTF-8 JSON) → 对象；失败返回 null */
  function decode(s) {
    if (!s || typeof s !== 'string' || !/^[A-Za-z0-9_\-]+$/.test(s)) return null;
    try {
      var b = s.replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      return JSON.parse(decodeURIComponent(escape(atob(b))));
    } catch (e) {
      return null;
    }
  }

  /** 对象 → base64url(UTF-8 JSON)（中文城市名先转 UTF-8） */
  function encode(o) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /** 从 cookie 串里取 sgx-ui 的原始值；没有返回 '' */
  function raw(cookie) {
    var m = String(cookie == null ? '' : cookie).match(/(?:^|;\s*)sgx-ui=([^;]*)/);
    return m ? m[1] : '';
  }

  /** 色板 id 归一：旧撞色 x<id> → <id>（2026-10-23 PR-G 合并）；不认识 → 默认 */
  function normPal(p) {
    if (typeof p !== 'string') return DEFAULT_PAL;
    if (!has(PRESETS, p) && /^x[a-z]+$/.test(p) && has(PRESETS, p.slice(1))) p = p.slice(1);
    return has(PRESETS, p) ? p : DEFAULT_PAL;
  }

  /** 这套调色板是不是深套（不认识的 id 按默认 terra） */
  function isDark(p) { return inList(DARK, normPal(p)); }

  /** 解码后的对象 → 校验过的对象；不是对象 / 版本不认识返回 null。单个字段不合法就按默认值；旧的 mode / accent / mat 字段忽略。 */
  function normalize(o) {
    if (!isObj(o) || typeof o.v !== 'number' || !inList(VERSIONS, o.v)) return null;
    return {
      v: o.v,
      pal: normPal(o.pal),
      fs: inList(FONT_SIZES, o.fs) ? o.fs : 'standard',
      rm: o.rm === 1 ? 1 : 0,
      lang: typeof o.lang === 'string' && /^[a-z]{2,3}$/.test(o.lang) ? o.lang : 'system'
    };
  }

  /** 读 sgx-ui（默认 document.cookie）→ 校验过的对象或 null */
  function read(cookie) {
    if (cookie === undefined) {
      try { cookie = g.document.cookie; } catch (e) { cookie = ''; }
    }
    return normalize(decode(raw(cookie)));
  }

  /** 校验过的对象（或 null）→ 要落的外观（深浅只看调色板） */
  function resolve(ui) {
    var pal = ui ? ui.pal : DEFAULT_PAL;
    return { dark: isDark(pal), pal: pal, fs: ui ? ui.fs : 'standard', rm: !!(ui && ui.rm === 1) };
  }

  function toggle(el, c, on) {
    if (on) el.classList.add(c);
    else el.classList.remove(c);
  }
  function meta(doc, name, v) {
    if (!v || !doc.querySelector) return;
    var m = doc.querySelector('meta[name="' + name + '"]');
    if (m && m.getAttribute('content') !== v) m.setAttribute('content', v);
  }

  /** 落调色板（深浅、浏览器底色跟着本套走） */
  function paint(pal, root) {
    var doc = g.document;
    var d = root || doc.documentElement;
    var p = normPal(pal);
    var dk = isDark(p);
    try {
      if (p !== DEFAULT_PAL) d.setAttribute('data-palette', p);
      else d.removeAttribute('data-palette');
      toggle(d, 'dark', dk);
      d.setAttribute('data-dark', dk ? '1' : '0');
      meta(doc, 'color-scheme', dk ? 'dark' : 'light');
      meta(doc, 'theme-color', BG[p]);
    } catch (e) {}
    return dk;
  }

  /** 读 cookie 落到 root；返回落下的外观 */
  function apply(root) {
    var doc = g.document;
    var d = root || doc.documentElement;
    var a = resolve(read());
    try {
      paint(a.pal, d);
      d.style.fontSize = a.fs === 'large' ? '112.5%' : a.fs === 'small' ? '87.5%' : '';
      d.setAttribute('data-font-size', a.fs);
      d.style.removeProperty('--sgx-seed');
      var old = doc.getElementById(OLD_STYLE_ID);
      if (old) old.parentNode.removeChild(old);
      try { g.localStorage.removeItem(OLD_CACHE_KEY); } catch (e) {}
      toggle(d, 'reduced-motion', a.rm);
      d.setAttribute('data-reduced-motion', a.rm ? '1' : '0');
    } catch (e) {}
    return a;
  }

  g.SgxUI = {
    NAME: NAME,
    V: V,
    VERSIONS: VERSIONS,
    FONT_SIZES: FONT_SIZES,
    PRESETS: PRESETS,
    DARK: DARK,
    DEFAULT_PAL: DEFAULT_PAL,
    normPal: normPal,
    isDark: isDark,
    paint: paint,
    decode: decode,
    encode: encode,
    normalize: normalize,
    read: read,
    resolve: resolve,
    apply: apply
  };
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
