/**
 * v6 身份统一（P1）：新会话的判定（admit）——一次 D1 查询（会话 + 栈 + 用户 + 组 + epoch 一次 JOIN），只读、不写。
 *
 * - 客户端 cookie（SESSION_COOKIE）只是不透明随机令牌：不带 uid、组或栈。库里存的是令牌的 SHA-256（account_sessions.id）。
 * - 栈：栈底身份在 account_sessions（普通用户，或救援会话的 root）；su 压上来的那一层在 account_session_stack（深度 1，只会是 root）。
 *   访客 → 普通用户 → root，最多三层；sudo 不压栈。
 * - 有效：会话没过期；栈底用户存在、没禁用、没到期、epoch 严格相等。栈底是 root 只允许救援会话（root 代码级禁止公开登录）。
 * - root 层：没过期（≤ 1 小时）、root 没禁用、epoch 相等 → 当前身份 = root（via = 栈底）；否则弹回栈底（不写库，残行由下一次写操作清）。
 *   空闲 15 分钟弹回只算前台空闲，由前端（P2）用 Page Visibility 计时后调 exit。
 * - 救援会话：rescue = 1、栈底 root、没有中间层、15 分钟、不续期；能做什么由 core/groups.js permits 的 rescue 白名单管。
 * - 滑动续期（styrigx 层 30 天）：admit 只读，只回 renew 标志；仅当剩余不到一半、且距上次续期满一天时才续写（每会话每天至多一次）。
 *   续写本身随 P2 的签发入口落地。
 *
 * 旧会话（sgx-space-session 进站会话、sgx-account-session 账号会话）的判定原样不动、并存（分步割接，不做新旧格式互转）。
 * P1 还没有签发入口（P2 做 su），新路径只由单测覆盖。
 *
 * 只 import lib/ 和 core/groups.js。
 */
import { onDb } from '../lib/db.js';
import { readCookie } from '../lib/cookies.js';
import { GROUPS, ROOT_UID } from './groups.js';

/** 新会话的 cookie 名（HttpOnly、Secure、SameSite=Lax，不写 Domain（只发给本主机）；P2 签发时写） */
export const SESSION_COOKIE = 'sgx-session';
/** 令牌格式：32 字节随机数的 base64url（43 字符） */
export const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const DAY_MS = 86400 * 1000;
/** 会话时长（毫秒；Gray 2026-11-11 03:24 定稿） */
export const SESSION_TTL_MS = Object.freeze({
  /** 普通用户层：30 天滑动续期 */
  user: 30 * DAY_MS,
  /** root 层硬上限：1 小时 */
  rootLayer: 3600 * 1000,
  /** 救援会话：15 分钟，不续期 */
  rescue: 15 * 60 * 1000,
});
/** root 层空闲弹回（前台空闲；前端计时，P2）：15 分钟 */
export const ROOT_IDLE_MS = 15 * 60 * 1000;
/** 续期节流：剩余不到这个值才续（= 时长的一半） */
export const RENEW_BELOW_MS = SESSION_TTL_MS.user / 2;
/** 续期节流：同一会话两次续写至少隔这么久（每天至多一次） */
export const RENEW_MIN_INTERVAL_MS = DAY_MS;

/**
 * 这个会话该不该续写（滑动续期节流；admit 只回标志，不写）。救援会话永不续。
 * @param {{rescue:boolean, expiresAt:number, renewedAt:number, createdAt:number}} s @param {number} now
 */
export function shouldRenew(s, now) {
  if (!s || s.rescue) return false;
  const left = s.expiresAt - now;
  if (left <= 0 || left >= RENEW_BELOW_MS) return false;
  const last = Math.max(Number(s.renewedAt) || 0, Number(s.createdAt) || 0);
  return now - last >= RENEW_MIN_INTERVAL_MS;
}

/**
 * 会话令牌 → 库里的 id（SHA-256 十六进制）。格式不对 → null。
 * @param {string} token @returns {Promise<string|null>}
 */
export async function sessionIdOf(token) {
  if (typeof token !== 'string' || !SESSION_TOKEN_RE.test(token)) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * admit 的那一次查询：会话 + 栈底用户 + 栈底的组（GROUP_CONCAT）+ 栈顶那一层（LEFT JOIN）+ 栈顶用户。
 * 栈顶只会是 root（root 不进组），所以组只取栈底的。
 */
export const ADMIT_SQL = [
  'SELECT s.uid AS s_uid, s.epoch AS s_epoch, s.rescue AS s_rescue, s.created_at AS s_created, s.expires_at AS s_expires, s.renewed_at AS s_renewed,',
  ' u.name AS u_name, u.epoch AS u_epoch, u.disabled AS u_disabled, u.expires_at AS u_expires,',
  ' (SELECT GROUP_CONCAT(g.grp) FROM account_user_groups g WHERE g.uid = s.uid) AS u_groups,',
  ' k.uid AS k_uid, k.epoch AS k_epoch, k.expires_at AS k_expires,',
  ' t.name AS t_name, t.epoch AS t_epoch, t.disabled AS t_disabled, t.expires_at AS t_expires',
  ' FROM account_sessions s',
  ' JOIN account_users u ON u.uid = s.uid',
  ' LEFT JOIN account_session_stack k ON k.session_id = s.id AND k.depth = 1',
  ' LEFT JOIN account_users t ON t.uid = k.uid',
  ' WHERE s.id = ?',
].join('');

/**
 * @typedef {import('./groups.js').Identity} Identity
 * @typedef {{ ok:true, sessionId:string, identity:Identity, via:{uid:number, name:string}|null, expiresAt:number, layerExpiresAt:number, renew:boolean }
 *   | { ok:false, reason:string }} Admission
 */

/** @param {any} row @param {string} p 列前缀 @param {number} now */
function userLive(row, p, now) {
  const exp = Number(row[p + '_expires']) || 0;
  return Number(row[p + '_disabled']) !== 1 && (exp === 0 || exp > now);
}

/** GROUP_CONCAT → 认识的组，去重排序 @param {any} s */
function groupsOf(s) {
  if (typeof s !== 'string' || !s) return [];
  return Array.from(new Set(s.split(',').filter((g) => GROUPS.indexOf(g) !== -1))).sort();
}

/**
 * 判定一个新会话（只读，一次 D1 查询）。永不抛错：读库出错 → { ok:false, reason:'error' }（fail closed）。
 * @param {any} env @param {string} token cookie 里的令牌 @param {number} [now]
 * @returns {Promise<Admission>}
 */
export async function admitSession(env, token, now) {
  const t = typeof now === 'number' ? now : Date.now();
  const sid = await sessionIdOf(token);
  if (!sid) return { ok: false, reason: 'no-session' };
  let row;
  try {
    row = await onDb(env, (d) => d.prepare(ADMIT_SQL).bind(sid).first());
  } catch (e) {
    return { ok: false, reason: 'error' };
  }
  if (!row) return { ok: false, reason: 'no-session' };
  const expiresAt = Number(row.s_expires) || 0;
  if (expiresAt <= t) return { ok: false, reason: 'expired' };
  const bottomUid = Number(row.s_uid);
  const rescue = Number(row.s_rescue) === 1;
  if (!userLive(row, 'u', t)) return { ok: false, reason: 'user' };
  if (Number(row.s_epoch) !== Number(row.u_epoch)) return { ok: false, reason: 'epoch' };
  if (rescue !== (bottomUid === ROOT_UID)) return { ok: false, reason: 'root-bottom' };
  const base = { ok: /** @type {true} */ (true), sessionId: sid, expiresAt };
  if (rescue) {
    return { ...base, identity: { uid: ROOT_UID, name: String(row.u_name), groups: [], rescue: true }, via: null, layerExpiresAt: expiresAt, renew: false };
  }
  const renew = shouldRenew({ rescue: false, expiresAt, renewedAt: Number(row.s_renewed) || 0, createdAt: Number(row.s_created) || 0 }, t);
  const bottom = { uid: bottomUid, name: String(row.u_name), groups: groupsOf(row.u_groups), rescue: false };
  const rootLayer = row.k_uid !== null && row.k_uid !== undefined && Number(row.k_uid) === ROOT_UID
    && (Number(row.k_expires) || 0) > t && row.t_name !== null && row.t_name !== undefined
    && userLive(row, 't', t) && Number(row.k_epoch) === Number(row.t_epoch);
  if (rootLayer) {
    return { ...base, identity: { uid: ROOT_UID, name: String(row.t_name), groups: [], rescue: false },
      via: { uid: bottom.uid, name: bottom.name }, layerExpiresAt: Math.min(Number(row.k_expires), expiresAt), renew };
  }
  return { ...base, identity: bottom, via: null, layerExpiresAt: expiresAt, renew };
}

/**
 * 请求版：从 Cookie 头取 SESSION_COOKIE 再判定。没有这个 cookie → { ok:false, reason:'no-cookie' }（不查库）。
 * @param {any} env @param {Request} request @param {number} [now]
 * @returns {Promise<Admission>}
 */
export async function admitRequest(env, request, now) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return { ok: false, reason: 'no-cookie' };
  return admitSession(env, token, now);
}
