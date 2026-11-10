/**
 * @fileoverview 分享链接管理：POST /api/share { action }（只收同源）。进站 v3 L2 起在 styrigx-space-core 里（原 styrigx-share Worker 并入）。
 * 鉴权（v5 S1；进站 v3 Q3「新建」和「管理」分开）：
 * - create（含 reuse:true）= 进门，且不是分享链接进来的会话（by=link → 403 link）；不要 reauth（core/link-keys.js checkLinkCreate）。
 * - list / revoke = 进门 + 不是 by=link + 锁侧复验（没有有效 sgx-space-reauth → 401 reauth；盾牌「分享链接」层一打开就跑 sudo styrigx reauth）
 *   （core/link-keys.js checkLinkReauth）。
 *
 * - list → { links: [view] }（新到旧；含已过期 / 已作废的，留 7 天后删——先调一次清理入口 purgeDeadLinks；字段见 core/share-links.js view）
 * - create { name?, hours? | days?, to?, session? } → { link: view }
 *     有效期：hours 1–24 或 days 3 / 7 / 15 / 30；to 站内相对路径或 https://styrigx.com 的地址（默认 /，core/share-links.js cleanTarget）；
 *     session = 短链进门会话秒数（0 / 不传 = 普通短链，不发会话），只收 1800 / 3600 / 10800 / 43200 / 86400 / 259200 / 604800，
 *     且不超过有效期；同时有效最多 20 条（409 full）。带会话的不再签「短链钥匙」：点开时直接按这一行签 by=link 的会话（core/share-open.js）；
 *     key_id 列写 ''（列在后面的收尾 PR 删）。
 * - create 加 reuse:true（顶栏分享按钮用）：已有同一目标（规范化后）、同一会话档位、同一有效期、没作废、还剩 ≥ 12 小时的短链
 *     → 直接返回它（{ link, reused:true }），不新建、不占名额；名字超过 24 字截断（按钮拿页面标题当名字）。
 * - 只收同源（Origin 必须是 styrigx.com 本身）：跨源或不带 Origin 一律 403 origin。
 * - revoke { id } → 作废这一条（写 share_link.revoked_at）；revoke { all:true } → 作废全部还没作废的（share rm --all）。
 *     拿它进门的人下一个请求验票时就过不去（core/lock-session.js 查 share_link）。
 * 数据：D1 styrigx-space-core 的 share_* 表（绑定 D1_SPACE，表结构见 migrations/0001_baseline.sql）。
 */
import { isSameOrigin, originDenied, json, apiError } from '../lib/http.js';
import { checkLinkCreate, checkLinkReauth } from '../core/link-keys.js';
import { shareCookieOf } from '../core/share-open.js';
import {
  SQL, SHARE_MAX, NAME_MAX, REUSE_MIN_LEFT_MS, REUSE_SLACK_MS, durationMs, cleanName, cleanTarget, sessionSeconds,
  newCode, newId, isId, view, first, all, run, purgeDeadLinks,
} from '../core/share-links.js';

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
    console.error('[sgx-space-core] share api: ' + (e && e.name ? e.name : 'error'));
    return apiError(500, 'server');
  }
}

/** core/link-keys.js 回的错误码 → 本接口的响应 @param {string|undefined} e */
function gateDenied(e) {
  if (e === 'session' || e === 'reauth') return json(401, { ok: false, error: e });
  if (e === 'link') return apiError(403, 'link'); /* 分享链接进来的会话：不能新建 / 管理分享 */
  return apiError(503, 'server');
}

/** @param {any} context */
async function handle(context) {
  const { request, env, auth } = context;
  if (!isSameOrigin(request)) return originDenied();
  const sess = await auth.session();
  if (!sess.ok) return apiError(401, 'session');
  const db = env && env.D1_SPACE;
  if (!db) return apiError(500, 'config');
  const cookie = shareCookieOf(request);

  let body;
  try { body = await request.json(); } catch (e) {
    return apiError(400, 'body');
  }
  const action = (body && body.action) || '';
  const reuse = !!(body && body.reuse === true);
  const now = Date.now();

  /* 管理（列表 / 作废）：进门 + 锁侧复验；新建：进门。两种都不认分享链接进来的会话（v5 S1，by=link → 403 link） */
  if (action === 'list' || action === 'revoke' || action === 'create') {
    let g;
    try {
      g = action === 'create' ? await checkLinkCreate(cookie, env) : await checkLinkReauth(cookie, env);
    } catch (e) {
      return apiError(503, 'server');
    }
    if (!g || g.ok !== true) return gateDenied(g && g.error);
  }

  if (action === 'list') {
    try {
      await purgeDeadLinks(db, now);
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
    const expiresAt = now + ms;
    const id = newId();
    const code = newCode();
    try {
      /* key_id 写 ''：v5 S1 起不签短链钥匙（列在后面的收尾 PR 删） */
      await run(db, SQL.insert, id, code, name, to, session, '', now, expiresAt);
    } catch (e) {
      return apiError(503, 'server');
    }
    const row = await first(db, SQL.byId, id);
    return json(200, reuse ? { ok: true, link: view(row, Date.now()), reused: false } : { ok: true, link: view(row, Date.now()) });
  }

  if (action === 'revoke') {
    /* share rm --all：一条 UPDATE 作废全部还没作废的 */
    if (body.all === true) {
      if (body.id !== undefined) return apiError(400, 'params');
      try {
        await run(db, SQL.revokeAll, now);
      } catch (e) {
        return apiError(503, 'server');
      }
      return json(200, { ok: true });
    }
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
    try {
      await run(db, SQL.revoke, id, now);
    } catch (e) {
      return apiError(503, 'server');
    }
    return json(200, { ok: true });
  }

  return apiError(400, 'action');
}
