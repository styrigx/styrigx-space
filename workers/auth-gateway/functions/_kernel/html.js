/**
 * 网关改写 HTML：会话标记（data-sgx-lock-session / role / account-session / upgrade）的清理与注入。
 * 主站 middleware（injectSessionState / injectUpgradeState）和子站（src/subsites.js 的 stripSessionAttrs）共用。
 */
import { ROLE_ADMIN, ROLE_VISITOR } from './lock-session.js';

/* 网关自己注入的会话标记（只有这些会被先清掉再重新写）。
   2026-10-21：以前清的是 <html> 上所有 data-sgx-*，把 baseof.html 写的构建标记 data-sgx-build 也一起删了；
   现在只清网关会写的这几种：lock-session / role / account-session / upgrade / upgrade-return。 */
const SESSION_ATTR_RE = /\s+data-sgx-(?:lock-session|role|account-session|upgrade|upgrade-return)="[^"]*"/gi;

/**
 * 去掉 <html> 标签上已有的会话标记（SESSION_ATTR_RE），再由下面重新注入。
 * 页面经网关回源时，Pages 也会注入一次；不去掉就会出现重复属性。
 * 也防止页面源码里混进伪造的会话标记。其他 data-sgx-*（如构建标记 data-sgx-build）原样保留。
 * @param {string} html
 */
export function stripSessionAttrs(html) {
  return html.replace(/<html\b[^>]*>/i, (tag) => tag.replace(SESSION_ATTR_RE, ''));
}

/**
 * L1 向 HTML 注入会话状态（2.4.1 分层规范）。
 * 把 <html> 变成 <html data-sgx-lock-session="valid|locked|lock-reset" data-sgx-role="admin|visitor">，
 * 前端只读这个，不自己猜。
 * 同时设置 Cache-Control: private, no-store（防浏览器缓存绕过锁屏）。
 * 非 HTML 响应原样返回。
 * @param {Response} res
 * @param {'valid'|'locked'|'lock-reset'} state
 * @param {string|null} role 'admin'|'visitor'|null
 */
export async function injectSessionState(res, state, role, account) {
  const ct = res.headers.get('Content-Type') || '';
  if (!ct.includes('text/html')) return res;
  let html = stripSessionAttrs(await res.text());
  /* 2.8.0 锁屏瘦身：锁屏态不下发桌面内容（书单、歌单、小组件等），
     只保留锁屏需要的部分（导航、头像、脚本）。
     重置锁屏票页同样受限（只能管理锁屏凭证），同样瘦身。 */
  if (state === 'locked' || state === 'lock-reset') {
    html = html.replace(/<!-- SGX-DESKTOP-START -->[\s\S]*?<!-- SGX-DESKTOP-END -->/g, '');
  }
  let injected = html.replace(/<html(\s|>)/i, '<html data-sgx-lock-session="' + state + '"$1');
  /* 2026-10-21：账号页首帧就按服务端的账号会话画（in / out），不先画「欢迎回来」再换。
     只是展示提示：账号页的数据和所有操作仍由 /api/account 验签。 */
  if (account === 'in' || account === 'out') {
    injected = injected.replace(/<html(\s|>)/i, '<html data-sgx-account-session="' + account + '"$1');
    if (account === 'in') {
      /* 已登录：登录区（欢迎回来 / 通行密钥登录 / 密码登录）整段不下发，总览首帧就可见 */
      injected = injected.replace(/<!-- SGX-ACCT-LOGIN-START -->[\s\S]*?<!-- SGX-ACCT-LOGIN-END -->/g, '');
      injected = injected.replace(/<div id="acct-main" hidden>/, '<div id="acct-main">');
    } else {
      injected = injected.replace(/<div id="acct-login" class="acct-login" hidden>/, '<div id="acct-login" class="acct-login">');
    }
  }
  /* 2.8.0：注入角色供 UI 展示（UI 不做鉴权） */
  if (role === ROLE_ADMIN || role === ROLE_VISITOR) {
    injected = injected.replace(/<html(\s|>)/i, '<html data-sgx-role="' + role + '"$1');
  }
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'private, no-store');
  /* 2.8.0 搜索收录：锁屏态页面不被搜索引擎收录。重置锁屏票页同样不收录。 */
  if (state === 'locked' || state === 'lock-reset') {
    headers.set('X-Robots-Tag', 'noindex');
  }
  return new Response(injected, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/* 2.9.3：访客 + 管理员专属 return 时，首页返回 200 并标记升级验证。
   前端读 data-sgx-upgrade="1" 和 data-sgx-upgrade-return 打开验证层
   （只显示通行密钥+密码，不显示访客入口，带「需要管理员验证」提示）。
   验证通过后前端跳回 return。绝不 302。 */
export async function injectUpgradeState(res, role, returnPath) {
  const ct = res.headers.get('Content-Type') || '';
  if (!ct.includes('text/html')) return res;
  const html = stripSessionAttrs(await res.text());
  let injected = html.replace(/<html(\s|>)/i, '<html data-sgx-lock-session="valid"$1');
  if (role === ROLE_ADMIN || role === ROLE_VISITOR) {
    injected = injected.replace(/<html(\s|>)/i, '<html data-sgx-role="' + role + '"$1');
  }
  /* 升级标记：前端据此打开验证层 */
  injected = injected.replace(/<html(\s|>)/i,
    '<html data-sgx-upgrade="1" data-sgx-upgrade-return="' + returnPath.replace(/"/g, '&quot;') + '"$1');
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(injected, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
