/**
 * @fileoverview Cloudflare 账号用量（2026-10-22 PR3）：每小时一次（Cron "41 * * * *"，见 wrangler.toml / src/index.js），
 * 用一把只读 API token 读 Cloudflare API，存一份最新快照进 D1（表 usage，migrations/0002_usage.sql），
 * /summary 带上它给状态页「用量」卡片。
 *
 * 钥匙（仓库里不写任何值）：
 *   CF_USAGE_TOKEN  Secrets Store 绑定（wrangler.toml [[secrets_store_secrets]]，store 同鉴权网关，
 *                   secret_name = "SGX_CF_USAGE_TOKEN"），代码里 `await env.CF_USAGE_TOKEN.get()`；
 *                   测试 / 本地也可以直接是字符串。只读 API token，权限（全部是 Account 级、Read）：
 *                     Account Analytics Read      ← GraphQL：Workers 请求数、R2 存储、KV 存储
 *                     D1 Read                     ← D1 库列表 + 每个库的 file_size
 *                     Workers R2 Storage Read     ← R2 存储桶列表（桶数）
 *                     Workers KV Storage Read     ← KV 命名空间列表（命名空间数、名字）
 *   CF_ACCOUNT_ID   账号 id：普通 Worker secret（`wrangler secret put CF_ACCOUNT_ID`），也接受 Secrets Store 绑定。
 * 没绑定 / 值为空 → 不请求、不写库；/summary 里 usage = null、usage_reason = 'not-configured'。
 * 绑定在但 store 里没有这条 secret（get() 抛错）→ usage_reason = 'secret-missing'。
 * 数据来源（2026-10-22 对过 Cloudflare 文档）：
 *   D1   GET /accounts/{id}/d1/database（列表：uuid / name，不含大小）
 *        GET /accounts/{id}/d1/database/{uuid} → result.file_size（字节）
 *        https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/get/
 *   R2   GraphQL r2StorageAdaptiveGroups：max { payloadSize metadataSize objectCount }，dimensions { bucketName datetime }
 *        https://developers.cloudflare.com/r2/platform/metrics-analytics/
 *        GET /accounts/{id}/r2/buckets → result.buckets[]（桶数）
 *   KV   GraphQL kvStorageAdaptiveGroups：max { byteCount keyCount }，dimensions { namespaceId date }
 *        https://developers.cloudflare.com/kv/observability/metrics-analytics/
 *        GET /accounts/{id}/storage/kv/namespaces → result[]（命名空间数；GraphQL 拿不到时至少有这个）
 *   Workers 请求  GraphQL workersInvocationsAdaptive：sum { requests }，今天 UTC 00:00 起（免费额度按 UTC 零点重置）
 *        https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
 * 每一项单独请求、单独失败：某一项拿不到只把那一项记成 null + 原因，其他照常；全都失败才算这一轮失败。
 * 子请求：D1 列表 1 + 每库 1（免费最多 10 个库）+ R2 列表 1 + KV 列表 1 + GraphQL 3 ≈ 16，免费上限 50。
 */

/**
 * 免费额度（2026-10-22 对过 Cloudflare 文档）。字节按十进制（1 GB = 10^9 B），和文档写法一致。
 *   Workers：100,000 次请求 / 天，UTC 零点重置 — https://developers.cloudflare.com/workers/platform/limits/#daily-requests
 *   D1：账号合计 5 GB，单库 500 MB（Free）— https://developers.cloudflare.com/d1/platform/limits/
 *   R2：10 GB-month / 月（Standard）— https://developers.cloudflare.com/r2/pricing/#free-tier
 *   KV：账号 1 GB 存储（Free）— https://developers.cloudflare.com/kv/platform/limits/
 */
export const FREE_LIMITS = Object.freeze({
  workersRequestsPerDay: 100000,
  d1TotalBytes: 5 * 1e9,
  d1PerDbBytes: 500 * 1e6,
  r2Bytes: 10 * 1e9,
  kvBytes: 1 * 1e9,
});

/** 用量的 Cron（和 wrangler.toml 的 triggers.crons 第二条一致；index.js 靠它分流） */
export const USAGE_CRON = '41 * * * *';

export const CF_API = 'https://api.cloudflare.com/client/v4';
export const REQ_TIMEOUT_MS = 15000;

const DAY_MS = 24 * 3600 * 1000;

/**
 * 读一个钥匙：Secrets Store 绑定（有 get()）→ await get()；字符串 → 原样；都不是 → ''。
 * get() 抛错（store 里没这条 / 没权限）→ 抛 Error('secret-missing')。
 * @param {any} v
 */
async function readSecret(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v.get === 'function') {
    let x;
    try { x = await v.get(); } catch { throw new Error('secret-missing'); }
    return typeof x === 'string' ? x.trim() : '';
  }
  return '';
}

/**
 * token + 账号 id。不抛错：{ token, account } 或 { reason: 'not-configured' | 'secret-missing' }。
 * @param {any} env
 */
export async function usageCreds(env) {
  try {
    const token = await readSecret(env && env.CF_USAGE_TOKEN);
    const account = await readSecret(env && env.CF_ACCOUNT_ID);
    if (!token || !account) return { token: '', account: '', reason: 'not-configured' };
    return { token, account, reason: null };
  } catch (e) {
    return { token: '', account: '', reason: 'secret-missing' };
  }
}

/** 一个 Cloudflare API 请求：带 token、超时、解 JSON；不成功抛 Error(原因短码) */
async function cfFetch(doFetch, token, url, init = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
  let res;
  try {
    res = await doFetch(url, {
      ...init,
      signal: ctl.signal,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers || {}) },
    });
  } catch (e) {
    throw new Error(ctl.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    try { await res.body?.cancel(); } catch {}
    throw new Error('http-' + res.status);
  }
  let j;
  try { j = await res.json(); } catch { throw new Error('bad-json'); }
  return j;
}

/** REST：{ success, result } */
async function rest(doFetch, token, url) {
  const j = await cfFetch(doFetch, token, url);
  if (!j || j.success === false) throw new Error('api');
  return j;
}

/** GraphQL：{ data, errors }；有 errors 就算失败（错误文本不外露，只记短码） */
async function gql(doFetch, token, query, variables) {
  const j = await cfFetch(doFetch, token, CF_API + '/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });
  if (!j || (Array.isArray(j.errors) && j.errors.length)) throw new Error('graphql');
  const acc = j.data && j.data.viewer && Array.isArray(j.data.viewer.accounts) ? j.data.viewer.accounts[0] : null;
  if (!acc) throw new Error('graphql');
  return acc;
}

export const Q_WORKERS = `query U($accountTag: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    workersInvocationsAdaptive(limit: 1, filter: { datetime_geq: $start, datetime_leq: $end }) { sum { requests } }
  } }
}`;

export const Q_R2 = `query U($accountTag: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    r2StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }, orderBy: [datetime_DESC]) {
      max { objectCount payloadSize metadataSize }
      dimensions { bucketName datetime }
    }
  } }
}`;

export const Q_KV = `query U($accountTag: string!, $start: Date!, $end: Date!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    kvStorageAdaptiveGroups(limit: 10000, filter: { date_geq: $start, date_leq: $end }, orderBy: [date_DESC]) {
      max { keyCount byteCount }
      dimensions { namespaceId date }
    }
  } }
}`;

/** 按 key 取每组最新的一行（rows 已按时间新 → 旧；保险起见再按 tkey 比一次） */
function latestBy(rows, key, tkey) {
  /** @type {Map<string, any>} */
  const m = new Map();
  for (const r of rows || []) {
    const d = (r && r.dimensions) || {};
    const k = d[key];
    if (k == null) continue;
    const prev = m.get(k);
    if (!prev || String(d[tkey]) > String(prev.dimensions[tkey])) m.set(k, r);
  }
  return [...m.values()];
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Workers 今天（UTC）全账号请求数 */
export async function collectWorkers(doFetch, token, account, now) {
  const dayStart = new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z';
  const acc = await gql(doFetch, token, Q_WORKERS, { accountTag: account, start: dayStart, end: new Date(now).toISOString() });
  const rows = acc.workersInvocationsAdaptive || [];
  const requests = rows.reduce((a, r) => a + num(r && r.sum && r.sum.requests), 0);
  return { requests, limit: FREE_LIMITS.workersRequestsPerDay, day: dayStart.slice(0, 10) };
}

/** D1：每个库的大小 + 合计 */
export async function collectD1(doFetch, token, account) {
  const base = CF_API + '/accounts/' + encodeURIComponent(account) + '/d1/database';
  const list = await rest(doFetch, token, base);
  const dbs = Array.isArray(list.result) ? list.result.filter((d) => d && d.uuid) : [];
  const details = await Promise.all(dbs.map(async (d) => {
    const j = await rest(doFetch, token, base + '/' + encodeURIComponent(d.uuid));
    const r = j.result || {};
    /* 只留名字和大小：uuid 不往页面上送 */
    return { name: String(r.name || d.name || 'd1'), bytes: num(r.file_size) };
  }));
  details.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  return {
    total_bytes: details.reduce((a, d) => a + d.bytes, 0),
    limit_bytes: FREE_LIMITS.d1TotalBytes,
    per_db_limit_bytes: FREE_LIMITS.d1PerDbBytes,
    databases: details,
  };
}

/** R2：全部桶的存储字节（对象 + 元数据）和对象数；桶数来自 REST 列表（失败不影响前两项） */
export async function collectR2(doFetch, token, account, now) {
  const [acc, buckets] = await Promise.all([
    gql(doFetch, token, Q_R2, { accountTag: account, start: new Date(now - DAY_MS).toISOString(), end: new Date(now).toISOString() }),
    rest(doFetch, token, CF_API + '/accounts/' + encodeURIComponent(account) + '/r2/buckets?per_page=1000')
      .then((j) => (j.result && Array.isArray(j.result.buckets) ? j.result.buckets.length : null))
      .catch(() => null),
  ]);
  const latest = latestBy(acc.r2StorageAdaptiveGroups, 'bucketName', 'datetime');
  let bytes = 0;
  let objects = 0;
  for (const r of latest) {
    const m = r.max || {};
    bytes += num(m.payloadSize) + num(m.metadataSize);
    objects += num(m.objectCount);
  }
  return { bytes, objects, buckets: buckets == null ? latest.length : buckets, limit_bytes: FREE_LIMITS.r2Bytes };
}

/**
 * KV：全部命名空间的存储字节和键数（GraphQL kvStorageAdaptiveGroups，按天的数据，取最近两天里每个命名空间最新一天）；
 * 命名空间数来自 REST 列表。GraphQL 失败但列表成功 → bytes / keys = null，只给命名空间数（kv.error 记原因）。
 */
export async function collectKV(doFetch, token, account, now) {
  const end = new Date(now).toISOString().slice(0, 10);
  const start = new Date(now - DAY_MS).toISOString().slice(0, 10);
  const [g, list] = await Promise.allSettled([
    gql(doFetch, token, Q_KV, { accountTag: account, start, end }),
    rest(doFetch, token, CF_API + '/accounts/' + encodeURIComponent(account) + '/storage/kv/namespaces?per_page=1000'),
  ]);
  if (g.status === 'rejected' && list.status === 'rejected') throw g.reason;
  const namespaces = list.status === 'fulfilled' && Array.isArray(list.value.result) ? list.value.result.length : null;
  if (g.status === 'rejected') {
    return { bytes: null, keys: null, namespaces, limit_bytes: FREE_LIMITS.kvBytes, error: String(g.reason && g.reason.message || 'api') };
  }
  const latest = latestBy(g.value.kvStorageAdaptiveGroups, 'namespaceId', 'date');
  let bytes = 0;
  let keys = 0;
  for (const r of latest) {
    const m = r.max || {};
    bytes += num(m.byteCount);
    keys += num(m.keyCount);
  }
  return { bytes, keys, namespaces: namespaces == null ? latest.length : namespaces, limit_bytes: FREE_LIMITS.kvBytes };
}

/**
 * 收一轮用量。不抛错：
 *   没配 → { ok:false, reason:'not-configured' | 'secret-missing' }（不请求）
 *   全部失败 → { ok:false, reason:'api-error', errors }
 *   至少一项成功 → { ok:true, snapshot:{ fetched_at, workers, d1, r2, kv, errors } }（失败的那项 = null，errors 里记短码）
 * @param {any} env
 * @param {number} now
 * @param {typeof fetch} [doFetch]
 */
export async function collectUsage(env, now, doFetch = fetch) {
  const { token, account, reason } = await usageCreds(env);
  if (reason) return { ok: false, reason };
  const parts = /** @type {const} */ (['workers', 'd1', 'r2', 'kv']);
  const res = await Promise.allSettled([
    collectWorkers(doFetch, token, account, now),
    collectD1(doFetch, token, account),
    collectR2(doFetch, token, account, now),
    collectKV(doFetch, token, account, now),
  ]);
  /** @type {Record<string, any>} */
  const snapshot = { fetched_at: now };
  /** @type {Record<string, string>} */
  const errors = {};
  res.forEach((r, i) => {
    const k = parts[i];
    if (r.status === 'fulfilled') snapshot[k] = r.value;
    else {
      snapshot[k] = null;
      errors[k] = String((r.reason && r.reason.message) || 'error').slice(0, 40);
    }
  });
  snapshot.errors = errors;
  if (parts.every((k) => snapshot[k] == null)) return { ok: false, reason: 'api-error', errors };
  return { ok: true, snapshot };
}

/**
 * 写库：成功 → 覆盖快照（data、fetched_at）并清掉 last_error；失败 → 只记 last_error / last_attempt_at，旧快照留着。
 * not-configured / secret-missing 不写（没配就别动库；readUsage 每次现查钥匙，原因直接给页面）。
 * @param {D1Database} db
 * @param {Awaited<ReturnType<typeof collectUsage>>} r
 * @param {number} now
 */
export async function persistUsage(db, r, now) {
  if (!r.ok && (r.reason === 'not-configured' || r.reason === 'secret-missing')) return;
  if (r.ok) {
    await db.prepare(
      'INSERT INTO usage (id, fetched_at, data, last_attempt_at, last_error) VALUES (1, ?, ?, ?, NULL) ' +
      'ON CONFLICT (id) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data, last_attempt_at = excluded.last_attempt_at, last_error = NULL',
    ).bind(r.snapshot.fetched_at, JSON.stringify(r.snapshot), now).run();
  } else {
    await db.prepare(
      'INSERT INTO usage (id, fetched_at, data, last_attempt_at, last_error) VALUES (1, NULL, NULL, ?, ?) ' +
      'ON CONFLICT (id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error',
    ).bind(now, r.reason).run();
  }
}

/** Cron 入口：收一轮 → 写库 */
export async function runUsage(env, now, doFetch = fetch) {
  const r = await collectUsage(env, now, doFetch);
  await persistUsage(env.STATUS_DB, r, now);
  if (!r.ok) console.warn('[status] usage', r.reason, r.errors ? JSON.stringify(r.errors) : '');
  return r;
}

/**
 * 给 /summary 的用量部分。永不抛错（读失败也只是 usage = null）。
 *   没配 token / 账号 → { usage:null, usage_reason:'not-configured' }（就算库里有旧快照也不给：钥匙撤了就别再显示）
 *   绑定在但 store 里没这条 secret → { usage:null, usage_reason:'secret-missing' }
 *   库里没有成功过的快照 → { usage:null, usage_reason: last_error || 'not-collected' }
 *   有快照 → { usage: 快照（含 fetched_at），usage_reason: null }；最近一次失败了 → usage.stale = true、usage.last_error（快照照给，页面按 fetched_at 显示多久前）
 *   表不存在（迁移没跑）/ 库出错 → { usage:null, usage_reason:'db' }
 * @param {D1Database} db
 * @param {any} env
 */
export async function readUsage(db, env) {
  const { reason } = await usageCreds(env);
  if (reason) return { usage: null, usage_reason: reason };
  try {
    const row = await db.prepare('SELECT fetched_at, data, last_attempt_at, last_error FROM usage WHERE id = 1').first();
    if (!row || !row.data) return { usage: null, usage_reason: (row && row.last_error) || 'not-collected' };
    const data = JSON.parse(String(row.data));
    data.fetched_at = Number(row.fetched_at) || Number(data.fetched_at) || 0;
    if (row.last_error) {
      data.stale = true;
      data.last_error = String(row.last_error);
    }
    return { usage: data, usage_reason: null };
  } catch (e) {
    console.error('[status] usage read failed', e && /** @type {any} */ (e).message);
    return { usage: null, usage_reason: 'db' };
  }
}
