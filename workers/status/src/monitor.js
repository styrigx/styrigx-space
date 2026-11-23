/**
 * @fileoverview 监测的核心逻辑：发请求、根据上一轮状态算出这一轮要写什么（纯函数，好测）、写进 D1、读汇总。
 */
import { TARGETS, TIMEOUT_MS, FAIL_THRESHOLD, KEEP_MS, siteOf } from './targets.js';
import { readUsage } from './usage.js';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CN_OFFSET_MS = 8 * 3600 * 1000; // 北京时间，没有夏令时

/** 北京时间日期 YYYY-MM-DD @param {number} ms */
export function dayOf(ms) {
  return new Date(ms + CN_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 检查一个地址。不跟随跳转（跳转本身就算结果），10 秒超时。
 * @param {{site:string,url:string,expect:number[]}} t
 * @param {typeof fetch|null} [doFetch]  null = 服务绑定没配，直接记 err = 'binding'
 * @returns {Promise<{site:string, ok:boolean, code:number, ms:number, err:string|null}>}
 */
export async function checkOne(t, doFetch = fetch, now = () => Date.now()) {
  if (doFetch === null) return { site: t.site, ok: false, code: 0, ms: 0, err: 'binding' };
  if (t.rpc) return pingOne(t, /** @type {any} */ (doFetch), now);
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
 * rpc 目标（P4 R-07）：服务绑定命名入口的 ping()。回 {ok:true} 记 200；回别的记 code 0 / err 'status'；10 秒超时。
 * @param {{site:string}} t @param {{ping:()=>Promise<any>}} svc @param {() => number} now
 */
export async function pingOne(t, svc, now = () => Date.now()) {
  const t0 = now();
  /** @type {any} */
  let timer;
  const timeout = new Promise((res) => { timer = setTimeout(() => res('timeout'), TIMEOUT_MS); });
  try {
    const r = await Promise.race([svc.ping(), timeout]);
    if (r === 'timeout') return { site: t.site, ok: false, code: 0, ms: TIMEOUT_MS, err: 'timeout' };
    const ms = Math.max(0, now() - t0);
    const ok = !!(r && r.ok);
    return { site: t.site, ok, code: ok ? 200 : 0, ms, err: ok ? null : 'status' };
  } catch (e) {
    return { site: t.site, ok: false, code: 0, ms: Math.max(0, now() - t0), err: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 根据上一轮状态和这一轮结果算出要写的东西。
 * D-2 方案 C（2026-11-15）：一轮全部结果写 status_minute 一行；status_state 只在连续失败数或首次失败时间变了才写；
 * status_hourly / status_daily 不再每分钟写，改由整点汇总（aggregate）从 status_minute 算。
 * @param {Map<string, {fails:number, open:{id:number}|null, firstFailAt:number}>} prev  每站：连续失败次数、开着的故障、这一串失败的第一次时间
 * @param {Array<{site:string, ok:boolean, code:number, ms:number, err:string|null}>} results
 * @param {number} at
 */
export function plan(prev, results, at) {
  const out = { minute: { at, data: [] }, state: [], open: [], close: [] };
  for (const r of results) {
    const p = prev.get(r.site) || { fails: 0, open: null, firstFailAt: 0 };
    const fails = r.ok ? 0 : p.fails + 1;
    /* 这一串失败的第一次：成功清零；第一次失败记这一轮；之后沿用 */
    const firstFail = r.ok ? 0 : (fails > 1 && p.firstFailAt ? p.firstFailAt : at);
    out.minute.data.push({ s: r.site, ok: r.ok ? 1 : 0, code: r.code, ms: r.ms, err: r.err });
    if (fails !== p.fails || firstFail !== (p.firstFailAt || 0)) out.state.push({ site: r.site, fails, first_fail_at: firstFail });
    if (!r.ok && fails >= FAIL_THRESHOLD && !p.open) {
      /* 故障从这一串的第一次失败算起 */
      const started = firstFail;
      out.open.push({ site: r.site, started_at: started, cause: r.err === 'status' ? 'HTTP ' + r.code : r.err });
    }
    if (r.ok && p.open) out.close.push({ id: p.open.id, ended_at: at });
  }
  return out;
}

/**
 * 读上一轮状态。只读 state（每站一行）和开着的故障，不碰 checks——
 * 每分钟跑一次，扫 checks 会把 D1 免费额度（500 万行读取 / 天）吃光（2026-10-23）。
 * @param {D1Database} db
 */
export async function loadPrev(db) {
  const [st, open] = await db.batch([
    db.prepare('SELECT site, fails, first_fail_at FROM status_state'),
    db.prepare('SELECT id, site FROM status_incidents WHERE ended_at IS NULL'),
  ]);
  /** @type {Map<string, {fails:number, open:{id:number}|null, firstFailAt:number}>} */
  const m = new Map();
  for (const t of TARGETS) m.set(t.site, { fails: 0, open: null, firstFailAt: 0 });
  for (const r of st.results || []) {
    if (!m.has(r.site)) continue;
    m.get(r.site).fails = Number(r.fails) || 0;
    m.get(r.site).firstFailAt = Number(r.first_fail_at) || 0;
  }
  /* 改名前开着的故障记在旧名下：并进现名，让这一轮能把它关掉（targets.js formerly） */
  for (const r of open.results || []) if (m.has(siteOf(r.site))) m.get(siteOf(r.site)).open = { id: Number(r.id) };
  return m;
}

/**
 * 把 plan() 的结果写进 D1（一个 batch，原子）。
 * @param {D1Database} db
 * @param {ReturnType<typeof plan>} p
 * @param {{prune?: number}} [opt] prune：删掉早于这个时间的原始记录
 */
export async function persist(db, p) {
  const st = [db.prepare('INSERT OR REPLACE INTO status_minute (at, data) VALUES (?, ?)').bind(p.minute.at, JSON.stringify(p.minute.data))];
  for (const x of p.state) {
    st.push(db.prepare(
      'INSERT INTO status_state (site, fails, first_fail_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT (site) DO UPDATE SET fails = excluded.fails, first_fail_at = excluded.first_fail_at',
    ).bind(x.site, x.fails, x.first_fail_at));
  }
  for (const o of p.open) {
    st.push(db.prepare('INSERT INTO status_incidents (site, started_at, cause) VALUES (?, ?, ?)').bind(o.site, o.started_at, o.cause));
  }
  for (const c of p.close) {
    st.push(db.prepare('UPDATE status_incidents SET ended_at = ? WHERE id = ? AND ended_at IS NULL').bind(c.ended_at, c.id));
  }
  await db.batch(st);
}

/** status_minute 一行的 data → [{site, ok, code, ms, err}]（坏行回空） @param {string} data */
export function parseMinute(data) {
  try {
    const a = JSON.parse(data);
    return Array.isArray(a) ? a.filter((x) => x && x.s).map((x) => ({ site: String(x.s), ok: Number(x.ok) ? 1 : 0, code: Number(x.code) || 0, ms: Number(x.ms) || 0, err: x.err || null })) : [];
  } catch { return []; }
}

/**
 * 把一批 status_minute 行按 (站, 整点) 汇总。 @param {Array<{at:number, data:string}>} rows
 * @returns {Map<string, {site:string, hour:number, total:number, ok_count:number, ms_sum:number}>}
 */
export function rollup(rows) {
  const m = new Map();
  for (const r of rows) {
    const hour = Math.floor(Number(r.at) / HOUR_MS) * HOUR_MS;
    for (const c of parseMinute(r.data)) {
      const k = c.site + '|' + hour;
      const v = m.get(k) || { site: c.site, hour, total: 0, ok_count: 0, ms_sum: 0 };
      v.total += 1; v.ok_count += c.ok; v.ms_sum += c.ok ? c.ms : 0;
      m.set(k, v);
    }
  }
  return m;
}

/**
 * 整点汇总（D-2 C，随 "41 * * * *" 那轮跑）：最近 3 个**已结束**的整点小时，从 status_minute 汇总进 status_hourly（已有就跳过，
 * 漏跑一两轮能补上），新写进去的小时再累加进 status_daily（北京日）。顺带清理：status_minute 7 天前、status_hourly 2 天前（旧表 status_checks 已由迁移 0003 删除）。
 * @param {D1Database} db @param {number} at
 */
export async function aggregate(db, at) {
  const cur = Math.floor(at / HOUR_MS) * HOUR_MS;
  const from = cur - 3 * HOUR_MS;
  const res = await db.prepare('SELECT at, data FROM status_minute WHERE at >= ? AND at < ? ORDER BY at').bind(from, cur).all();
  const groups = [...rollup(res.results || []).values()];
  const st = [];
  for (const g of groups) {
    st.push(db.prepare('INSERT INTO status_hourly (site, hour, total, ok_count, ms_sum) VALUES (?, ?, ?, ?, ?) ON CONFLICT (site, hour) DO NOTHING RETURNING site, hour')
      .bind(g.site, g.hour, g.total, g.ok_count, g.ms_sum));
  }
  const fresh = new Set();
  if (st.length) {
    const out = await db.batch(st);
    for (const r of out) for (const x of (r && r.results) || []) fresh.add(x.site + '|' + Number(x.hour));
  }
  const st2 = [];
  for (const g of groups) {
    if (!fresh.has(g.site + '|' + g.hour)) continue;
    st2.push(db.prepare(
      'INSERT INTO status_daily (site, day, total, ok_count, ms_sum) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT (site, day) DO UPDATE SET total = total + excluded.total, ok_count = ok_count + excluded.ok_count, ms_sum = ms_sum + excluded.ms_sum',
    ).bind(g.site, dayOf(g.hour), g.total, g.ok_count, g.ms_sum));
  }
  st2.push(db.prepare('DELETE FROM status_minute WHERE at < ?').bind(at - KEEP_MS));
  st2.push(db.prepare('DELETE FROM status_hourly WHERE hour < ?').bind(at - 2 * DAY_MS));
  await db.batch(st2);
  return { hours: fresh.size };
}

/**
 * 这个地址用哪个 fetch：公开地址用 doFetch；带 binding 的走 env 里的服务绑定（没配 → null）。
 * @param {{binding?:string}} t @param {any} env @param {typeof fetch} doFetch
 * @returns {typeof fetch|null}
 */
export function fetcherFor(t, env, doFetch) {
  if (t.rpc) {
    const svc = env && env[t.rpc];
    return svc && typeof svc.ping === 'function' ? /** @type {any} */ (svc) : null;
  }
  if (!t.binding) return doFetch;
  const svc = env && env[t.binding];
  if (!svc || typeof svc.fetch !== 'function') return null;
  return /** @type {typeof fetch} */ ((u, init) => svc.fetch(u, init));
}

/**
 * 跑一轮：检查全部地址 → 写库（一行 status_minute；清理在整点汇总里做）。
 * @param {any} env
 * @param {number} at  这一轮的时间（Cron 的 scheduledTime）
 * @param {typeof fetch} [doFetch]
 */
export async function runOnce(env, at, doFetch = fetch) {
  const db = env.D1_UPTIME_MONITOR;
  const [prev, results] = await Promise.all([loadPrev(db), Promise.all(TARGETS.map((t) => checkOne(t, fetcherFor(t, env, doFetch))))]);
  const p = plan(prev, results, at);
  await persist(db, p);
  return p;
}

/**
 * 给监测页的汇总。
 *   sites：每站当前状态（up = 连续失败没到阈值）、近 24 小时 / 30 天 / 90 天可用率
 *   days：每站最近 90 天每日 { day, total, ok, avg_ms }（旧 → 新）
 *   recent：每站最近 24 小时每小时一格 [整点, 这小时全成功 ? 1 : 0, 成功的平均耗时]（来自 status_hourly 表，不读 status_checks）
 *   incidents：最近 20 条故障（新 → 旧，开着的 ended_at = null）
 *   usage / usage_reason：Cloudflare 用量快照（src/usage.js readUsage；读不到只是 usage = null + 原因，不影响其余部分）
 * @param {D1Database} db  D1_UPTIME_MONITOR（state / daily / hourly / incidents）
 * @param {number} now
 * @param {any} [env]  读 SGX_CF_USAGE_TOKEN / CF_ACCOUNT_ID 是否配置，用量快照从 env.D1_CLOUDFLARE_USAGE 读；不传 = 没配
 */
export async function summary(db, now, env) {
  const since24 = Math.floor((now - DAY_MS) / HOUR_MS) * HOUR_MS;
  const from90 = dayOf(now - 89 * DAY_MS);
  const [st, days, recent, inc, mins] = await db.batch([
    db.prepare('SELECT site, fails FROM status_state'),
    db.prepare('SELECT site, day, total, ok_count, ms_sum FROM status_daily WHERE day >= ? ORDER BY day').bind(from90),
    db.prepare('SELECT site, hour, total, ok_count, ms_sum FROM status_hourly WHERE hour >= ? ORDER BY hour').bind(since24),
    db.prepare('SELECT id, site, started_at, ended_at, cause FROM status_incidents ORDER BY started_at DESC LIMIT 20'),
    /* 还没汇总进 status_hourly 的分钟（最多约 2 小时 41 分）：补进 recent / 24h，最新一行给 last */
    db.prepare('SELECT at, data FROM status_minute WHERE at >= ? ORDER BY at').bind(Math.floor(now / HOUR_MS) * HOUR_MS - 3 * HOUR_MS),
  ]);
  /* 改名（targets.js formerly）：旧名的历史行并进现名；同一天 / 同一小时新旧两行相加，state 只认现名那行 */
  const merge = (rows, key) => {
    /** @type {Map<string, any>} */
    const m = new Map();
    for (const r of rows || []) {
      const x = { ...r, site: siteOf(r.site) };
      const k = x.site + '|' + x[key];
      const y = m.get(k);
      if (y) { y.total = Number(y.total) + Number(x.total); y.ok_count = Number(y.ok_count) + Number(x.ok_count); y.ms_sum = Number(y.ms_sum) + Number(x.ms_sum); } else m.set(k, x);
    }
    return [...m.values()];
  };
  days.results = merge(days.results, 'day');
  recent.results = merge(recent.results, 'hour');
  inc.results = (inc.results || []).map((r) => ({ ...r, site: siteOf(r.site) }));
  const minRows = mins.results || [];
  const lastRow = minRows.length ? minRows[minRows.length - 1] : null;
  /** @type {Map<string, any>} */
  const lastBy = new Map();
  if (lastRow) for (const c of parseMinute(lastRow.data)) lastBy.set(siteOf(c.site), { at: Number(lastRow.at), ok: !!c.ok, code: c.code, ms: c.ms, err: c.err });
  const haveHour = new Set((recent.results || []).map((x) => x.site + '|' + Number(x.hour)));
  const pending = merge([...rollup(minRows).values()], 'hour').filter((g) => g.hour >= since24 && !haveHour.has(g.site + '|' + g.hour));
  recent.results = [...(recent.results || []), ...pending].sort((a, b) => Number(a.hour) - Number(b.hour));
  const by = (rows, site) => (rows.results || []).filter((r) => r.site === site);
  const pct = (ok, total) => (total ? Math.round((ok / total) * 10000) / 100 : null);
  const today = dayOf(now);
  const from30 = dayOf(now - 29 * DAY_MS);
  const sites = TARGETS.map((t) => {
    const s = by(st, t.site)[0] || null;
    const d = by(days, t.site);
    const r = by(recent, t.site);
    const sum = (rows, from) => rows.filter((x) => x.day >= from).reduce((a, x) => [a[0] + x.ok_count, a[1] + x.total], [0, 0]);
    const ok24 = r.reduce((a, x) => a + Number(x.ok_count), 0);
    const tot24 = r.reduce((a, x) => a + Number(x.total), 0);
    const [ok30, tot30] = sum(d, from30);
    const [ok90, tot90] = sum(d, from90);
    return {
      site: t.site, name: t.name, url: t.url,
      checked: lastBy.has(t.site) || !!s,
      up: lastBy.has(t.site) || s ? Number(s ? s.fails : 0) < FAIL_THRESHOLD : null,
      fails: s ? Number(s.fails) : 0,
      last: lastBy.get(t.site) || null,
      uptime: { h24: pct(ok24, tot24), d30: pct(ok30, tot30), d90: pct(ok90, tot90) },
      days: d.map((x) => ({ day: x.day, total: x.total, ok: x.ok_count, avg_ms: x.ok_count ? Math.round(x.ms_sum / x.ok_count) : null })),
      recent: r.map((x) => [Number(x.hour), Number(x.ok_count) === Number(x.total) ? 1 : 0,
        Number(x.ok_count) ? Math.round(Number(x.ms_sum) / Number(x.ok_count)) : 0]),
    };
  });
  const u = await readUsage(env && env.D1_CLOUDFLARE_USAGE, env); /* status_usage 表是另一套数据：单独一条查询，不进上面的 batch */
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
