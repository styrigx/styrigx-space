/**
 * 账号云同步：设置项（外观 / 时区天气 / 搜索引擎 / Good Lock 等）跨设备同步。
 *
 * 只有登录了账号（sgx-account）的站长能用：先要 owner lock 会话（前置条件），再要账号会话；
 * 访客 / 没登录账号一律 401，前端停在「只存本机」。
 *
 * 存储：KV account-prefs = { items: { <localStorage key>: { v: string|null, t: 毫秒 } }, updatedAt }
 * - 逐项「新的赢」：t 更大的覆盖；v=null 表示这一项被恢复默认（本地删了 key）
 * - 只收 sgx- 开头的 key（前端 lib/cloud-sync.js 的白名单决定同步哪些，锁屏 / 凭证类从来不在里面）
 * - 每次最多 80 项、值最长 600 字符；t 不能比服务器时间快 1 分钟以上（防坏时钟把别的设备永久压住）
 *
 * GET  /api/prefs → { ok, items, updatedAt }
 * POST /api/prefs { changes: { key: { v, t } } } → 合并后 { ok, items, updatedAt }（只接受同源）
 */
import { verifyAccountCookie } from '../_kernel/account-session.js';
import { ROLE_OWNER } from '../_kernel/session.js';
import { isSameOrigin, originDenied } from '../_kernel/http.js';
import { verifySessionDetailed } from '../_middleware.js';

export const PREFS_KEY = 'account-prefs';
const KEY_RE = /^sgx-[a-z0-9-]{1,48}$/;
const MAX_ITEMS = 80;
const MAX_VALUE = 600;
const SKEW_MS = 60 * 1000;


/**
 * 云同步存在账号资料库 styrigx-account（ACCOUNT_KV，2026-10-22 分库）；没绑时退回 OWNER_KV（本地 / 旧预览）。
 * @param {any} env
 */
function prefsKv(env) {
  return (env && (env.ACCOUNT_KV || env.OWNER_KV)) || null;
}

/** @param {object} body @param {number} [status] */
function json(body, status) {
  return Response.json(body, { status: status || 200, headers: { 'Cache-Control': 'no-store' } });
}

/** owner lock 会话 + 账号会话；不满足返回错误响应 @param {any} request @param {any} env */
async function gate(request, env) {
  const sess = await verifySessionDetailed(request, env);
  if (!sess.ok || sess.role !== ROLE_OWNER) return json({ ok: false, error: 'session' }, 401);
  const acc = await verifyAccountCookie(request, env);
  if (!acc.ok) return json({ ok: false, error: 'account', reason: acc.reason }, 401);
  if (!prefsKv(env)) return json({ ok: false, error: 'config' }, 500);
  return null;
}

/** @param {any} kv */
async function readPrefs(kv) {
  const rec = await kv.get(PREFS_KEY, 'json');
  if (!rec || typeof rec !== 'object' || !rec.items || typeof rec.items !== 'object') return { items: {}, updatedAt: 0 };
  return { items: rec.items, updatedAt: rec.updatedAt || 0 };
}

/**
 * 清洗客户端发来的改动；不合法的项直接丢掉（不整单拒绝）。
 * @param {any} changes
 * @param {number} now
 * @returns {Record<string, {v:string|null, t:number}>}
 */
export function cleanChanges(changes, now) {
  /** @type {Record<string, {v:string|null, t:number}>} */
  const out = {};
  if (!changes || typeof changes !== 'object') return out;
  let n = 0;
  for (const k of Object.keys(changes)) {
    if (n >= MAX_ITEMS) break;
    if (!KEY_RE.test(k)) continue;
    const c = changes[k];
    if (!c || typeof c !== 'object') continue;
    const t = Number(c.t);
    if (!Number.isFinite(t) || t <= 0 || t > now + SKEW_MS) continue;
    let v = c.v;
    if (v !== null && typeof v !== 'string') continue;
    if (typeof v === 'string' && v.length > MAX_VALUE) continue;
    out[k] = { v: v, t: Math.floor(t) };
    n++;
  }
  return out;
}

/**
 * 逐项合并：t 更大的赢（相等不动）。
 * @param {Record<string, {v:string|null, t:number}>} items
 * @param {Record<string, {v:string|null, t:number}>} changes
 * @returns {boolean} 是否有改动
 */
export function mergeItems(items, changes) {
  let changed = false;
  for (const k of Object.keys(changes)) {
    const cur = items[k];
    if (!cur || changes[k].t > (cur.t || 0)) {
      items[k] = changes[k];
      changed = true;
    }
  }
  return changed;
}

/** @param {any} context */
export async function onRequestGet(context) {
  try {
    const { request, env } = context;
    const g = await gate(request, env);
    if (g) return g;
    let p;
    try { p = await readPrefs(prefsKv(env)); } catch (e) { return json({ ok: false, error: 'server' }, 503); }
    return json({ ok: true, items: p.items, updatedAt: p.updatedAt });
  } catch (e) {
    return json({ ok: false, error: 'server' }, 500);
  }
}

/** @param {any} context */
export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
    if (!isSameOrigin(request)) return originDenied();
    const g = await gate(request, env);
    if (g) return g;
    let body;
    try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'body' }, 400); }
    const now = Date.now();
    const changes = cleanChanges(body && body.changes, now);
    const kv = prefsKv(env);
    let p;
    try { p = await readPrefs(kv); } catch (e) { return json({ ok: false, error: 'server' }, 503); }
    const items = Object.assign({}, p.items);
    let updatedAt = p.updatedAt;
    if (mergeItems(items, changes)) {
      if (Object.keys(items).length > MAX_ITEMS * 2) return json({ ok: false, error: 'too-large' }, 413);
      updatedAt = now;
      try { await kv.put(PREFS_KEY, JSON.stringify({ items: items, updatedAt: updatedAt })); } catch (e) {
        return json({ ok: false, error: 'server' }, 503);
      }
    }
    return json({ ok: true, items: items, updatedAt: updatedAt });
  } catch (e) {
    return json({ ok: false, error: 'server' }, 500);
  }
}
