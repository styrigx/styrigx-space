/**
 * ?return= 回跳：校验（safeReturn）和「解锁后去哪」（resolveReturn）的唯一实现。
 * 首页 302（_middleware.js）和 /api/lock-session-check 共用；前端不做白名单，只照着跳。
 * 管理员专属页（锁屏凭证页）的路径表也在这里，middleware 的访客 302 用同一份。
 */
import { ROLE_VISITOR } from './lock-session.js';

/* 访客可进安全与隐私总览页（/settings/security/）；锁屏凭证页要 admin 会话。 */
export const ADMIN_ONLY_PATHS = Object.freeze([
  '/settings/security/lock/',
  '/en/settings/security/lock/',
]);

/** @param {string} pathname */
export function isAdminOnlyPath(pathname) {
  return ADMIN_ONLY_PATHS.some(p => pathname === p || pathname.startsWith(p));
}

const MAIN_ORIGIN = 'https://styrigx.com';
/* 已下线的子站：不再作为回跳目标 */
const RETIRED_RETURN_HOSTS = new Set(['book.styrigx.com', 'book-preview.styrigx.com']);
const UNSAFE_RETURN_RE = /[\u0000-\u001f\u007f\\]/;

/**
 * ?return= 回跳目标的唯一校验（首页 302 和 /api/lock-session-check 共用，经 resolveReturn）：
 * 先再解码一层，原值与解码值里有控制字符（含 Tab/CR/LF）或反斜杠一律不认（浏览器会丢掉
 * Tab/换行、把 \ 当 /，/%09/evil.com 这类会变成协议相对地址跳出本站）。
 * - 站内路径：必须以单个 / 开头（不是 //，解码后也不是），按 https://styrigx.com 解析后仍同源，
 *   返回规范化的 pathname+search+hash；/lock/ 登录后无页面，不认（回首页）
 * - 跨站：只认 https://*.styrigx.com（含 apex），不带用户名密码，已下线的子站不认；返回规范化的 href
 * 不合法返回 null（调用方回首页）。
 * @param {unknown} ret 已经过一次 URL 解码的 return 参数
 * @returns {string|null}
 */
export function safeReturn(ret) {
  if (typeof ret !== 'string' || ret.length === 0) return null;
  let dec;
  try {
    dec = decodeURIComponent(ret);
  } catch (e) {
    return null;
  }
  if (UNSAFE_RETURN_RE.test(ret) || UNSAFE_RETURN_RE.test(dec)) return null;
  let u;
  if (ret.startsWith('https://')) {
    try {
      u = new URL(ret);
    } catch (e) {
      return null;
    }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    const host = u.hostname.toLowerCase();
    if (host !== 'styrigx.com' && !host.endsWith('.styrigx.com')) return null;
    if (RETIRED_RETURN_HOSTS.has(host)) return null;
    return u.href;
  }
  if (ret.charAt(0) !== '/' || ret.charAt(1) === '/' || dec.charAt(1) === '/') return null;
  try {
    u = new URL(ret, MAIN_ORIGIN);
  } catch (e) {
    return null;
  }
  if (u.origin !== MAIN_ORIGIN) return null;
  if (u.pathname === '/lock/') return null;
  return u.pathname + u.search + u.hash;
}

/**
 * 解锁后去哪（唯一实现；首页 302 和 /api/lock-session-check?return= 共用，前端不做白名单）。
 * - return 不合法 → 首页
 * - 已登录用户 return 指向门内页（锁屏凭证页）→ 安全与隐私总览（定稿 #1）
 * - 访客 + 管理员专属 return → upgrade（不跳；就地管理员验证）
 * @param {string} ret 原始 return 参数
 * @param {string|null} role 'admin'|'visitor'
 * @returns {{location:string, upgrade:boolean}}
 */
export function resolveReturn(ret, role) {
  const isVisitor = role === ROLE_VISITOR;
  let safeLoc = safeReturn(ret) || '/';
  let locPath = '';
  try {
    const u = new URL(safeLoc, 'https://styrigx.com');
    locPath = u.hostname === 'styrigx.com' ? u.pathname : '';
  } catch (e) {
    locPath = '';
  }
  if (locPath && isAdminOnlyPath(locPath) && !isVisitor) {
    safeLoc = locPath.startsWith('/en/') ? '/en/settings/security/' : '/settings/security/';
    locPath = safeLoc;
  }
  const isAdminReturn = locPath ? isAdminOnlyPath(locPath) : false;
  return { location: safeLoc, upgrade: isVisitor && isAdminReturn };
}
