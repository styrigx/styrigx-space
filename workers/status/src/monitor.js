/**
 * @fileoverview 监测的核心逻辑：发请求、根据上一轮状态算出这一轮要写什么（纯函数，好测）、写进 D1、读汇总。
 */
import { TARGETS, TIMEOUT_MS, FAIL_THRESHOLD, KEEP_MS } from './targets.js';
import { readUsage } from './usage.js';

const DAY_MS = 24 * 3600 * 1000;
const CN_OFFSET_MS = 8 * 3600 * 1000; // 北京时间，没有夏令时

/** 北京时间日期 YYYY-MM-DD @param {number} ms */
export function dayOf(ms) {
  return new Date(ms + CN_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 检查一个地址。不跟随跳转（跳转本身就算结果），10 秒超时。
 * @param {{site:string,url:string,expect:number[]}} t
 * @param {typeof fetch} [doFetch]
 * @returns {Promise<{site:string, ok:boolean, code:number, ms:number, err:string|null}>}
 */
export async function checkOne(t, doFetch = fetch, now = () => Date.now()) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const t0 = now();
  try {
    const res = await doFetch(t.url, {
      method: 'GET',
      redirect: 'manual',
      signal: ctl.signal,
      headers: { 'User-Agent': 'styrigx-status/1 (+https://styrigx.com)', 'Cache-Control': 'no-cache' },
    });
    const ms = Math.max(0, now() - t0);
    try { await res.body?.cancel(); } catch {}
    const ok = t.expect.includes(res.status);
    return { site: t.site, ok, code: res.status, ms, err: ok ? null : 'status' };
  } catch (e) {
    const aborted = ctl.signal.aborted || (e && /** @type {any} */ (e).name === 'AbortError');
    return { site: t.site, ok: false, code: 0, ms: aborted ? TIMEOUT_MS : Math.max(0, now() - t0), err: aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 根据上一轮状态和这一轮结果算出要写的东西。
 * @param {Map<string, {fails:number, open:{id:number}|null, firstFailAt:number}>} prev  每站：连续失败次数、开着的故障、这一串失败的第一次时间
 * @param {Array<{site:string, ok:boolean, code:number, ms:number, err:string|null}>} results
 * @param {number} at
 */
export function plan(prev, results, at) {
  const day = dayOf(at);
  const out = { checks: [], daily: [], state: [], open: [], close: [] };
  for (const r of results) {
    const p = prev.get(r.site) || { fails: 0, open: null, firstFailAt: 0 };
    const fails = r.ok ? 0 : p.fails + 1;
    out.checks.push({ site: r.site, at, ok: r.ok ? 1 : 0, code: r.code, ms: r.ms, err: r.err });
    out.daily.push({ site: r.site, day, ok: r.ok ? 1 : 0, ms: r.ok ? r.ms : 0 });
    out.state.push({ site: r.site, fails, at, ok: r.ok ? 1 : 0, code: r.code, ms: r.ms, err: r.err });
    if (!r.ok && fails >= FAIL_THRESHOLD && !p.open) {
      /* 故障从这一串的第一次失败算起 */
      const started = p.firstFailAt && fails > 1 ? p.firstFailAt : at;
      out.open.push({ site: r.site, started_at: started, cause: r.err === 'status' ? 'HTTP ' + r.code : r.err });
    }
    if (r.ok && p.open) out.close.push({ id: p.open.id, ended_at: at });
  }
  return out;
}

/**
 * 读上一轮状态。
 * @param {D1Database} db
 */
export async function loadPrev(db) {
  const [st, open, firsts] = await db.batch([
    db.prepare('SELECT site, fails FROM state'),
    db.prepare('SELECT id, site FROM incidents WHERE ended_at IS NULL'),
    /* 这一串失败的第一次：每站最近一次成功之后最早的失败 */
    db.prepare(
      'SELECT c.site AS site, MIN(c.at) AS first FROM checks c ' +
      'WHERE c.ok = 0 AND c.at > COALESCE((SELECT MAX(at) FROM checks o WHERE o.site = c.site AND o.ok = 1), 0) ' +
      'GROUP BY c.site',
    ),
  ]);
  /** @type {Map<string, {fails:number, open:{id:number}|null, firstFailAt:number}>} */
  const m = new Map();
  for (const t of TARGETS) m.set(t.site, { fails: 0, open: null, firstFailAt: 0 });
  for (const r of st.results || []) if (m.has(r.site)) m.get(r.site).fails = Number(r.fails) || 0;
  for (const r of open.results || []) if (m.has(r.site)) m.get(r.site).open = { id: Number(r.id) };
  for (const r of firsts.results || []) if (m.has(r.site)) m.get(r.site).firstFailAt = Number(r.first) || 0;
  return m;
}

/**
 * 把 plan() 的结果写进 D1（一个 batch，原子）。
 * @param {D1Database} db
 * @param {ReturnType<typeof plan>} p
 * @param {{prune?: number}} [opt] prune：删掉早于这个时间的原始记录
 */
export async function persist(db, p, opt = {}) {
  const st = [];
  for (const c of p.checks) {
    st.push(db.prepare('INSERT INTO checks (site, at, ok, code, ms, err) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(c.site, c.at, c.ok, c.code, c.ms, c.err));
  }
  for (const d of p.daily) {
    st.push(db.prepare(
      'INSERT INTO daily (site, day, total, ok_count, ms_sum) VALUES (?, ?, 1, ?, ?) ' +
      'ON CONFLICT (site, day) DO UPDATE SET total = total + 1, ok_count = ok_count + excluded.ok_count, ms_sum = ms_sum + excluded.ms_sum',
    ).bind(d.site, d.day, d.ok, d.ms));
  }
  for (const s of p.state) {
    st.push(db.prepare(
      'INSERT INTO state (site, fails, last_at, last_ok, last_code, last_ms, last_err) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT (site) DO UPDATE SET fails = excluded.fails, last_at = excluded.last_at, last_ok = excluded.last_ok, ' +
      'last_code = excluded.last_code, last_ms = excluded.last_ms, last_err = excluded.last_err',
    ).bind(s.site, s.fails, s.at, s.ok, s.code, s.ms, s.err));
  }
  for (const o of p.open) {
    st.push(db.prepare('INSERT INTO incidents (site, started_at, cause) VALUES (?, ?, ?)').bind(o.site, o.started_at, o.cause));
  }
  for (const c of p.close) {
    st.push(db.prepare('UPDATE incidents SET ended_at = ? WHERE id = ? AND ended_at IS NULL').bind(c.ended_at, c.id));
  }
  if (opt.prune) st.push(db.prepare('DELETE FROM checks WHERE at < ?').bind(opt.prune));
  if (st.length) await db.batch(st);
}

/**
 * 跑一轮：检查全部地址 → 写库。整点顺带清掉 7 天前的原始记录。
 * @param {any} env
 * @param {number} at  这一轮的时间（Cron 的 scheduledTime）
 * @param {typeof fetch} [doFetch]
 */
export async function runOnce(env, at, doFetch = fetch) {
  const db = env.STATUS_DB;
  const [prev, results] = await Promise.all([loadPrev(db), Promise.all(TARGETS.map((t) => checkOne(t, doFetch)))]);
  const p = plan(prev, results, at);
  const minute = Math.floor(at / 60000) % 60;
  await persist(db, p, minute === 0 ? { prune: at - KEEP_MS } : {});
  return p;
}

/**
 * 给监测页的汇总。
 *   sites：每站当前状态（up = 连续失败没到阈值）、近 24 小时 / 30 天 / 90 天可用率
 *   days：每站最近 90 天每日 { day, total, ok, avg_ms }（旧 → 新）
 *   recent：每站最近 24 小时每次检查 [at, ok, ms]（画响应时间用）
 *   incidents：最近 20 条故障（新 → 旧，开着的 ended_at = null）
 *   usage / usage_reason：Cloudflare 用量快照（src/usage.js readUsage；读不到只是 usage = null + 原因，不影响其余部分）
 * @param {D1Database} db
 * @param {number} now
 * @param {any} [env]  读 CF_USAGE_TOKEN / CF_ACCOUNT_ID 是否配置；不传 = 没配
 */
export async function summary(db, now, env) {
  const since24 = now - DAY_MS;
  const from90 = dayOf(now - 89 * DAY_MS);
  const [st, days, recent, inc] = await db.batch([
    db.prepare('SELECT site, fails, last_at, last_ok, last_code, last_ms, last_err FROM state'),
    db.prepare('SELECT site, day, total, ok_count, ms_sum FROM daily WHERE day >= ? ORDER BY day').bind(from90),
    db.prepare('SELECT site, at, ok, ms FROM checks WHERE at >= ? ORDER BY at').bind(since24),
    db.prepare('SELECT id, site, started_at, ended_at, cause FROM incidents ORDER BY started_at DESC LIMIT 20'),
  ]);
  const by = (rows, site) => (rows.results || []).filter((r) => r.site === site);
  const pct = (ok, total) => (total ? Math.round((ok / total) * 10000) / 100 : null);
  const today = dayOf(now);
  const from30 = dayOf(now - 29 * DAY_MS);
  const sites = TARGETS.map((t) => {
    const s = by(st, t.site)[0] || null;
    const d = by(days, t.site);
    const r = by(recent, t.site);
    const sum = (rows, from) => rows.filter((x) => x.day >= from).reduce((a, x) => [a[0] + x.ok_count, a[1] + x.total], [0, 0]);
    const ok24 = r.filter((x) => x.ok).length;
    const [ok30, tot30] = sum(d, from30);
    const [ok90, tot90] = sum(d, from90);
    return {
      site: t.site, zh: t.zh, en: t.en, url: t.url,
      checked: !!s,
      up: s ? Number(s.fails) < FAIL_THRESHOLD : null,
      fails: s ? Number(s.fails) : 0,
      last: s ? { at: Number(s.last_at), ok: !!s.last_ok, code: Number(s.last_code), ms: Number(s.last_ms), err: s.last_err || null } : null,
      uptime: { h24: pct(ok24, r.length), d30: pct(ok30, tot30), d90: pct(ok90, tot90) },
      days: d.map((x) => ({ day: x.day, total: x.total, ok: x.ok_count, avg_ms: x.ok_count ? Math.round(x.ms_sum / x.ok_count) : null })),
      recent: r.map((x) => [Number(x.at), x.ok ? 1 : 0, Number(x.ms)]),
    };
  });
  const u = await readUsage(db, env);
  return {
    ok: true,
    now,
    today,
    all_up: sites.every((s) => s.up !== false),
    sites,
    usage: u.usage,
    usage_reason: u.usage_reason,
    incidents: (inc.results || []).map((x) => ({
      id: Number(x.id), site: x.site, started_at: Number(x.started_at),
      ended_at: x.ended_at == null ? null : Number(x.ended_at), cause: x.cause,
    })),
  };
}
