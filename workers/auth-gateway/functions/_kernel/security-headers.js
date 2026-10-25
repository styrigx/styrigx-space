/**
 * @fileoverview 安全响应头（纵深防御）的唯一定义处。
 *
 * 谁在用：
 * - 网关（src/index.js）：主站 styrigx.com 经过网关的每个响应（页面、锁屏首页、302、/api/*）→ applyMainSiteHeaders
 *   子站（blog / daymark / curio）经过网关的响应 → applySubsiteHeaders（只加 HSTS，见下）
 * - 账号 Worker、分享短链 Worker（styrigx.com 上更具体的路由）→ applyMainSiteHeaders
 * - Pages 静态文件：web/static/_headers 里 @gen-security-headers 那一段由 scripts/gen-csp.mjs 按本文件生成（--check 防漂移）
 * - Pages 的 web/static/_worker.js（*.pages.dev → 301）不能 import，自己抄了一份常量，单测核对和这里一致
 *
 * 强制的 CSP（Content-Security-Policy）只放「不可能弄坏脚本」的指令：
 *   frame-ancestors 'none'（防点击劫持）、object-src 'none'、base-uri 'self'、form-action 'self'。
 *   全站唯一的 <form> 是聊天输入框（JS 接管提交，没有 action，退化提交也是同源），锁屏 / 解锁 / 通行密钥都不走表单提交。
 *   强制策略里绝不出现 script-src / style-src / default-src 等：一旦写错，锁屏、解锁、通行密钥脚本被拦，管理员会被锁在自己的站外。
 * script-src / style-src / connect-src / img-src 等先放 Content-Security-Policy-Report-Only：只在浏览器控制台报，不拦。
 *   内联脚本的 sha256 由 scripts/gen-csp.mjs 从生产构建（hugo --minify -s web）算出，写进 csp-hashes.js；CI 里 --check。
 *   style-src 暂时 'unsafe-inline'：模板里有几十个 style="" 属性、首屏主题色 <style> 是脚本动态插的，不在这次改。
 * 子站内容（网关代理的 blog / daymark / curio 页面）不套主站的 CSP：三个子站的脚本、外链各不相同，要各自审计后再加。
 *
 * HSTS：max-age=31536000，不带 includeSubDomains、不 preload。
 *   仓库里出现过的 *.styrigx.com 主机不止网关管的几个（muse-invite、mihomo-mrs、proxy-rules、blog-preview，
 *   以及已下线的 book / book-preview），没法从仓库确认它们都只走 HTTPS；includeSubDomains 一旦发出去一年内收不回来。
 */
import { INLINE_SCRIPT_HASHES } from './csp-hashes.js';

export const HSTS = 'max-age=31536000';
export const REFERRER_POLICY = 'strict-origin-when-cross-origin';
export const X_FRAME_OPTIONS = 'DENY';
export const NOSNIFF = 'nosniff';
/* 只关掉本站从来不用的能力。navigator.geolocation（天气定位）、WebAuthn（publickey-credentials-*）、剪贴板、分享保持默认（同源可用），
   不写进来，避免将来改错把通行密钥关掉。 */
export const PERMISSIONS_POLICY = 'camera=(), microphone=(), payment=(), usb=(), serial=(), hid=(), midi=(), display-capture=()';

/** 强制执行的 CSP：不含任何 script / style / default 指令（单测检查） */
export const CSP_ENFORCED = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";

/** 主站页面会连的外部地址（connect-src）：天气（open-meteo 预报 + 城市解析）、日刻 · 今日一句 */
export const CONNECT_EXTERNAL = [
  'https://api.open-meteo.com',
  'https://geocoding-api.open-meteo.com',
  'https://daymark.styrigx.com',
];

/** 只报告、不拦截的完整 CSP（主站） */
export const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' " + INLINE_SCRIPT_HASHES.map((h) => "'" + h + "'").join(' '),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  'connect-src ' + ["'self'"].concat(CONNECT_EXTERNAL).join(' '),
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * 主站的全部安全头（名字 → 值）。顺序即 _headers 里的顺序。
 * @returns {Array<[string, string]>}
 */
export function mainSiteHeaderList() {
  return [
    ['Strict-Transport-Security', HSTS],
    ['X-Content-Type-Options', NOSNIFF],
    ['X-Frame-Options', X_FRAME_OPTIONS],
    ['Referrer-Policy', REFERRER_POLICY],
    ['Permissions-Policy', PERMISSIONS_POLICY],
    ['Content-Security-Policy', CSP_ENFORCED],
    ['Content-Security-Policy-Report-Only', CSP_REPORT_ONLY],
  ];
}

/* 已经自己定过、比默认更严的头不覆盖：分享短链 /s/<码> 用 Referrer-Policy: no-referrer（码不能出现在 Referer 里） */
const KEEP_IF_PRESENT = new Set(['referrer-policy']);

/**
 * 复制一份响应再改头（Response.redirect() / fetch 回来的响应头是只读的）。
 * @param {Response} res
 */
function mutable(res) {
  return new Response(res.body, res);
}

/**
 * 给主站响应加安全头（页面、跳转、接口都加；CSP 对 JSON / 图片 / 空 body 的跳转没有副作用）。
 * @param {Response} res
 * @returns {Response}
 */
export function applyMainSiteHeaders(res) {
  if (!res) return res;
  const out = mutable(res);
  for (const [k, v] of mainSiteHeaderList()) {
    if (KEEP_IF_PRESENT.has(k.toLowerCase()) && out.headers.has(k)) continue;
    out.headers.set(k, v);
  }
  return out;
}

/**
 * 子站（网关代理的 blog / daymark / curio）响应：只加 HSTS（只对该主机生效，不带 includeSubDomains）。
 * 不加 CSP / X-Frame-Options / Permissions-Policy / nosniff：子站内容各自审计后再定（见文件头）。
 * @param {Response} res
 * @returns {Response}
 */
export function applySubsiteHeaders(res) {
  if (!res) return res;
  const out = mutable(res);
  out.headers.set('Strict-Transport-Security', HSTS);
  return out;
}
