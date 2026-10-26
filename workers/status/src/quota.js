/**
 * @fileoverview 今天的免费额度用量（2026-10-27）：Workers 请求、KV 读 / 写 / 删 / 列、D1 读写行数（按 UTC 日），R2 A / B 类操作（按月）。
 *
 * 和 src/usage.js 的区别：usage.js 每小时 41 分收「存储量」快照（D1 / R2 / KV 占了多少字节）；
 * 这里是「操作次数」，免费计划按天卡（超了就报错：KV 写 429、D1 拒绝查询、Workers 1027），一小时一收太慢，
 * 所以改成按需：/summary 被请求时，缓存超过 QUOTA_TTL_MS（5 分钟）才去问 Cloudflare GraphQL，结果存 D1 表 quota（migrations/0004_quota.sql）。
 * 状态页开着时每 60 秒刷新一次 /api/status，最多每 5 分钟真正查一轮（5 个 GraphQL 请求）；没人看就一次都不查，不占 Cron。
 * 不用 Cache API：这个 Worker 没有自定义域名 / 路由（只从网关服务绑定进来），文档只保证挂在自定义域名上的 Worker 缓存可用
 * （https://developers.cloudflare.com/workers/runtime-apis/cache/）；D1 一行缓存每次只多读 1 行、每 5 分钟最多写 1 行。
 *
 * 钥匙：和 usage.js 同一把只读 token（Secrets Store 的 SGX_CF_USAGE_TOKEN + Worker secret CF_ACCOUNT_ID，见 wrangler.toml），
 * GraphQL Analytics API 只需要其中的 Account → Account Analytics → Read
 * （https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/）。
 *
 * 数据集（GraphQL https://api.cloudflare.com/client/v4/graphql，2026-10-27 对过文档）：
 *   Workers 请求   workersInvocationsAdaptive · sum { requests } · datetime 今天 UTC 00:00 起（同 usage.js Q_WORKERS）
 *   Pages Functions pagesFunctionsInvocationsAdaptiveGroups · sum { requests } · date = 今天
 *                  免费计划里 Pages Functions 请求和 Workers 请求合计 10 万 / 天（https://developers.cloudflare.com/pages/functions/pricing/），
 *                  网关就是 Pages Functions，所以必须一起算
 *   KV            kvOperationsAdaptiveGroups · sum { requests } · dimensions { actionType } · date = 今天
 *                  actionType：read / write / delete / list（https://developers.cloudflare.com/kv/observability/metrics-analytics/；
 *                  原 scripts/kv-budget.mjs 预算闸同一个查询，PR #223 前在 CI 里跑过）
 *   D1            d1AnalyticsAdaptiveGroups · sum { rowsRead rowsWritten } · date = 今天（https://developers.cloudflare.com/d1/observability/metrics-analytics/）
 *   R2            r2OperationsAdaptiveGroups · sum { requests } · dimensions { actionType } · datetime 本月 1 日 UTC 00:00 起
 *                  （https://developers.cloudflare.com/r2/platform/metrics-analytics/），actionType 按 R2_CLASS_A / R2_CLASS_B 归类
 * 每个数据集单独请求、单独失败：某一项拿不到只把那一项记成 null + 原因短码，其他照常；全都失败才算这一轮失败。
 */
import { gql, usageCreds } from './usage.js';

/**
 * 免费计划额度（2026-10-27 对过 Cloudflare 文档）。
 *   Workers：100,000 请求 / 天（含 Pages Functions），UTC 零点重置 — https://developers.cloudflare.com/workers/platform/limits/#daily-requests
 *   KV：读 100,000、写 1,000、删 1,000、列 1,000 / 天，各算各的，UTC 零点重置 — https://developers.cloudflare.com/kv/platform/pricing/
 *   D1：读 5,000,000 行、写 100,000 行 / 天，UTC 零点重置 — https://developers.cloudflare.com/d1/platform/pricing/
 *   R2：A 类 1,000,000、B 类 10,000,000 / 月（只算 Standard 存储）— https://developers.cloudflare.com/r2/pricing/#free-tier
 */
export const QUOTA_LIMITS = Object.freeze({
  workersRequests: 100000,
  kv: Object.freeze({ read: 100000, write: 1000, delete: 1000, list: 1000 }),
  d1: Object.freeze({ rows_read: 5000000, rows_written: 100000 }),
  r2: Object.freeze({ class_a: 1000000, class_b: 10000000 }),
});

/** R2 操作分类（https://developers.cloudflare.com/r2/pricing/ Class A / Class B / Free operations） */
export const R2_CLASS_A = Object.freeze([
  'ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload',
  'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart', 'UploadPartCopy', 'ListParts',
  'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration',
]);
export const R2_CLASS_B = Object.freeze([
  'HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors',
  'GetBucketLifecycleConfiguration',
]);
export const R2_FREE = Object.freeze(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload']);

/** 缓存多久（毫秒）：这之内不管成功失败都不再问 Cloudflare */
export const QUOTA_TTL_MS = 5 * 60 * 1000;
/** 一轮查询最多等多久：/summary 是同步等的，超过就按「这一项超时」处理，页面照常出 */
export const QUOTA_DEADLINE_MS = 6000;

export const Q_Q_WORKERS = `query QuotaWorkers($accountTag: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) { sum { requests } }
  } }
}`;

export const Q_Q_PAGES = `query QuotaPages($accountTag: string!, $day: Date!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    pagesFunctionsInvocationsAdaptiveGroups(limit: 10000, filter: { date_geq: $day, date_leq: $day }) { sum { requests } }
  } }
}`;

export const Q_Q_KV = `query QuotaKv($accountTag: string!, $day: Date!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    kvOperationsAdaptiveGroups(limit: 10000, filter: { date_geq: $day, date_leq: $day }) { sum { requests } dimensions { actionType } }
  } }
}`;

export const Q_Q_D1 = `query QuotaD1($accountTag: string!, $day: Date!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $day, date_leq: $day }) { sum { rowsRead rowsWritten } }
  } }
}`;

export const Q_Q_R2 = `query QuotaR2($accountTag: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) { sum { requests } dimensions { actionType } }
  } }
}`;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** @param {any} rows @param {(r:any)=>any} pick */
const sumOf = (rows, pick) => (Array.isArray(rows) ? rows : []).reduce((a, r) => a + num(pick(r || {})), 0);

/** UTC 日 / 月 / 时间窗 @param {number} now */
export function quotaWindow(now) {
  const iso = new Date(now).toISOString();
  const day = iso.slice(0, 10);
  const month = iso.slice(0, 7);
  return { day, month, dayStart: day + 'T00:00:00Z', monthStart: month + '-01T00:00:00Z', end: iso };
}

/** 超时兜底：promise 在 ms 内没结果 → Error('timeout') */
function within(p, ms) {
  let timer;
  return Promise.race([
    p,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * 查一轮。不抛错：{ ok:true, snapshot } | { ok:false, reason:'api-error', errors }。
 * snapshot = { fetched_at, day, month,
 *   workers: { requests, workers, pages|null, limit } | null      （Workers 拿到、Pages 没拿到 → pages=null、errors.pages 记原因）
 *   kv: { read, write, delete, list, other, limits } | null
 *   d1: { rows_read, rows_written, limits } | null
 *   r2: { class_a, class_b, free, other, since, limits } | null
 *   errors: { [part]: code } }
 * @param {string} token @param {string} account @param {number} now @param {typeof fetch} doFetch
 */
export async function collectQuota(token, account, now, doFetch = fetch) {
  const w = quotaWindow(now);
  const q = (/** @type {string} */ query, /** @type {any} */ vars) =>
    within(gql(doFetch, token, query, { accountTag: account, ...vars }), QUOTA_DEADLINE_MS);
  const [wk, pg, kv, d1, r2] = await Promise.allSettled([
    q(Q_Q_WORKERS, { start: w.dayStart, end: w.end }),
    q(Q_Q_PAGES, { day: w.day }),
    q(Q_Q_KV, { day: w.day }),
    q(Q_Q_D1, { day: w.day }),
    q(Q_Q_R2, { start: w.monthStart, end: w.end }),
  ]);
  /** @type {Record<string, string>} */
  const errors = {};
  const why = (/** @type {PromiseRejectedResult} */ r) => String((r.reason && r.reason.message) || 'error').slice(0, 40);
  /** @type {Record<string, any>} */
  const snapshot = { fetched_at: now, day: w.day, month: w.month };

  if (wk.status === 'fulfilled') {
    const workers = sumOf(wk.value.workersInvocationsAdaptive, (r) => r.sum && r.sum.requests);
    const pages = pg.status === 'fulfilled' ? sumOf(pg.value.pagesFunctionsInvocationsAdaptiveGroups, (r) => r.sum && r.sum.requests) : null;
    if (pg.status === 'rejected') errors.pages = why(pg);
    snapshot.workers = { requests: workers + (pages || 0), workers, pages, limit: QUOTA_LIMITS.workersRequests };
  } else {
    errors.workers = why(wk);
    if (pg.status === 'rejected') errors.pages = why(pg);
    snapshot.workers = null;
  }

  if (kv.status === 'fulfilled') {
    const out = { read: 0, write: 0, delete: 0, list: 0, other: 0, limits: QUOTA_LIMITS.kv };
    for (const r of kv.value.kvOperationsAdaptiveGroups || []) {
      const t = String((r && r.dimensions && r.dimensions.actionType) || '').toLowerCase();
      const n = num(r && r.sum && r.sum.requests);
      if (t === 'read' || t === 'write' || t === 'delete' || t === 'list') out[t] += n;
      else out.other += n;
    }
    snapshot.kv = out;
  } else {
    errors.kv = why(kv);
    snapshot.kv = null;
  }

  if (d1.status === 'fulfilled') {
    const rows = d1.value.d1AnalyticsAdaptiveGroups;
    snapshot.d1 = {
      rows_read: sumOf(rows, (r) => r.sum && r.sum.rowsRead),
      rows_written: sumOf(rows, (r) => r.sum && r.sum.rowsWritten),
      limits: QUOTA_LIMITS.d1,
    };
  } else {
    errors.d1 = why(d1);
    snapshot.d1 = null;
  }

  if (r2.status === 'fulfilled') {
    const out = { class_a: 0, class_b: 0, free: 0, other: 0, since: w.monthStart.slice(0, 10), limits: QUOTA_LIMITS.r2 };
    for (const r of r2.value.r2OperationsAdaptiveGroups || []) {
      const t = String((r && r.dimensions && r.dimensions.actionType) || '');
      const n = num(r && r.sum && r.sum.requests);
      if (R2_CLASS_A.includes(t)) out.class_a += n;
      else if (R2_CLASS_B.includes(t)) out.class_b += n;
      else if (R2_FREE.includes(t)) out.free += n;
      else out.other += n;
    }
    snapshot.r2 = out;
  } else {
    errors.r2 = why(r2);
    snapshot.r2 = null;
  }

  snapshot.errors = errors;
  if (['workers', 'kv', 'd1', 'r2'].every((k) => snapshot[k] == null)) return { ok: false, reason: 'api-error', errors };
  return { ok: true, snapshot };
}

/**
 * 给 /summary 的额度部分。永不抛错。
 *   没配 token / 账号 → { quota:null, quota_reason:'not-configured' | 'secret-missing' }（不碰库、不碰网络）
 *   表不存在 / 库出错 → { quota:null, quota_reason:'db' }（不去查 Cloudflare：没地方缓存就不查，免得每分钟打一轮）
 *   缓存 5 分钟内（按最近一次尝试算，成功失败都算）→ 直接给缓存
 *   否则查一轮：成功 → 写库、给新数据；失败 → 记 last_error，旧数据是今天（UTC）的就照给并标 stale，不是今天的 → quota:null、quota_reason:'api-error'
 *   旧数据不是今天（UTC 日已经换了）→ 不给（昨天的用量不能当今天的显示）
 * @param {D1Database|undefined} db  env.D1_CLOUDFLARE_USAGE（同库，表 quota）
 * @param {any} env
 * @param {number} now
 * @param {typeof fetch} [doFetch]
 */
export async function readQuota(db, env, now, doFetch = fetch) {
  const { token, account, reason } = await usageCreds(env);
  if (reason) return { quota: null, quota_reason: reason };
  if (!db) return { quota: null, quota_reason: 'db' };
  let row;
  try {
    row = await db.prepare('SELECT fetched_at, data, last_attempt_at, last_error FROM quota WHERE id = 1').first();
  } catch (e) {
    console.error('[status] quota read failed', e && /** @type {any} */ (e).message);
    return { quota: null, quota_reason: 'db' };
  }
  const today = quotaWindow(now).day;
  /** @param {any} r */
  const fromRow = (r) => {
    if (!r || !r.data) return { quota: null, quota_reason: (r && r.last_error) || 'api-error' };
    let data;
    try { data = JSON.parse(String(r.data)); } catch { return { quota: null, quota_reason: 'db' }; }
    if (!data || data.day !== today) return { quota: null, quota_reason: (r.last_error) || 'api-error' };
    data.fetched_at = Number(r.fetched_at) || Number(data.fetched_at) || 0;
    if (r.last_error) {
      data.stale = true;
      data.last_error = String(r.last_error);
    }
    return { quota: data, quota_reason: null };
  };
  const age = row && row.last_attempt_at != null ? now - Number(row.last_attempt_at) : Infinity;
  if (age >= 0 && age < QUOTA_TTL_MS) {
    const cached = fromRow(row);
    /* 缓存的是昨天（UTC）的：跨零点后第一次请求立刻重查，不等 5 分钟 */
    if (cached.quota || !(row && row.data) || row.last_error) return cached;
  }
  const r = await collectQuota(token, account, now, doFetch);
  try {
    if (r.ok) {
      await db.prepare(
        'INSERT INTO quota (id, fetched_at, data, last_attempt_at, last_error) VALUES (1, ?, ?, ?, NULL) ' +
        'ON CONFLICT (id) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data, last_attempt_at = excluded.last_attempt_at, last_error = NULL',
      ).bind(now, JSON.stringify(r.snapshot), now).run();
    } else {
      await db.prepare(
        'INSERT INTO quota (id, fetched_at, data, last_attempt_at, last_error) VALUES (1, NULL, NULL, ?, ?) ' +
        'ON CONFLICT (id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error',
      ).bind(now, r.reason).run();
    }
  } catch (e) {
    console.error('[status] quota write failed', e && /** @type {any} */ (e).message);
    return { quota: null, quota_reason: 'db' };
  }
  if (r.ok) return { quota: { ...r.snapshot }, quota_reason: null };
  console.warn('[status] quota', r.reason, JSON.stringify(r.errors));
  return fromRow({ ...(row || {}), last_error: r.reason });
}
