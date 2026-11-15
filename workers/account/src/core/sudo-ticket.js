/**
 * D-3 a′「先验后发票」（偏离稿 v3.12 第 9 节；Gray 2026-11-15 22:50 选 a、22:53 开工）：跨 Worker sudo 的一次性票。
 *
 * - 凭据只进账号 Worker：sudoers 本人在 POST /api/identity（action sudo-grant）验过自己的凭据，这里才发票；
 *   别的 Worker（atlas-core）只拿到票，经 space-core → AccountVerifier.sudoAdmit 交回这里核销。
 * - 票 = 32 字节随机数的 base64url（43 字符）；库里只存它的 SHA-256（十六进制），票本身不落库、不进日志、不进审计。
 * - 票绑 uid + 会话 id + 方法 + 路径 + action，TTL 60 秒，只能用一次：核销是一条
 *   DELETE … WHERE id = ? AND expires_at > ? RETURNING 绑定字段，再逐项比对；并发两次核销只有一次拿到行，
 *   对不上的票同样作废（不给换路径重试）。
 * - 发票时顺手清已过期的行（表很小，不加索引）。
 * - 能发票的目标只认路由表（core/route-access.js）里标了 sudoTicket 的行，且这一档（带 action 的按 action）是 root。
 *
 * 只 import lib/、core/。
 */
import { b64urlEnc } from '../lib/crypto.js';
import { onDb } from '../lib/db.js';
import { ruleOf, levelOf } from './route-access.js';
import { ACCESS } from './groups.js';

/** 票的有效期 */
export const SUDO_TICKET_TTL_MS = 60 * 1000;
/** 票的写法（同会话令牌：43 位 base64url） */
export const SUDO_TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
/** 票能借的方法 */
const METHODS = Object.freeze(['GET', 'POST', 'PUT', 'DELETE']);
/** action 的写法（同路由表 action 名） */
const ACTION_RE = /^[a-z0-9.-]{1,32}$/;

/** @param {string} s */
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 发票目标：{ method, path, action? } → 规范化的目标；路由表没标 sudoTicket、或这一档不是 root → 拒。
 * 路径只认绝对路径、不带查询串与片段（票绑的是路由，不绑参数）。
 * @param {any} cmd
 * @returns {{ok:true, method:string, path:string, action:string}|{ok:false, status:number, error:string}}
 */
export function ticketTarget(cmd) {
  const method = cmd && typeof cmd.method === 'string' ? cmd.method.toUpperCase() : '';
  const raw = cmd && typeof cmd.path === 'string' ? cmd.path : '';
  const action = cmd && typeof cmd.action === 'string' ? cmd.action : '';
  if (METHODS.indexOf(method) === -1) return { ok: false, status: 400, error: 'action' };
  if (!/^\/[A-Za-z0-9/_-]{1,127}$/.test(raw)) return { ok: false, status: 400, error: 'action' };
  if (action && !ACTION_RE.test(action)) return { ok: false, status: 400, error: 'action' };
  const path = raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
  const rule = ruleOf(method, path);
  if (!rule || rule.sudoTicket !== true) return { ok: false, status: 400, error: 'not-here' };
  if (action && (!rule.actions || !Object.prototype.hasOwnProperty.call(rule.actions, action))) return { ok: false, status: 400, error: 'action' };
  const level = levelOf(method, path, action ? { action } : undefined);
  if (level !== ACCESS.ROOT) return { ok: false, status: 400, error: 'action' };
  return { ok: true, method, path, action };
}

/**
 * 发一张票（调用方已验过凭据、已判过 sudoers 档）。出错抛错（调用方 503）。
 * @param {any} env @param {{uid:number, sessionId:string, method:string, path:string, action:string}} t @param {number} [now]
 * @returns {Promise<{ticket:string, expiresAt:number}>}
 */
export async function issueSudoTicket(env, t, now) {
  const at = typeof now === 'number' ? now : Date.now();
  const ticket = b64urlEnc(crypto.getRandomValues(new Uint8Array(32)));
  const id = await sha256Hex(ticket);
  const expiresAt = at + SUDO_TICKET_TTL_MS;
  await onDb(env, (d) => d.batch([
    d.prepare('DELETE FROM account_sudo_tickets WHERE expires_at <= ?').bind(at),
    d.prepare('INSERT INTO account_sudo_tickets (id, uid, session_id, method, path, action, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, t.uid, t.sessionId, t.method, t.path, t.action || '', expiresAt),
  ]));
  return { ticket, expiresAt };
}

/**
 * 核销一张票：对得上（同 uid、同会话、同方法、同路径、同 action、没过期）就原子删掉并回 true；否则 false。永不抛错（出错 → false）。
 * @param {any} env @param {string} ticket @param {{uid:number, sessionId:string, method:string, path:string, action:string}} t @param {number} [now]
 * @returns {Promise<boolean>}
 */
export async function consumeSudoTicket(env, ticket, t, now) {
  if (typeof ticket !== 'string' || !SUDO_TICKET_RE.test(ticket)) return false;
  if (!t || !Number.isInteger(t.uid) || typeof t.sessionId !== 'string' || !t.sessionId) return false;
  const at = typeof now === 'number' ? now : Date.now();
  try {
    const id = await sha256Hex(ticket);
    /* 拿着票来就作废（对不上的也删：票只有一次机会，不给换路径重试） */
    const row = await onDb(env, (d) => d.prepare('DELETE FROM account_sudo_tickets WHERE id = ? AND expires_at > ? RETURNING id, uid, session_id, method, path, action')
      .bind(id, at).first());
    return !!(row && row.id === id && row.uid === t.uid && row.session_id === t.sessionId && row.method === String(t.method || '')
      && row.path === String(t.path || '') && row.action === String(t.action || ''));
  } catch (e) {
    return false;
  }
}
