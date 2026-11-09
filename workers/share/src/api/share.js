/**
 * @fileoverview 分享短链管理：POST /api/share { action }（只收同源）。
 * 鉴权（进站 v3 Q3 定稿，Gray 2026-11-09 08:00：「新建」和「管理」分开）：create（含 reuse:true）= 进门（任何进门方式，不验证）；
 * list / revoke = 进门 + 锁侧复验——先问网关 ShareIssuer.checkReauth，没有有效 sgx-lock-reauth → 原样回 401 reauth
 * （盾牌「分享链接」层一打开就跑 sudo styrigx reauth）。
 *
 * - list → { links: [view] }（新到旧；含已过期 / 已作废的，留 7 天后删；字段见 lib/links.js view）
 * - create { name?, hours? | days?, to?, session? } → { link: view }（只要进门）
 *     有效期：hours 1–24 或 days 3 / 7 / 15 / 30；to 站内相对路径或 https://styrigx.com 的地址（默认 /，lib/links.js cleanTarget）；
 *     session = 短链进门会话秒数（0 / 不传 = 普通短链，不签钥匙、不发会话），只收 1800 / 3600 / 10800 / 43200 / 86400 / 259200 / 604800，
 *     且不超过有效期；同时有效最多 20 条（409 full）。
 *     带会话：请网关（ISSUER → ShareIssuer.createLinkKey）签一把新的短链钥匙，网关再验一次进门；
 *     短链到期时间 = 钥匙到期时间。写 D1 失败 → 把刚签的钥匙作废，不留孤儿。
 * - create 加 reuse:true（顶栏分享按钮用）：已有同一目标（规范化后）、同一会话档位、同一有效期、没作废、还剩 ≥ 12 小时的短链
 *     → 直接返回它（{ link, reused:true }），不签新钥匙、不占名额，临时钥匙列表不会越点越长；名字超过 24 字截断（按钮拿页面标题当名字）。
 * - 只收同源（Origin 必须是 styrigx.com 本身）：跨源或不带 Origin 一律 403 origin；合并 PR3 起各站都在主域名下，旧图志的跨源已删。
 * - revoke { id } → 作废（带会话的先请网关作废钥匙：拿它进门的人下一个请求就进不来；网关失败 → 503，D1 不改，可以重试）
 */
import { isSameOrigin, originDenied, json, apiError } from '../lib/http.js';
import { cookieOf } from '../auth.js';
import {
  SQL, SHARE_MAX, NAME_MAX, KEEP_DEAD_MS, REUSE_MIN_LEFT_MS, REUSE_SLACK_MS, durationMs, cleanName, cleanTarget, sessionSeconds,
  newCode, newId, isId, view, first, all, run,
} from '../lib/links.js';

/** @param {object} body @param {number} [status] */
/** @param {any} context */
export async function onRequestGet(context) {
  return apiError(405, 'method');
}

/** @param {any} context */
export async function onRequestPost(context) {
  try {
    return await handle(context);
  } catch (e) {
    console.error('[sgx-share] api: ' + (e && e.name ? e.name : 'error'));
    return apiError(500, 'server');
  }
}

/** 网关回的错误码 → 本接口的响应 @param {string} e */
function issuerError(e) {
  if (e === 'session' || e === 'reauth') return json(401, { ok: false, error: e });
  if (e === 'duration' || e === 'name' || e === 'params') return json(400, { ok: false, error: e });
  return apiError(503, 'server');
}

/** @param {any} context */
async function handle(context) {
  const { request, env, auth } = context;
  if (!isSameOrigin(request)) return originDenied();
  const sess = await auth.lockSession();
  if (!sess.ok) return apiError(401, 'session');
  const db = env && env.D1_SHARE_LINK;
  const issuer = env && env.ISSUER;
  if (!db) return apiError(500, 'config');

  let body;
  try { body = await request.json(); } catch (e) {
    return apiError(400, 'body');
  }
  const action = (body && body.action) || '';
  const reuse = !!(body && body.reuse === true);
  const now = Date.now();

  /* 管理（列表 / 作废）：进门 + 锁侧复验，先问网关；新建只要进门（进站 v3 Q3 定稿 08:00：临时钥匙、分享链接进来的人也能发） */
  if (action === 'list' || action === 'revoke') {
    if (!issuer || typeof issuer.checkReauth !== 'function') return apiError(503, 'config');
    let g;
    try {
      g = await issuer.checkReauth(cookieOf(request));
    } catch (e) {
      return apiError(503, 'server');
    }
    if (!g || g.ok !== true) return issuerError(g && g.error);
  }

  if (action === 'list') {
    try {
      await run(db, SQL.purge, now - KEEP_DEAD_MS);
      const rows = await all(db, SQL.list);
      return json(200, { ok: true, links: rows.map((r) => view(r, now)) });
    } catch (e) {
      return apiError(503, 'server');
    }
  }

  if (action === 'create') {
    const dur = { hours: body.hours, days: body.days };
    const ms = durationMs(dur);
    if (!ms) return apiError(400, 'duration');
    const name = cleanName(reuse ? [...String(body.name == null ? '' : body.name).trim()].slice(0, NAME_MAX).join('') : body.name);
    if (name === null) return apiError(400, 'name');
    const to = cleanTarget(body.to);
    if (to === null) return apiError(400, 'target');
    const session = sessionSeconds(body.session, ms);
    if (session < 0) return apiError(400, 'session');
    if (reuse) {
      try {
        const hit = await first(db, SQL.reusable, to, session, now + REUSE_MIN_LEFT_MS, ms - REUSE_SLACK_MS, ms + REUSE_SLACK_MS);
        if (hit) return json(200, { ok: true, link: view(hit, now), reused: true });
      } catch (e) {
        return apiError(503, 'server');
      }
    }
    try {
      const c = await first(db, SQL.countActive, now);
      if (c && c.n >= SHARE_MAX) return apiError(409, 'full');
    } catch (e) {
      return apiError(503, 'server');
    }
    let keyId = '';
    let expiresAt = now + ms;
    if (session > 0) {
      if (!issuer || typeof issuer.createLinkKey !== 'function') return apiError(503, 'config');
      let r;
      try {
        r = await issuer.createLinkKey(cookieOf(request), { hours: dur.hours, days: dur.days, name: name });
      } catch (e) {
        return apiError(503, 'server');
      }
      if (!r || r.ok !== true || !r.key || typeof r.key.id !== 'string') return issuerError(r && r.error);
      keyId = r.key.id;
      expiresAt = r.key.expiresAt;
    }
    const id = newId();
    const code = newCode();
    try {
      await run(db, SQL.insert, id, code, name, to, session, keyId, now, expiresAt);
    } catch (e) {
      if (keyId) {
        try { await issuer.revokeLinkKey(cookieOf(request), keyId); } catch (e2) {}
      }
      return apiError(503, 'server');
    }
    const row = await first(db, SQL.byId, id);
    return json(200, reuse ? { ok: true, link: view(row, Date.now()), reused: false } : { ok: true, link: view(row, Date.now()) });
  }

  if (action === 'revoke') {
    const id = body.id;
    if (!isId(id)) return apiError(400, 'params');
    let row;
    try {
      row = await first(db, SQL.byId, id);
    } catch (e) {
      return apiError(503, 'server');
    }
    if (!row) return apiError(404, 'not-found');
    if (row.revoked_at) return json(200, { ok: true });
    if (row.key_id && row.expires_at > now) {
      if (!issuer || typeof issuer.revokeLinkKey !== 'function') return apiError(503, 'config');
      let r;
      try {
        r = await issuer.revokeLinkKey(cookieOf(request), row.key_id);
      } catch (e) {
        return apiError(503, 'server');
      }
      if (!r || r.ok !== true) return issuerError(r && r.error);
    }
    try {
      await run(db, SQL.revoke, id, now);
    } catch (e) {
      return apiError(503, 'server');
    }
    return json(200, { ok: true });
  }

  return apiError(400, 'action');
}
