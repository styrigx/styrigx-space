/**
 * @fileoverview 打开短链：GET / HEAD https://styrigx.com/s/<码>。
 *
 * - 目标可以是主站路径或三个子站的地址（lib/links.js cleanTarget；点开时再验一次，存坏了也只走失败响应）。
 * - 普通短链：302 到目标，不签钥匙、不发会话；没解锁的人到了目标页由网关照常送去锁屏。
 * - 带临时会话：已是站长 → 只 302（不降级）；否则请网关（服务绑定 ISSUER → ShareIssuer.openLinkSession）用这条短链的钥匙
 *   签 visitor 会话 + 钥匙票，Set-Cookie 原样放进这次 302。访客不用在锁屏输入任何东西。
 *   会话只发给发起这次 GET 的浏览器：响应 private, no-store（任何缓存都不能存、不能转给别人）；HEAD 和浏览器预取
 *   （Sec-Purpose / Purpose: prefetch）不发会话——预取直接 503（浏览器丢掉预取、真点开时再走一遍），HEAD 只 302。
 * - 码只出现在 /s/<码> 这一跳：Location 是干净的目标地址（不带码），Referrer-Policy: no-referrer，
 *   所以码不会留在地址栏、历史（最终地址）和下一页的 Referer 里。
 * - 不存在 / 过期 / 作废 / 格式不对 / 目标不合法 / 网关拒签 / 被限速 / 出错：一律同一个响应（302 到 /?lock=1），不说是哪种。
 * - 限速：同一 IP 15 分钟内 10 次打不开 → 锁 15 分钟（期间这个 IP 的 /s/* 一律走失败响应，真码也一样）。
 *   计数在 D1 share_fail，外面再套一层本 isolate 内存计数（锁住期间不再查 / 写 D1）。格式不对的码不写 D1（不可能对得上），只记内存。
 */
import { ROLE_OWNER } from './auth.js';
import { ORIGIN, SQL, isCode, cleanTarget, targetUrl, statusOf, first, run } from './lib/links.js';

const MAX_FAIL = 10;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

/** isolate 内的计数（ip → {count, start, until}），上限 5000 条，满了清空 */
const mem = new Map();
/** 测试用 */
export function _resetMem() { mem.clear(); }

/** @param {string} location @param {string[]} [cookies] */
function redirect(location, cookies) {
  const h = new Headers();
  h.set('Location', location);
  h.set('Cache-Control', 'private, no-store');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('X-Robots-Tag', 'noindex');
  for (const c of cookies || []) h.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers: h });
}

/** 所有失败都是这一个响应 */
export function failResponse() {
  return redirect(ORIGIN + '/?lock=1');
}

/** @param {Request} request */
function isPrefetch(request) {
  const p = ((request.headers.get('Sec-Purpose') || '') + ' ' + (request.headers.get('Purpose') || '') + ' ' + (request.headers.get('X-Moz') || '')).toLowerCase();
  return p.includes('prefetch') || p.includes('prerender');
}

function memLocked(ip, now) {
  const r = mem.get(ip);
  return !!(r && r.until > now);
}

function memFail(ip, now) {
  if (mem.size > 5000) mem.clear();
  let r = mem.get(ip);
  if (!r || r.start + WINDOW_MS < now) r = { count: 0, start: now, until: 0 };
  r.count++;
  if (r.count >= MAX_FAIL) { r.until = now + LOCK_MS; r.count = 0; r.start = now; }
  mem.set(ip, r);
}

async function dbLocked(db, ip, now) {
  const r = await first(db, SQL.failGet, ip);
  if (r && r.locked_until > now) {
    mem.set(ip, { count: 0, start: now, until: r.locked_until });
    return true;
  }
  return false;
}

async function dbFail(db, ip, now) {
  const r = await first(db, SQL.failGet, ip);
  let count = r && r.window_start + WINDOW_MS >= now ? (r.count || 0) : 0;
  let start = r && r.window_start + WINDOW_MS >= now ? r.window_start : now;
  let until = 0;
  count++;
  if (count >= MAX_FAIL) { until = now + LOCK_MS; count = 0; start = now; }
  await run(db, SQL.failPut, ip, count, start, until);
}

/**
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {{ waitUntil(p: Promise<any>): void }} ctx
 * @param {{ session: () => Promise<{ok:boolean, role:string|null}> }} auth
 * @param {string} code
 */
export async function openShare(request, env, ctx, auth, code) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } });
  }
  if (isPrefetch(request)) {
    return new Response(null, { status: 503, headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' } });
  }
  const db = env && env.D1_SHARE_LINK;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  if (!db || memLocked(ip, now)) return failResponse();

  let row = null;
  try {
    if (await dbLocked(db, ip, now)) return failResponse();
    if (!isCode(code)) {
      memFail(ip, now);
      return failResponse();
    }
    row = await first(db, SQL.byCode, code);
    if (!row || statusOf(row, now) !== 'active' || cleanTarget(row.target) === null) {
      memFail(ip, now);
      await dbFail(db, ip, now);
      return failResponse();
    }
  } catch (e) {
    console.error('[sgx-share] open db: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
    return failResponse();
  }

  const dest = targetUrl(/** @type {string} */ (cleanTarget(row.target)));
  const mark = () => {
    try { ctx.waitUntil(run(db, SQL.opened, row.id, Date.now()).catch(() => {})); } catch (e) {}
  };
  if (!row.session_sec || !row.key_id) {
    if (request.method === 'GET') mark();
    return redirect(dest);
  }
  if (request.method === 'HEAD') return redirect(dest);
  const sess = await auth.session();
  if (sess.ok && sess.role === ROLE_OWNER) return redirect(dest);

  const issuer = env && env.ISSUER;
  if (!issuer || typeof issuer.openLinkSession !== 'function') return failResponse();
  let r;
  try {
    r = await issuer.openLinkSession(row.key_id, row.session_sec);
  } catch (e) {
    console.error('[sgx-share] issuer rpc failed: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
    return failResponse();
  }
  if (!r || r.ok !== true || !Array.isArray(r.cookies) || !r.cookies.length) return failResponse();
  mark();
  return redirect(dest, r.cookies.map(String));
}
