/**
 * 网站数字健康：统计主人（账号已登录）在主站和子站各区域的停留时长（只算页面可见且有操作的时间）。
 *
 * POST /api/wellbeing   上报（主站 / book / blog 都打到主站这一个接口）
 *   body（text/plain 或 application/json，sendBeacon 发 text/plain 免预检）：
 *     {"d":"2026-10-17","s":[{"k":"home","sec":42},{"k":"book:abc123","t":"三体","sec":300}]}
 *   - d：上报设备的本地日期；只接受服务器 UTC 日期前后 1 天内（覆盖所有时区）
 *   - k：区域键。主站 space/files/browser（P4-3 PR-4b 起旷野页和子页都记 space；旧客户端还会报 home / settings，照收，汇总时并进 space）；
 *     书站 book 或 book:<id>；博客 blog 或 post:<slug>
 *   - t：可选标题（书名 / 文章名），最长 60 字
 *   - sec：本次累计秒数，1–900（客户端最多 5 分钟一报，留余量）
 *   - 只记账号会话 + 作用域 wellbeing.write（方案 3.4 R12）：没登录账号 / 没作用域直接 204 丢弃，不进主人的数字健康；没有进站会话 401
 *   - 写入 D1（D1_ACCOUNT）wb_daily，同一天同一键原子累加，跨设备天然合并
 * GET /api/wellbeing?d=YYYY-MM-DD  读取某天汇总（默认服务器 UTC 今天）
 *   - 公开（v5 S3）：谁都能读区域合计
 *   - 明细（书名 / 文章名）只给进站 + 账号会话；没登录账号只拿到区域合计（items 为空）
 *   - 返回 {ok, d, detail, total, sections:[{k,sec}], items:[{k,t,sec}]}；detail = 这次有没有给明细（前端旷野 › 数字健康卡按它显示）
 *
 * v6（P2）：按 uid 分（uid 只取服务端会话：v6 新会话 = 会话里的 uid，旧会话 = styrigx；请求里的 uid 一概不认）。
 *   - POST：v6 新会话（档 user）也能记，记在自己的 uid 下；表还没 uid 列（迁移待批）时只记 styrigx 的，别的 uid 204 丢弃。
 *   - GET：公开的合计 = 站长 styrigx 的数据；明细只给本人（styrigx，或 root；旧会话 = 进站 + 账号会话）。
 * 不涉及任何密钥 / 会话签发；未绑定 D1_ACCOUNT（本地）时 POST 204、GET 返回空。
 * 2026-10-24 起在账号 Worker styrigx-account（D1 styrigx-account，迁移在 workers/account/migrations/）。
 */
import { json } from '../lib/http.js';
import { hasUidColumn } from '../lib/uid-schema.js';
import { STYRIGX_UID, ROOT_UID } from '../core/groups.js';

const KEY_RE = /^(space|home|files|browser|settings|book|blog)$|^(book|post):[A-Za-z0-9_\-./%]{1,80}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 4096;
const MAX_ENTRIES = 12;
const MAX_SEC = 900;
const KEEP_DAYS = 35;

const SCHEMA =
  'CREATE TABLE IF NOT EXISTS wb_daily (day TEXT NOT NULL, k TEXT NOT NULL, t TEXT NOT NULL DEFAULT \'\', sec INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, k))';

/** 区域键 → 汇总分组（book:xxx → book，post:xxx → blog；旧键 home / settings → space：主页和设置合成旷野页，P4-3 PR-4b，读旧写新） */
export function sectionOf(k) {
  if (k === 'home' || k === 'settings') return 'space';
  if (k.startsWith('book:')) return 'book';
  if (k.startsWith('post:')) return 'blog';
  return k;
}

/** @param {Date} d */
function utcDay(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * 日期是否在服务器 UTC 今天 ±1 天内。
 * @param {string} d
 * @param {number} [now]
 */
export function dayOk(d, now = Date.now()) {
  if (!DAY_RE.test(d)) return false;
  const t = Date.parse(d + 'T00:00:00Z');
  if (!Number.isFinite(t)) return false;
  const today = Date.parse(utcDay(new Date(now)) + 'T00:00:00Z');
  return Math.abs(t - today) <= 86400000;
}

/**
 * 校验并规整上报体；不合法返回 null。同键合并。
 * @param {any} body
 * @param {number} [now]
 * @returns {{d:string, s:{k:string,t:string,sec:number}[]}|null}
 */
export function parseReport(body, now) {
  if (!body || typeof body !== 'object') return null;
  if (typeof body.d !== 'string' || !dayOk(body.d, now)) return null;
  if (!Array.isArray(body.s) || body.s.length === 0 || body.s.length > MAX_ENTRIES) return null;
  /** @type {Map<string,{k:string,t:string,sec:number}>} */
  const m = new Map();
  for (const e of body.s) {
    if (!e || typeof e.k !== 'string' || !KEY_RE.test(e.k)) return null;
    const sec = Math.round(Number(e.sec));
    if (!Number.isFinite(sec) || sec < 1 || sec > MAX_SEC) return null;
    const t = typeof e.t === 'string' ? e.t.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) : '';
    const prev = m.get(e.k);
    if (prev) {
      prev.sec = Math.min(MAX_SEC, prev.sec + sec);
      if (t) prev.t = t;
    } else m.set(e.k, { k: e.k, t, sec });
  }
  return { d: body.d, s: [...m.values()] };
}

/**
 * 把一天的行汇总成返回结构。
 * @param {{k:string,t:string,sec:number}[]} rows
 * @param {boolean} detail 给不给明细（书名 / 文章名）
 */
export function summarize(rows, detail) {
  /** @type {Record<string, number>} */
  const sec = {};
  let total = 0;
  const items = [];
  for (const r of rows) {
    const s = sectionOf(r.k);
    sec[s] = (sec[s] || 0) + r.sec;
    total += r.sec;
    if (detail && r.k.includes(':')) items.push({ k: r.k, t: r.t || '', sec: r.sec });
  }
  const sections = Object.keys(sec)
    .map((k) => ({ k, sec: sec[k] }))
    .sort((a, b) => b.sec - a.sec);
  items.sort((a, b) => b.sec - a.sec);
  return { total, sections, items: items.slice(0, 5) };
}

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/** @param {any} context */
export async function onRequestPost(context) {
  const { request, env } = context;
  /* v6 新会话（档 user，permits 判过）：记在会话的 uid 下 */
  const v = context.auth.hasV6 ? await context.auth.v6() : null;
  const uid = v && v.allowed === true && Number.isInteger(v.uid) ? v.uid : null;
  /* v6 P4（定稿 v5.2 §十三）：旧进站会话 + 账号会话（wellbeing.write）的分支删除，没有 v6 身份 401 */
  if (uid === null) return new Response(null, { status: 401, headers: NO_STORE });
  const db = env && env.D1_ACCOUNT;
  if (!db) return new Response(null, { status: 204, headers: NO_STORE });
  const byUid = await hasUidColumn(db, 'wb_daily');
  if (!byUid && uid !== STYRIGX_UID) return new Response(null, { status: 204, headers: NO_STORE }); /* 迁移前只记站长的 */
  const raw = await request.text();
  if (raw.length > MAX_BODY) return new Response(null, { status: 413, headers: NO_STORE });
  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return new Response(null, { status: 400, headers: NO_STORE });
  }
  const rep = parseReport(body);
  if (!rep) return new Response(null, { status: 400, headers: NO_STORE });
  try {
    await db.prepare(SCHEMA).run();
    const up = byUid
      ? db.prepare(
        'INSERT INTO wb_daily (uid, day, k, t, sec) VALUES (?5, ?1, ?2, ?3, ?4) ' +
          "ON CONFLICT(uid, day, k) DO UPDATE SET sec = MIN(sec + excluded.sec, 86400), t = CASE WHEN excluded.t <> '' THEN excluded.t ELSE t END")
      : db.prepare(
        'INSERT INTO wb_daily (day, k, t, sec) VALUES (?1, ?2, ?3, ?4) ' +
          "ON CONFLICT(day, k) DO UPDATE SET sec = MIN(sec + excluded.sec, 86400), t = CASE WHEN excluded.t <> '' THEN excluded.t ELSE t END");
    const stmts = rep.s.map((e) => (byUid ? up.bind(rep.d, e.k, e.t, e.sec, uid) : up.bind(rep.d, e.k, e.t, e.sec)));
    /* 偶尔清理 35 天前的数据（约每 50 次上报一次） */
    if (Math.random() < 0.02) {
      const cut = utcDay(new Date(Date.now() - KEEP_DAYS * 86400000));
      stmts.push(db.prepare('DELETE FROM wb_daily WHERE day < ?1').bind(cut));
    }
    await db.batch(stmts);
    return new Response(null, { status: 204, headers: NO_STORE });
  } catch (e) {
    console.error('[api/wellbeing] d1 error', e && /** @type {any} */ (e).message);
    return new Response(null, { status: 503, headers: NO_STORE });
  }
}

/** @param {any} context */
export async function onRequestGet(context) {
  const { request, env } = context;
  /* v5 S3：合计公开（网关访问表 GET /api/wellbeing = public，gate.js PUBLIC_API 同一条）；明细只给站长 / root（v6 会话） */
  const url = new URL(request.url);
  const qd = url.searchParams.get('d') || '';
  const d = dayOk(qd) ? qd : utcDay(new Date());
  /* 明细只给本人（Muse 审查 v5 注意点 1）：按服务端会话的 uid——站长 styrigx / root 给明细，别人只给合计；访客只有合计。
     v6 P4 起旧会话（进站 + 账号会话）的分支删除。请求里的任何 uid 都不认 */
  const v = context.auth.hasV6 ? await context.auth.v6() : null;
  const v6uid = v && v.allowed === true && Number.isInteger(v.uid) ? v.uid : null;
  const detail = v6uid === STYRIGX_UID || v6uid === ROOT_UID;
  const empty = { ok: true, d, detail, total: 0, sections: [], items: [] };
  const db = env && env.D1_ACCOUNT;
  if (!db) return json(200, empty, NO_STORE);
  try {
    await db.prepare(SCHEMA).run();
    const byUid = await hasUidColumn(db, 'wb_daily');
    const q = byUid ? db.prepare('SELECT k, t, sec FROM wb_daily WHERE day = ?1 AND uid = ?2').bind(d, STYRIGX_UID) : db.prepare('SELECT k, t, sec FROM wb_daily WHERE day = ?1').bind(d);
    const { results } = await q.all();
    const sum = summarize(/** @type {any[]} */ (results || []), detail);
    return json(200, { ok: true, d, detail, ...sum }, NO_STORE);
  } catch (e) {
    console.error('[api/wellbeing] d1 error', e && /** @type {any} */ (e).message);
    return json(503, { ok: false, d, detail: false, total: 0, sections: [], items: [] }, NO_STORE);
  }
}
