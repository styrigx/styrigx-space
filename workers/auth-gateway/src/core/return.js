/**
 * ?return= 回跳：校验（safeReturn）和「解锁后去哪」（resolveReturn）的唯一实现。
 * 首页 302（gate.js）和 /api/lock-session-check 共用；前端不做白名单，只照着跳。
 * 进门二值（P2-3）：页面只分「要进门 / 公开」，解锁后回到原页；门内页（锁屏凭证页等）由页面自己要锁侧复验。
 */

const MAIN_ORIGIN = 'https://styrigx.com';
/* 已下线的子站：不再作为回跳目标（blog / curio / daymark 2026-11-02 并入图志 atlas.styrigx.com；合并 PR3 起三站在 styrigx.com/<站>/，
   atlas.styrigx.com 只剩 301，同样不认） */
const RETIRED_RETURN_HOSTS = new Set(['book.styrigx.com', 'book-preview.styrigx.com', 'blog.styrigx.com', 'curio.styrigx.com', 'daymark.styrigx.com', 'atlas.styrigx.com']);
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
 * 只做地址白名单（safeReturn）：合法 → 原地址；不合法 → 首页。不看进门方式（方案 3.2）。
 * @param {string} ret 原始 return 参数
 * @returns {string}
 */
export function resolveReturn(ret) {
  return safeReturn(ret) || '/';
}
