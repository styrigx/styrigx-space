#!/usr/bin/env node
/**
 * @fileoverview 部署后健康闸门第二阶段（2026-10-28）：读 styrigx-status 每分钟巡检写进 D1 的结果，
 * 只认「部署之后」跑的巡检，有失败就让 job 红（触发回滚）。
 *
 * 为什么要它：search（styrigx-search-index）和 chat（styrigx-chat）没有公开地址，第一阶段只能核对
 * 「线上换成了新版本」（deploy-rollback.mjs worker-verify），测不到新代码能不能用。styrigx-status 每分钟经服务绑定
 * 测它们的 GET /healthz，结果进 D1 styrigx-status 的 checks 表（workers/status/src/monitor.js persist）。
 * 本脚本在 deploy.yml 的 deploy-status-worker 里、status 部署并核对之后跑，等新一轮巡检，按结果判定。
 * 不经网关、不开免会话口子、不加 Worker / 子域名：直接用 D1 REST 查表，token 是 status 部署本来就有的那把
 * （STYRIGX_STATUS_DEPLOY，D1 编辑；同一把 token 部署时已经在跑 d1 migrations apply --remote，走的是同一个查询接口）。
 *
 * 判定（judge）：只看 at > 部署时刻（since）的巡检。每个站：
 *   - 还没有新巡检 → pending（继续等）
 *   - 最近一次成功 → pass
 *   - 末尾连续失败 >= confirm 次（默认 2，躲开单次网络抖动）→ fail；失败原因全是 err = 'binding'（status 自己没配好绑定）→ binding
 *   - 末尾失败但还没到 confirm 次 → pending（等下一轮确认）
 *   部署前就在失败（--baseline-until 之前最近一次巡检是失败，比如 chat 没配钥匙、/healthz 一直 503）→ 新巡检失败也只打 warning，
 *   不算这次部署弄坏的，不回滚它（preexisting）。
 * 结果（$GITHUB_OUTPUT）：
 *   verdict = pass     全部通过 → 退出码 0
 *           = fail     有站确认失败（failed = 站名，逗号分隔）→ 退出码 1；deploy.yml 据此回滚对应 Worker
 *           = binding  失败全是 status 自己的绑定问题 → 退出码 1；只回滚 status（job 自己的回滚步骤），不动 search / chat
 *           = timeout  等到超时还有站没出结论（巡检没跑 / 查不到）→ 退出码 1；同上只回滚 status（巡检不跑说明 status 自己有问题）
 *           = error    D1 REST 鉴权失败（401 / 403）等不会自己好的错误 → 退出码 1，不等
 *
 * 用法（仓库根目录）：
 *   node scripts/health-gate.mjs --sites search,chat [--since <毫秒>] [--settle 15] [--timeout 300] [--interval 15]
 *                                [--confirm 2] [--baseline-until <毫秒>[,<毫秒>...]]
 *   --since 不给 = 现在 + settle 秒（给刚部署的版本留传播时间）；--baseline-until 给多个取最小（最早开始部署的那个 job）。
 * 环境变量：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID（同 status 部署那一步）；CF_API_BASE（默认 https://api.cloudflare.com/client/v4，测试用）。
 * 库 id 从 workers/status/wrangler.toml 的 D1_UPTIME_MONITOR 读，不在这里重复写。本脚本不打印 token。
 * D1 读取量：每次轮询只按 checks_at 索引读部署之后的几行（每轮 7 行），5 分钟内最多二十来次。
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { d1DatabaseId } from './kv-budget.mjs';
import { TARGETS } from '../workers/status/src/targets.js';

const DEFAULT_API = 'https://api.cloudflare.com/client/v4';
/** 部署前基线往回看多久（巡检每分钟一轮，10 分钟足够拿到最近一次） */
export const BASELINE_WINDOW_MS = 10 * 60 * 1000;
export const DEFAULTS = Object.freeze({ settle: 15, timeout: 300, interval: 15, confirm: 2 });

/** 站名只许小写字母、数字、连字符（会进 SQL 参数和日志） @param {string} s */
export function isSafeSite(s) {
  return typeof s === 'string' && /^[a-z0-9-]{1,32}$/.test(s);
}

/**
 * 每个站最近一次巡检是不是失败（基线：部署前）。
 * @param {Array<{site:string, at:number, ok:number}>} rows
 * @returns {Set<string>} 部署前最近一次是失败的站
 */
export function failingBefore(rows) {
  /** @type {Map<string, {at:number, ok:number}>} */
  const last = new Map();
  for (const r of rows || []) {
    const p = last.get(r.site);
    if (!p || Number(r.at) >= p.at) last.set(r.site, { at: Number(r.at), ok: Number(r.ok) });
  }
  return new Set([...last].filter(([, v]) => !v.ok).map(([k]) => k));
}

/**
 * 按部署之后的巡检判定。
 * @param {Array<{site:string, at:number, ok:number, code?:number, err?:string|null}>} rows  at > since 的 checks 行
 * @param {string[]} sites  要把关的站
 * @param {{confirm?: number, preexisting?: Set<string>}} [opt]
 * @returns {{verdict: 'pass'|'fail'|'binding'|'pending', failed: string[], perSite: Record<string, string>}}
 *   perSite 每站：pending / pass / fail / binding / preexisting
 */
export function judge(rows, sites, opt = {}) {
  const confirm = Math.max(1, Number(opt.confirm) || DEFAULTS.confirm);
  const pre = opt.preexisting || new Set();
  /** @type {Record<string, string>} */
  const perSite = {};
  for (const site of sites) {
    const mine = (rows || []).filter((r) => r.site === site).sort((a, b) => Number(a.at) - Number(b.at));
    if (!mine.length) { perSite[site] = 'pending'; continue; }
    if (Number(mine[mine.length - 1].ok)) { perSite[site] = 'pass'; continue; }
    let k = 0;
    while (k < mine.length && !Number(mine[mine.length - 1 - k].ok)) k++;
    if (k < confirm) { perSite[site] = 'pending'; continue; }
    const tail = mine.slice(mine.length - k);
    if (tail.every((r) => r.err === 'binding')) perSite[site] = 'binding';
    else perSite[site] = pre.has(site) ? 'preexisting' : 'fail';
  }
  const vals = Object.values(perSite);
  const failed = sites.filter((s) => perSite[s] === 'fail');
  let verdict = 'pass';
  if (vals.includes('pending')) verdict = 'pending';
  else if (failed.length) verdict = 'fail';
  else if (vals.includes('binding')) verdict = 'binding';
  return { verdict: /** @type {any} */ (verdict), failed, perSite };
}

/**
 * D1 REST 查询（POST /accounts/<id>/d1/database/<库>/query，带参数）。不抛：{ ok, rows, status, fatal, reason }。
 * fatal = 不会自己好的错误（401 / 403 / 404），不必再等。
 * @param {{sql: string, params: any[]}} q
 * @param {{account: string, token: string, database: string, api?: string, fetch?: typeof fetch}} cfg
 */
export async function d1Query(q, cfg) {
  const f = cfg.fetch || fetch;
  const url = (cfg.api || DEFAULT_API).replace(/\/+$/, '') + '/accounts/' + cfg.account + '/d1/database/' + cfg.database + '/query';
  let res;
  try {
    res = await f(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: q.sql, params: q.params }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { ok: false, rows: [], status: 0, fatal: false, reason: 'network: ' + String((e && /** @type {any} */ (e).message) || e).slice(0, 200) };
  }
  let body = null;
  try { body = await res.json(); } catch {}
  if (res.status !== 200 || !body || !body.success) {
    const msg = JSON.stringify((body && body.errors) || []).slice(0, 300);
    return { ok: false, rows: [], status: res.status, fatal: [401, 403, 404].includes(res.status), reason: 'HTTP ' + res.status + ' ' + msg };
  }
  const first = Array.isArray(body.result) ? body.result[0] : null;
  return { ok: true, rows: (first && Array.isArray(first.results)) ? first.results : [], status: 200, fatal: false, reason: 'ok' };
}

/** checks 里这些站、at 在 (from, to] 的行（走 checks_at 索引）。to = null 表示不设上限。 @param {string[]} sites @param {number} from @param {number|null} to */
export function checksQuery(sites, from, to) {
  const marks = sites.map(() => '?').join(', ');
  const sql = 'SELECT site, at, ok, code, err FROM checks WHERE at > ?' + (to == null ? '' : ' AND at <= ?') +
    ' AND site IN (' + marks + ') ORDER BY at';
  return { sql, params: [from, ...(to == null ? [] : [to]), ...sites] };
}

/**
 * 等巡检出结论。
 * @param {{
 *   sites: string[], since: number, baselineUntil?: number|null, timeoutMs: number, intervalMs: number, confirm: number,
 *   query: (q: {sql:string, params:any[]}) => Promise<{ok:boolean, rows:any[], fatal?:boolean, reason:string}>,
 *   now?: () => number, sleep?: (ms: number) => Promise<void>, log?: (s: string) => void,
 * }} o
 * @returns {Promise<{verdict: 'pass'|'fail'|'binding'|'timeout'|'error', failed: string[], perSite: Record<string,string>}>}
 */
export async function waitForHealth(o) {
  const now = o.now || Date.now;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = o.log || ((s) => process.stdout.write(s + '\n'));
  /* 部署前基线：拿不到只打 warning，按「部署前都正常」处理（更严） */
  let preexisting = new Set();
  if (o.baselineUntil) {
    const b = await o.query(checksQuery(o.sites, o.baselineUntil - BASELINE_WINDOW_MS, o.baselineUntil));
    if (b.ok) preexisting = failingBefore(b.rows);
    else log('::warning::health gate: could not read the pre-deploy baseline (' + b.reason + '); treating every site as healthy before the deploy');
    for (const s of preexisting) log('::warning::health gate: ' + s + ' was already failing before this deploy; a failure now will not roll it back');
  }
  const deadline = now() + o.timeoutMs;
  let last = { verdict: 'pending', failed: [], perSite: Object.fromEntries(o.sites.map((s) => [s, 'pending'])) };
  let lastReason = '';
  for (;;) {
    const r = await o.query(checksQuery(o.sites, o.since, null));
    if (r.ok) {
      last = judge(r.rows, o.sites, { confirm: o.confirm, preexisting });
      log('health gate: ' + o.sites.map((s) => s + '=' + last.perSite[s]).join(' ') + ' (' + r.rows.length + ' checks since ' + new Date(o.since).toISOString() + ')');
      if (last.verdict !== 'pending') return /** @type {any} */ (last);
    } else {
      lastReason = r.reason;
      if (r.fatal) {
        log('::error::health gate: D1 query failed (' + r.reason + '); the status deploy token needs D1 access to styrigx-status');
        return { verdict: 'error', failed: [], perSite: last.perSite };
      }
      log('::warning::health gate: D1 query failed, retrying (' + r.reason + ')');
    }
    if (now() + o.intervalMs > deadline) break;
    await sleep(o.intervalMs);
  }
  /* 超时：已经确认失败的照样回滚；剩下没结论的不替它做主 */
  const failed = o.sites.filter((s) => last.perSite[s] === 'fail');
  if (failed.length) return { verdict: 'fail', failed, perSite: last.perSite };
  log('::error::health gate: no verdict within ' + Math.round(o.timeoutMs / 1000) + 's (' +
    o.sites.map((s) => s + '=' + last.perSite[s]).join(' ') + (lastReason ? '; last D1 error: ' + lastReason : '') +
    '). Is the styrigx-status cron running?');
  return { verdict: 'timeout', failed: [], perSite: last.perSite };
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error('unexpected argument: ' + a);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error('missing value for ' + a);
    out[a.slice(2)] = v;
    i++;
  }
  const num = (k, d) => {
    if (out[k] === undefined || out[k] === '') return d;
    const n = Number(out[k]);
    if (!Number.isFinite(n) || n <= 0) throw new Error('--' + k + ' must be a positive number');
    return n;
  };
  const sites = String(out.sites || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!sites.length) throw new Error('--sites is required');
  for (const s of sites) if (!isSafeSite(s)) throw new Error('bad site name: ' + s);
  /* 基线：空值 / 非数字跳过（上游 job 没记到时间就是空），多个取最小 */
  const bl = String(out['baseline-until'] || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  return {
    sites,
    since: out.since ? num('since', 0) : null,
    settle: num('settle', DEFAULTS.settle),
    timeout: num('timeout', DEFAULTS.timeout),
    interval: num('interval', DEFAULTS.interval),
    confirm: Math.floor(num('confirm', DEFAULTS.confirm)),
    baselineUntil: bl.length ? Math.min(...bl) : null,
  };
}

/** 要把关的站必须是 status 真在巡检的（targets.js） @param {string[]} sites */
export function unknownSites(sites) {
  const known = new Set(TARGETS.map((t) => t.site));
  return sites.filter((s) => !known.has(s));
}

/** @param {string} key @param {string} value */
function setOutput(key, value) {
  const line = key + '=' + value + '\n';
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  process.stdout.write(line);
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) {
    process.stdout.write('::error::' + /** @type {any} */ (e).message + '\n');
    return 1;
  }
  const bad = unknownSites(args.sites);
  if (bad.length) { process.stdout.write('::error::not patrolled by styrigx-status (workers/status/src/targets.js): ' + bad.join(', ') + '\n'); return 1; }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) { process.stdout.write('::error::CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set\n'); setOutput('verdict', 'error'); setOutput('failed', ''); return 1; }
  const toml = readFileSync(fileURLToPath(new URL('../workers/status/wrangler.toml', import.meta.url)), 'utf8');
  const database = d1DatabaseId(toml, 'D1_UPTIME_MONITOR');
  if (!database) { process.stdout.write('::error::D1_UPTIME_MONITOR database_id not found in workers/status/wrangler.toml\n'); return 1; }
  const since = args.since != null ? args.since : Date.now() + args.settle * 1000;
  process.stdout.write('health gate: waiting for styrigx-status checks of ' + args.sites.join(', ') + ' after ' + new Date(since).toISOString() +
    ' (confirm ' + args.confirm + ', timeout ' + args.timeout + 's)\n');
  const cfg = { account, token, database, api: process.env.CF_API_BASE || DEFAULT_API };
  const r = await waitForHealth({
    sites: args.sites, since, baselineUntil: args.baselineUntil,
    timeoutMs: args.timeout * 1000, intervalMs: args.interval * 1000, confirm: args.confirm,
    query: (q) => d1Query(q, cfg),
  });
  if (r.verdict === 'fail') process.stdout.write('::error::health gate: ' + r.failed.join(', ') + ' failing after this deploy (styrigx-status checks)\n');
  if (r.verdict === 'binding') process.stdout.write('::error::health gate: styrigx-status reports err=binding (its service bindings are not wired); rolling back status only\n');
  if (r.verdict === 'pass') process.stdout.write('::notice::health gate: ' + args.sites.join(', ') + ' healthy after this deploy\n');
  setOutput('verdict', r.verdict);
  setOutput('failed', r.failed.join(','));
  return r.verdict === 'pass' ? 0 : 1;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    process.stdout.write('::error::health gate crashed: ' + String((e && e.message) || e).slice(0, 300) + '\n');
    setOutput('verdict', 'error');
    setOutput('failed', '');
    process.exitCode = 1;
  });
}
