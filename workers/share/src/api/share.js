/**
 * @fileoverview 分享短链管理：POST /api/share { action }（同源；子站只许 create + reuse；站长锁屏会话 + 账号会话，门已拦掉访客和没会话的）。
 *
 * - list → { links: [view] }（新到旧；含已过期 / 已作废的，留 7 天后删；字段见 lib/links.js view）
 * - create { name?, hours? | days?, to?, session? } → { link: view }
 *     有效期：hours 1–24 或 days 3 / 7 / 15 / 30；to 站内相对路径或 styrigx.com / 三个子站的 https 地址（默认 /，lib/links.js cleanTarget）；
 *     session = 访客会话秒数（0 / 不传 = 普通短链，不签钥匙、不发会话），只收 1800 / 3600 / 10800 / 43200 / 86400 / 259200 / 604800，
 *     且不超过有效期；同时有效最多 20 条（409 full）。
 *     带会话：请网关（ISSUER → ShareIssuer.createLinkKey）签一把新的短链钥匙，网关再验一次站长 + 账号会话；
 *     短链到期时间 = 钥匙到期时间。写 D1 失败 → 把刚签的钥匙作废，不留孤儿。
 * - create 加 reuse:true（子站顶栏分享按钮用）：已有同一目标（规范化后）、同一会话档位、同一有效期、没作废、还剩 ≥ 12 小时的短链
 *     → 直接返回它（{ link, reused:true }），不签新钥匙、不占名额，临时钥匙列表不会越点越长；名字超过 24 字截断（按钮拿页面标题当名字）。
 * - 跨源：只认三个子站的 Origin（lib/cors.js），而且只许 create + reuse:true；list / revoke 只能在主站同源调。
 * - revoke { id } → 作废（带会话的先请网关作废钥匙：拿它进来的访客下一个请求就进不来；网关失败 → 503，D1 不改，可以重试）
 */
import { isSameOrigin, originDenied } from '../lib/http.js';
import { isSubsiteOrigin } from '../lib/cors.js';
import { ROLE_OWNER, metaOf, cookieOf } from '../auth.js';
import {
  SQL, SHARE_MAX, NAME_MAX, KEEP_DEAD_MS, REUSE_MIN_LEFT_MS, REUSE_SLACK_MS, durationMs, cleanName, cleanTarget, sessionSeconds,
  newCode, newId, isId, view, first, all, run,
} from '../lib/links.js';

/** @param {object} body @param {number} [status] */
function json(body, status) {
  return Response.json(body, { status: status || 200, headers: { 'Cache-Control': 'private, no-store' } });
}

/** @param {any} context */
export async function onRequestGet(context) {
  return json({ ok: false, error: 'method' }, 405);
}

/** @param {any} context */
export async function onRequestPost(context) {
  try {
    return await handle(context);
  } catch (e) {
    console.error('[sgx-share] api: ' + (e && e.name ? e.name : 'error'));
    return json({ ok: false, error: 'server' }, 500);
  }
}

/** 网关回的错误码 → 本接口的响应 @param {string} e */
function issuerError(e) {
  if (e === 'session' || e === 'account') return json({ ok: false, error: e }, 401);
  if (e === 'duration' || e === 'name' || e === 'params') return json({ ok: false, error: e }, 400);
  return json({ ok: false, error: 'server' }, 503);
}

/** @param {any} context */
async function handle(context) {
  const { request, env, auth } = context;
  const cross = !isSameOrigin(request);
  if (cross && !isSubsiteOrigin(request)) return originDenied();
  const sess = await auth.lockSession();
  if (!sess.ok || sess.role !== ROLE_OWNER) return json({ ok: false, error: 'session' }, 401);
  const acc = await auth.accountSession();
  if (!acc.ok) return json({ ok: false, error: 'account', reason: acc.reason }, 401);
  const db = env && env.D1_SHARE_LINK;
  const issuer = env && env.ISSUER;
  if (!db) return json({ ok: false, error: 'config' }, 500);

  let body;
  try { body = await request.json(); } catch (e) {
    return json({ ok: false, error: 'body' }, 400);
  }
  const action = (body && body.action) || '';
  const reuse = !!(body && body.reuse === true);
  if (cross && !(action === 'create' && reuse)) return originDenied();
  const now = Date.now();

  if (action === 'list') {
    try {
      await run(db, SQL.purge, now - KEEP_DEAD_MS);
      const rows = await all(db, SQL.list);
      return json({ ok: true, links: rows.map((r) => view(r, now)) });
    } catch (e) {
      return json({ ok: false, error: 'server' }, 503);
    }
  }

  if (action === 'create') {
    const dur = { hours: body.hours, days: body.days };
    const ms = durationMs(dur);
    if (!ms) return json({ ok: false, error: 'duration' }, 400);
    const name = cleanName(reuse ? [...String(body.name == null ? '' : body.name).trim()].slice(0, NAME_MAX).join('') : body.name);
    if (name === null) return json({ ok: false, error: 'name' }, 400);
    const to = cleanTarget(body.to);
    if (to === null) return json({ ok: false, error: 'target' }, 400);
    const session = sessionSeconds(body.session, ms);
    if (session < 0) return json({ ok: false, error: 'session' }, 400);
    if (reuse) {
      try {
        const hit = await first(db, SQL.reusable, to, session, now + REUSE_MIN_LEFT_MS, ms - REUSE_SLACK_MS, ms + REUSE_SLACK_MS);
        if (hit) return json({ ok: true, link: view(hit, now), reused: true });
      } catch (e) {
        return json({ ok: false, error: 'server' }, 503);
      }
    }
    try {
      const c = await first(db, SQL.countActive, now);
      if (c && c.n >= SHARE_MAX) return json({ ok: false, error: 'full' }, 409);
    } catch (e) {
      return json({ ok: false, error: 'server' }, 503);
    }
    let keyId = '';
    let expiresAt = now + ms;
    if (session > 0) {
      if (!issuer || typeof issuer.createLinkKey !== 'function') return json({ ok: false, error: 'config' }, 503);
      let r;
      try {
        r = await issuer.createLinkKey(cookieOf(request), { hours: dur.hours, days: dur.days, name: name, meta: metaOf(request) });
      } catch (e) {
        return json({ ok: false, error: 'server' }, 503);
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
        try { await issuer.revokeLinkKey(cookieOf(request), keyId, metaOf(request)); } catch (e2) {}
      }
      return json({ ok: false, error: 'server' }, 503);
    }
    const row = await first(db, SQL.byId, id);
    return json(reuse ? { ok: true, link: view(row, Date.now()), reused: false } : { ok: true, link: view(row, Date.now()) });
  }

  if (action === 'revoke') {
    const id = body.id;
    if (!isId(id)) return json({ ok: false, error: 'params' }, 400);
    let row;
    try {
      row = await first(db, SQL.byId, id);
    } catch (e) {
      return json({ ok: false, error: 'server' }, 503);
    }
    if (!row) return json({ ok: false, error: 'not-found' }, 404);
    if (row.revoked_at) return json({ ok: true });
    if (row.key_id && row.expires_at > now) {
      if (!issuer || typeof issuer.revokeLinkKey !== 'function') return json({ ok: false, error: 'config' }, 503);
      let r;
      try {
        r = await issuer.revokeLinkKey(cookieOf(request), row.key_id, metaOf(request));
      } catch (e) {
        return json({ ok: false, error: 'server' }, 503);
      }
      if (!r || r.ok !== true) return issuerError(r && r.error);
    }
    try {
      await run(db, SQL.revoke, id, now);
    } catch (e) {
      return json({ ok: false, error: 'server' }, 503);
    }
    return json({ ok: true });
  }

  return json({ ok: false, error: 'action' }, 400);
}
