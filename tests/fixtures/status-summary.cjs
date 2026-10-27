/**
 * 服务状态（/account/status/）测试用的 /api/status 假数据（形状 = workers/status/src/monitor.js summary）。
 * tests/web/e2e/account-status.spec.js（Playwright mock）和 tests/web/ui/status-view.test.mjs（单测）共用。
 *
 * 时间对齐 tests/web/e2e/helpers.js freezeTime：2026-10-09 12:00 北京时间（04:00Z）。
 * 每站有 40 天数据（条的左边 50 格是「无数据」），今天是半天（720 次检查）。
 *   normal()  全部正常；两条已恢复的故障（博客 12 天前 25 分钟 HTTP 502、日刻 20 天前 2 小时超时）
 *   oneDown() 奇趣（curio）当前故障：连续 7 次超时，开着一条 7 分钟前开始的故障
 *   empty()   Worker 刚上线：5 个站都还没检查过
 *   usage()   用量快照（PR3，形状 = workers/status/src/usage.js collectUsage）：18 分钟前收的；
 *             Workers 73,456 / 100,000（73.5% 琥珀）、D1 合计 483.4 MB / 5 GB（styrigx-status 468 MB / 500 MB = 93.6% 红）、
 *             R2 2.01 GB / 10 GB、KV 5.3 MB / 1 GB
 *   withUsage(data, usage, reason)  给任意一份汇总加上 usage / usage_reason（usage = null 时 reason 默认 not-configured）
 *   quota()   今天的免费额度（2026-10-27，形状 = workers/status/src/quota.js collectQuota）：3 分钟前查的；
 *             Workers+Pages 82,000 / 100,000（82% 琥珀）、KV 写 960 / 1,000（96% 红）、其余低于 80%
 *   withQuota(data, quota, reason)  加上 quota / quota_reason（quota = null 时 reason 默认 api-error）
 *   视觉基线（visual.spec.js）不用 quota：没有 quota 字段 = 旧版 Worker，额度块不显示，基线不变。
 * normal() / oneDown() / empty() 本身不带 usage 字段（= 旧版 Worker，页面按「用量未配置」处理）。
 */
const NOW = Date.parse('2026-10-09T04:00:00Z');
const DAY = 24 * 3600 * 1000;
const MIN = 60 * 1000;
const TODAY = '2026-10-09';

const SITES = [
  { site: 'space', zh: '主站', en: 'Home', url: 'https://styrigx.com/', ms: 123 },
  { site: 'blog', zh: '博客', en: 'Blog', url: 'https://blog.styrigx.com/robots.txt', ms: 88 },
  { site: 'daymark', zh: '日刻', en: 'Daymark', url: 'https://daymark.styrigx.com/robots.txt', ms: 95 },
  { site: 'curio', zh: '奇趣', en: 'Curio', url: 'https://curio.styrigx.com/robots.txt', ms: 140 },
  { site: 'proxy-rules', zh: '规则集', en: 'Proxy rules', url: 'https://proxy-rules.styrigx.com/healthz', ms: 61 },
];

/** @param {string} day @param {number} n */
function addDays(day, n) {
  return new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
}

/** 每站 40 天：大部分满分；博客 12 天前少 25 次（部分故障）、日刻 20 天前少 120 次（低于 95% = 故障日） */
function days(site, ms, todayOk = 720) {
  const out = [];
  for (let i = 39; i >= 0; i--) {
    const day = addDays(TODAY, -i);
    const total = i === 0 ? 720 : 1440;
    let ok = total;
    if (site === 'blog' && i === 12) ok = 1415;
    if (site === 'daymark' && i === 20) ok = 1320;
    if (i === 0) ok = todayOk;
    out.push({ day, total, ok, avg_ms: ok ? ms + (i % 5) : null });
  }
  return out;
}

function pct(ok, total) {
  return total ? Math.round((ok / total) * 10000) / 100 : null;
}

function site(t, over = {}) {
  const d = over.days || days(t.site, t.ms);
  const [ok90, tot90] = d.reduce((a, x) => [a[0] + x.ok, a[1] + x.total], [0, 0]);
  const base = {
    site: t.site, zh: t.zh, en: t.en, url: t.url,
    checked: true, up: true, fails: 0,
    last: { at: NOW - 40 * 1000, ok: true, code: 200, ms: t.ms, err: null },
    uptime: { h24: 100, d30: pct(ok90, tot90), d90: pct(ok90, tot90) },
    days: d,
    recent: [],
  };
  return Object.assign(base, over, { days: d });
}

const INC_RESOLVED = [
  { id: 2, site: 'blog', started_at: NOW - 12 * DAY - 3 * 3600 * 1000, ended_at: NOW - 12 * DAY - 3 * 3600 * 1000 + 25 * MIN, cause: 'HTTP 502' },
  { id: 1, site: 'daymark', started_at: NOW - 20 * DAY + 2 * 3600 * 1000, ended_at: NOW - 20 * DAY + 4 * 3600 * 1000, cause: 'timeout' },
];

function normal() {
  return { ok: true, now: NOW, today: TODAY, all_up: true, sites: SITES.map((t) => site(t)), incidents: INC_RESOLVED.slice() };
}

function oneDown() {
  const sites = SITES.map((t) => (t.site === 'curio'
    ? site(t, {
      up: false, fails: 7,
      last: { at: NOW - 40 * 1000, ok: false, code: 0, ms: 10000, err: 'timeout' },
      uptime: { h24: 99.51, d30: 99.98, d90: 99.98 },
      days: days('curio', t.ms, 713),
    })
    : site(t)));
  return {
    ok: true, now: NOW, today: TODAY, all_up: false, sites,
    incidents: [{ id: 3, site: 'curio', started_at: NOW - 7 * MIN, ended_at: null, cause: 'timeout' }, ...INC_RESOLVED],
  };
}

function empty() {
  return {
    ok: true, now: NOW, today: TODAY, all_up: true,
    sites: SITES.map((t) => ({ site: t.site, zh: t.zh, en: t.en, url: t.url, checked: false, up: null, fails: 0, last: null, uptime: { h24: null, d30: null, d90: null }, days: [], recent: [] })),
    incidents: [],
  };
}

function usage(over = {}) {
  return Object.assign({
    fetched_at: NOW - 18 * MIN,
    workers: { requests: 73456, limit: 100000, day: '2026-10-09' },
    d1: {
      total_bytes: 483400000, limit_bytes: 5e9, per_db_limit_bytes: 5e8,
      databases: [
        { name: 'styrigx-status', bytes: 468000000 },
        { name: 'styrigx-auth', bytes: 12000000 },
        { name: 'styrigx-sgx', bytes: 3400000 },
      ],
    },
    r2: { bytes: 2010000000, objects: 1234, buckets: 2, limit_bytes: 1e10 },
    kv: { bytes: 5300000, keys: 420, namespaces: 3, limit_bytes: 1e9 },
    errors: {},
  }, over);
}

function withUsage(data, u, reason) {
  return Object.assign(data, { usage: u, usage_reason: u ? null : (reason || 'not-configured') });
}

function quota(over = {}) {
  return Object.assign({
    fetched_at: NOW - 3 * MIN,
    day: '2026-10-09',
    month: '2026-10',
    workers: { requests: 82000, workers: 2000, pages: 80000, limit: 100000 },
    kv: { read: 42000, write: 960, delete: 12, list: 3, other: 0, limits: { read: 100000, write: 1000, delete: 1000, list: 1000 } },
    d1: { rows_read: 1200000, rows_written: 4200, limits: { rows_read: 5000000, rows_written: 100000 } },
    r2: { class_a: 1000, class_b: 55000, free: 40, other: 0, since: '2026-10-01', limits: { class_a: 1000000, class_b: 10000000 } },
    errors: {},
  }, over);
}

function withQuota(data, q, reason) {
  return Object.assign(data, { quota: q, quota_reason: q ? null : (reason || 'api-error') });
}

module.exports = { NOW, TODAY, DAY, MIN, normal, oneDown, empty, usage, withUsage, quota, withQuota };
