/**
 * B2-7 网站数字健康：统计站长在主站、书站、博客各区域的停留时长（只算页面可见且有操作的时间）。
 *
 * POST /api/wellbeing   上报（主站 / book / blog 都打到主站这一个接口）
 *   body（text/plain 或 application/json，sendBeacon 发 text/plain 免预检）：
 *     {"d":"2026-10-17","s":[{"k":"home","sec":42},{"k":"book:abc123","t":"三体","sec":300}]}
 *   - d：上报设备的本地日期；只接受服务器 UTC 日期前后 1 天内（覆盖所有时区）
 *   - k：区域键。主站 home/files/browser/settings；书站 book 或 book:<id>；博客 blog 或 post:<slug>
 *   - t：可选标题（书名 / 文章名），最长 60 字
 *   - sec：本次累计秒数，1–900（客户端最多 5 分钟一报，留余量）
 *   - 只记 owner：visitor 会话直接 204 丢弃，访客的时长不进站长的数字健康
 *   - 写入 D1（SGX_D1）wb_daily，同一天同一键原子累加，跨设备天然合并
 * GET /api/wellbeing?d=YYYY-MM-DD  读取某天汇总（默认服务器 UTC 今天）
 *   - 任何有效会话可读（首页小组件访客也能看到站长的数字健康，和原来的静态数据一致）
 *   - 书名 / 文章名只返回给 owner；visitor 只拿到区域合计
 *   - 返回 {ok, d, total, sections:[{k,sec}], items:[{k,t,sec}]}
 *
 * 不涉及任何密钥 / 会话签发；未绑定 SGX_D1（本地 / preview）时 POST 204、GET 返回空。
 */
import { verifySessionDetailed } from '../_middleware.js';

export const WB_SECTIONS = ['home', 'files', 'browser', 'settings', 'book', 'blog'];
const KEY_RE = /^(home|files|browser|settings|book|blog)$|^(book|post):[A-Za-z0-9_\-./%]{1,80}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 4096;
const MAX_ENTRIES = 12;
const MAX_SEC = 900;
const KEEP_DAYS = 35;

const SCHEMA =
  'CREATE TABLE IF NOT EXISTS wb_daily (day TEXT NOT NULL, k TEXT NOT NULL, t TEXT NOT NULL DEFAULT \'\', sec INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, k))';

/** 区域键 → 汇总分组（book:xxx → book，post:xxx → blog） */
export function sectionOf(k) {
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
 * @param {boolean} owner
 */
export function summarize(rows, owner) {
  /** @type {Record<string, number>} */
  const sec = {};
  let total = 0;
  const items = [];
  for (const r of rows) {
    const s = sectionOf(r.k);
    sec[s] = (sec[s] || 0) + r.sec;
    total += r.sec;
    if (owner && r.k.includes(':')) items.push({ k: r.k, t: r.t || '', sec: r.sec });
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
  const sess = await verifySessionDetailed(request, env);
  if (!sess.ok) return new Response(null, { status: 401, headers: NO_STORE });
  if (sess.role !== 'owner') return new Response(null, { status: 204, headers: NO_STORE });
  const db = env && env.SGX_D1;
  if (!db) return new Response(null, { status: 204, headers: NO_STORE });
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
    const up = db.prepare(
      'INSERT INTO wb_daily (day, k, t, sec) VALUES (?1, ?2, ?3, ?4) ' +
        "ON CONFLICT(day, k) DO UPDATE SET sec = MIN(sec + excluded.sec, 86400), t = CASE WHEN excluded.t <> '' THEN excluded.t ELSE t END"
    );
    const stmts = rep.s.map((e) => up.bind(rep.d, e.k, e.t, e.sec));
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
  const sess = await verifySessionDetailed(request, env);
  if (!sess.ok) return Response.json({ ok: false }, { status: 401, headers: NO_STORE });
  const url = new URL(request.url);
  const qd = url.searchParams.get('d') || '';
  const d = dayOk(qd) ? qd : utcDay(new Date());
  const empty = { ok: true, d, total: 0, sections: [], items: [] };
  const db = env && env.SGX_D1;
  if (!db) return Response.json(empty, { headers: NO_STORE });
  try {
    await db.prepare(SCHEMA).run();
    const { results } = await db.prepare('SELECT k, t, sec FROM wb_daily WHERE day = ?1').bind(d).all();
    const sum = summarize(/** @type {any[]} */ (results || []), sess.role === 'owner');
    return Response.json({ ok: true, d, ...sum }, { headers: NO_STORE });
  } catch (e) {
    console.error('[api/wellbeing] d1 error', e && /** @type {any} */ (e).message);
    return Response.json({ ok: false, d, total: 0, sections: [], items: [] }, { status: 503, headers: NO_STORE });
  }
}
