// /api/days —— 往前几天的「今日一句」（日刻日期条 / 前后日卡 / 余响窗，2026-11 对齐 PR-C2，设计稿 tb4.html pg=day）。
//
// GET /api/days?from=YYYY-MM-DD&to=YYYY-MM-DD   公开（v5 S3，同 /api/quotes 的公开句子；from..to 最多 31 天，不全表扫）。
//   只读 daily_pick 里已经记下的那几天（北京时间，to 最多到今天；from..to 最多 31 天），不替没记录的日子现挑（不写库、不全表扫）；
//   那句被删了或改成私密了 → 那天不出。今天这句照旧走 /api/today（会锁定）。
//   不给 from / to：默认今天往前 13 天到今天。
//   返回 {ok:true, today, days:[{day, quote}]}（新→旧；quote 同 /api/today 的公开字段：id/text/trans/author/source/source_type/tags）。
// 错误：400 bad-day（格式不对 / from 晚于 to / 超过 31 天）；405。
import { json, err, methodNotAllowed } from './_lib.js';
import { ensureSchema, dayInShanghai } from './_quotes.js';
import { publicQuote } from './_today.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
export const MAX_SPAN = 31;
export const DEFAULT_BACK = 13;

/** 'YYYY-MM-DD' 加 n 天（UTC 算，不受时区影响） @param {string} day @param {number} n */
export function addDays(day, n) {
  const t = Date.parse(day + 'T00:00:00Z') + n * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}
/** 合法的日历日期（2026-02-30 这种不算） */
export function validDay(s) {
  return typeof s === 'string' && DAY_RE.test(s) && new Date(Date.parse(s + 'T00:00:00Z')).toISOString().slice(0, 10) === s;
}
/**
 * 查询参数 → 要查的区间 {from, to}；不合法返回 null。to 截到今天；默认今天往前 13 天。
 * @param {URLSearchParams} sp @param {string} today
 */
export function rangeOf(sp, today) {
  const f = sp.get('from'), t = sp.get('to');
  let to = t === null ? today : t;
  if (!validDay(to)) return null;
  if (to > today) to = today;
  const from = f === null ? addDays(to, -DEFAULT_BACK) : f;
  if (!validDay(from) || from > to) return null;
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > MAX_SPAN) return null;
  return { from, to };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const today = dayInShanghai(Date.now());
  const r = rangeOf(new URL(request.url).searchParams, today);
  if (!r) return err('bad-day', 400);
  const db = env.D1_QUOTES;
  await ensureSchema(db);
  const { results } = await db.prepare(
    "SELECT p.day AS day, q.id, q.text, q.trans, q.author, q.source, q.source_type, q.tags, q.visibility, q.created_at, q.updated_at " +
    "FROM daily_pick p JOIN quotes q ON q.id = p.quote_id WHERE p.day >= ?1 AND p.day <= ?2 AND q.visibility = 'public' ORDER BY p.day DESC"
  ).bind(r.from, r.to).all();
  const days = (results || []).map((row) => ({ day: row.day, quote: publicQuote(row) }));
  return json({ ok: true, today, days });
}

export function onRequest() {
  return methodNotAllowed('GET');
}
