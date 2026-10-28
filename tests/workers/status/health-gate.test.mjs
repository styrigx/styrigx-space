/**
 * 部署后健康闸门第二阶段：scripts/health-gate.mjs（读 styrigx-status 的 checks 判定）和 deploy.yml 里的接线。
 * 运行：node --test tests/workers/status/health-gate.test.mjs
 *
 * 真 SQL 用 node:sqlite 跑（Node 22+；没有就跳过那一条，纯逻辑照测）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  judge, failingBefore, checksQuery, d1Query, waitForHealth, parseArgs, unknownSites, isSafeSite, BASELINE_WINDOW_MS,
} from '../../../scripts/health-gate.mjs';
import { TARGETS } from '../../../workers/status/src/targets.js';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch {}

const SITES = ['search', 'chat'];
const row = (site, at, ok, err = null) => ({ site, at, ok: ok ? 1 : 0, code: ok ? 200 : (err === 'status' ? 503 : 0), err: ok ? null : err });

/* ---------- judge ---------- */

test('judge：没有新巡检 → pending；都成功 → pass', () => {
  assert.equal(judge([], SITES).verdict, 'pending');
  assert.equal(judge([row('search', 1, true)], SITES).verdict, 'pending', 'chat 还没测到');
  const r = judge([row('search', 1, true), row('chat', 1, true)], SITES);
  assert.equal(r.verdict, 'pass');
  assert.deepEqual(r.failed, []);
});

test('judge：单次失败等确认（confirm 2），连续 2 次失败 → fail；失败后又成功 → pass', () => {
  const one = [row('search', 1, false, 'status'), row('chat', 1, true)];
  assert.equal(judge(one, SITES).verdict, 'pending');
  assert.equal(judge(one, SITES, { confirm: 1 }).verdict, 'fail');
  const two = [...one, row('search', 2, false, 'timeout'), row('chat', 2, true)];
  const r = judge(two, SITES);
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(r.failed, ['search']);
  assert.equal(r.perSite.chat, 'pass');
  const recovered = [...one, row('search', 2, true)];
  assert.equal(judge(recovered, SITES).verdict, 'pass');
});

test('judge：一个站确认失败、另一个还没结论 → 先等（pending），两个都要出结论', () => {
  const rows = [row('search', 1, false, 'status'), row('search', 2, false, 'status')];
  const r = judge(rows, SITES);
  assert.equal(r.verdict, 'pending');
  assert.equal(r.perSite.search, 'fail');
});

test('judge：失败全是 err=binding（status 自己没接好绑定）→ binding，不算 search / chat 坏了', () => {
  const rows = [1, 2].flatMap((at) => [row('search', at, false, 'binding'), row('chat', at, true)]);
  const r = judge(rows, SITES);
  assert.equal(r.verdict, 'binding');
  assert.deepEqual(r.failed, []);
  /* 一真一假：真失败优先 */
  const mixed = [1, 2].flatMap((at) => [row('search', at, false, 'binding'), row('chat', at, false, 'status')]);
  assert.deepEqual(judge(mixed, SITES), { verdict: 'fail', failed: ['chat'], perSite: { search: 'binding', chat: 'fail' } });
});

test('judge：部署前就在失败的站（preexisting）→ 只算 preexisting，不回滚它', () => {
  const rows = [1, 2].flatMap((at) => [row('search', at, true), row('chat', at, false, 'status')]);
  const r = judge(rows, SITES, { preexisting: new Set(['chat']) });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.perSite.chat, 'preexisting');
});

test('failingBefore：每站只看部署前最近一次', () => {
  const s = failingBefore([row('chat', 1, true), row('chat', 3, false, 'status'), row('search', 1, false, 'status'), row('search', 2, true)]);
  assert.deepEqual([...s], ['chat']);
});

/* ---------- SQL / D1 REST ---------- */

test('checksQuery：参数化（站名不拼进 SQL），有 / 没有上限两种', () => {
  const a = checksQuery(SITES, 100, null);
  assert.equal(a.sql, 'SELECT site, at, ok, code, err FROM checks WHERE at > ? AND site IN (?, ?) ORDER BY at');
  assert.deepEqual(a.params, [100, 'search', 'chat']);
  const b = checksQuery(SITES, 100, 200);
  assert.match(b.sql, /WHERE at > \? AND at <= \? AND site IN/);
  assert.deepEqual(b.params, [100, 200, 'search', 'chat']);
});

test('checksQuery：在 status 迁移出的真表上能跑，只取部署之后、指定的站', { skip: !sqlite && 'node:sqlite unavailable' }, () => {
  const db = new sqlite.DatabaseSync(':memory:');
  for (const f of ['0001_init.sql', '0002_usage.sql', '0003_cut_reads.sql', '0004_quota.sql']) {
    db.exec(readFileSync(new URL('../../../workers/status/migrations/' + f, import.meta.url), 'utf8'));
  }
  const ins = db.prepare('INSERT INTO checks (site, at, ok, code, ms, err) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run('search', 100, 0, 503, 5, 'status');
  ins.run('search', 200, 1, 200, 5, null);
  ins.run('chat', 200, 0, 0, 10000, 'timeout');
  ins.run('space', 200, 0, 0, 1, 'network');
  const q = checksQuery(SITES, 150, null);
  const rows = db.prepare(q.sql).all(...q.params).map((r) => ({ ...r }));
  assert.deepEqual(rows.map((r) => r.site + '@' + r.at).sort(), ['chat@200', 'search@200']);
  assert.equal(judge(rows, SITES, { confirm: 1 }).verdict, 'fail');
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + q.sql).all(...q.params).map((r) => r.detail).join(' ');
  assert.match(plan, /checks_at/, '走 checks_at 索引，不扫全表');
});

test('d1Query：POST …/d1/database/<id>/query，带 Bearer 和参数；401 / 403 是 fatal；网络错不抛', async () => {
  /** @type {any[]} */
  const calls = [];
  const ok = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ success: true, result: [{ results: [row('search', 1, true)], success: true }] }), { status: 200 });
  };
  const cfg = { account: 'acc', token: 'tok', database: 'db-1', api: 'https://cf.test/client/v4/' };
  const r = await d1Query(checksQuery(SITES, 1, null), { ...cfg, fetch: /** @type {any} */ (ok) });
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 1);
  assert.equal(calls[0].url, 'https://cf.test/client/v4/accounts/acc/d1/database/db-1/query');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].init.body).params, [1, 'search', 'chat']);

  const denied = async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 });
  const d = await d1Query(checksQuery(SITES, 1, null), { ...cfg, fetch: /** @type {any} */ (denied) });
  assert.equal(d.ok, false);
  assert.equal(d.fatal, true);
  assert.doesNotMatch(d.reason, /tok/);

  const boom = async () => { throw new Error('ECONNRESET'); };
  const n = await d1Query(checksQuery(SITES, 1, null), { ...cfg, fetch: /** @type {any} */ (boom) });
  assert.equal(n.ok, false);
  assert.equal(n.fatal, false);
});

/* ---------- waitForHealth（假时钟） ---------- */

/** 假时钟 + 按轮次回结果的查询；第一次带上限的查询当基线 */
function harness(rounds, baselineRows = []) {
  let t = 0;
  let i = 0;
  const queries = [];
  return {
    queries,
    now: () => t,
    sleep: async (ms) => { t += ms; },
    log: () => {},
    query: async (q) => {
      queries.push(q);
      if (q.sql.includes('at <= ?')) return { ok: true, rows: baselineRows, reason: 'ok' };
      const r = rounds[Math.min(i++, rounds.length - 1)];
      return typeof r === 'function' ? r() : { ok: true, rows: r, reason: 'ok' };
    },
  };
}
const base = { sites: SITES, since: 1000, timeoutMs: 300000, intervalMs: 15000, confirm: 2 };

test('waitForHealth：等到新巡检 → pass', async () => {
  const h = harness([[], [row('search', 61000, true)], [row('search', 61000, true), row('chat', 61000, true)]]);
  const r = await waitForHealth({ ...base, ...h });
  assert.equal(r.verdict, 'pass');
  assert.equal(h.queries.length, 3);
  assert.deepEqual(h.queries[0].params.slice(0, 1), [1000], '只查 since 之后');
});

test('waitForHealth：连续失败 → fail（failed 只列确认失败的站）', async () => {
  const r1 = [row('search', 61000, true), row('chat', 61000, false, 'status')];
  const r2 = [...r1, row('search', 121000, true), row('chat', 121000, false, 'status')];
  const r = await waitForHealth({ ...base, ...harness([r1, r2]) });
  assert.deepEqual(r.failed, ['chat']);
  assert.equal(r.verdict, 'fail');
});

test('waitForHealth：部署前就在失败（基线）→ 不判 fail', async () => {
  const before = [row('chat', 900, false, 'status'), row('search', 900, true)];
  const after = [61000, 121000].flatMap((at) => [row('search', at, true), row('chat', at, false, 'status')]);
  const h = harness([after], before);
  const r = await waitForHealth({ ...base, ...h, baselineUntil: 950 });
  assert.equal(r.verdict, 'pass');
  assert.deepEqual(h.queries[0].params, [950 - BASELINE_WINDOW_MS, 950, 'search', 'chat']);
});

test('waitForHealth：超时没结论 → timeout；超时时已确认失败的照样 fail', async () => {
  const r = await waitForHealth({ ...base, ...harness([[]]) });
  assert.equal(r.verdict, 'timeout');
  const failing = [row('search', 61000, false, 'status'), row('search', 121000, false, 'status')];
  const r2 = await waitForHealth({ ...base, ...harness([failing]) });
  assert.equal(r2.verdict, 'fail');
  assert.deepEqual(r2.failed, ['search']);
});

test('waitForHealth：D1 偶发错误继续等；鉴权错误（fatal）立刻 error', async () => {
  const flaky = harness([() => ({ ok: false, rows: [], fatal: false, reason: 'HTTP 500' }), [row('search', 61000, true), row('chat', 61000, true)]]);
  assert.equal((await waitForHealth({ ...base, ...flaky })).verdict, 'pass');
  const denied = harness([() => ({ ok: false, rows: [], fatal: true, reason: 'HTTP 403' })]);
  assert.equal((await waitForHealth({ ...base, ...denied })).verdict, 'error');
});

/* ---------- 参数 ---------- */

test('parseArgs：默认值；基线取最小、空值跳过；坏站名 / 缺值报错', () => {
  const a = parseArgs(['--sites', 'search,chat', '--baseline-until', '200,,100']);
  assert.deepEqual(a, { sites: ['search', 'chat'], since: null, settle: 15, timeout: 300, interval: 15, confirm: 2, baselineUntil: 100 });
  assert.equal(parseArgs(['--sites', 'chat', '--baseline-until', ',']).baselineUntil, null, '上游没记到时间 → 没有基线');
  assert.throws(() => parseArgs([]), /--sites/);
  assert.throws(() => parseArgs(['--sites', "chat');--"]), /bad site/);
  assert.throws(() => parseArgs(['--sites', 'chat', '--timeout']), /missing value/);
  assert.throws(() => parseArgs(['--sites', 'chat', '--confirm', '0']), /positive/);
  assert.equal(isSafeSite('proxy-rules'), true);
});

test('闸门把关的 search / chat 都是 status 经服务绑定在巡检的', () => {
  assert.deepEqual(unknownSites(SITES), []);
  assert.deepEqual(unknownSites(['nope']), ['nope']);
  for (const s of SITES) assert.ok(TARGETS.find((t) => t.site === s).binding, s + ' 走服务绑定');
});

/* ---------- deploy.yml 接线 ---------- */

const wf = yaml.load(readFileSync(new URL('../../../.github/workflows/deploy.yml', import.meta.url), 'utf8'));

test('deploy.yml：status 部署核对后跑闸门（在最后的回滚步骤之前），用 status 自己的 token，结论导出给回滚 job', () => {
  const job = wf.jobs['deploy-status-worker'];
  const steps = job.steps;
  const gi = steps.findIndex((s) => s.id === 'health');
  const vi = steps.findIndex((s) => typeof s.run === 'string' && s.run.includes('worker-verify'));
  assert.ok(vi >= 0 && gi === vi + 1, '闸门紧跟 worker-verify');
  assert.equal(gi, steps.length - 2, '闸门之后只有回滚一步（失败时 status 自己回滚）');
  const g = steps[gi];
  assert.match(g.run, /^node scripts\/health-gate\.mjs --sites search,chat --baseline-until "\$BASELINE_UNTIL"$/);
  assert.equal(g.env.CLOUDFLARE_API_TOKEN, '${{ secrets.STYRIGX_STATUS_DEPLOY }}');
  assert.equal(g.env.CLOUDFLARE_ACCOUNT_ID, '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
  assert.equal(g['continue-on-error'], undefined, '闸门失败要让 job 红');
  assert.equal(g.env.BASELINE_UNTIL, '${{ needs.deploy-search-worker.outputs.started_at }},${{ needs.deploy-chat-worker.outputs.started_at }}');
  assert.deepEqual(job.outputs, { health_verdict: '${{ steps.health.outputs.verdict }}', health_failed: '${{ steps.health.outputs.failed }}' });
  /* 网关等 status：闸门红了网关 / Pages / 账号 / 分享都不部署 */
  assert.ok(wf.jobs['deploy-auth-worker'].needs.includes('deploy-status-worker'));
});

test('deploy.yml：search / chat 导出部署前版本和开始部署的时刻（在部署之前记）', () => {
  for (const name of ['deploy-search-worker', 'deploy-chat-worker']) {
    const job = wf.jobs[name];
    assert.deepEqual(job.outputs, { previous: '${{ steps.live.outputs.version }}', started_at: '${{ steps.t0.outputs.at }}' }, name);
    const t0 = job.steps.findIndex((s) => s.id === 't0');
    const dep = job.steps.findIndex((s) => s.uses && String(s.uses).startsWith('cloudflare/wrangler-action') && /^deploy\b/.test(String(s.with.command)));
    assert.ok(t0 >= 0 && t0 < dep, name + ': t0 before deploy');
    assert.match(job.steps[t0].run, /date \+%s%3N/);
  }
});

test('deploy.yml：闸门判 fail 才回滚对应 Worker，在它自己的环境里用原有 token', () => {
  const cfg = {
    'rollback-search-worker': { deploy: 'deploy-search-worker', site: 'search', env: 'STYRIGX_SEARCH_INDEX_DEPLOY', dir: 'workers/search-index' },
    'rollback-chat-worker': { deploy: 'deploy-chat-worker', site: 'chat', env: 'STYRIGX_CHAT_DEPLOY', dir: 'workers/chat' },
  };
  for (const [name, c] of Object.entries(cfg)) {
    const job = wf.jobs[name];
    assert.deepEqual(job.needs, [c.deploy, 'deploy-status-worker'], name);
    assert.equal(job.environment, c.env, name);
    assert.match(job.if, /^\$\{\{ always\(\) && needs\.deploy-status-worker\.outputs\.health_verdict == 'fail' && /, name);
    assert.ok(job.if.includes("',{0},', needs.deploy-status-worker.outputs.health_failed), '," + c.site + ",')"), name);
    assert.ok(job.if.includes('needs.' + c.deploy + ".outputs.previous != ''"), name);
    const last = job.steps[job.steps.length - 1];
    assert.equal(last['working-directory'], c.dir, name);
    assert.match(last.run, /deploy-rollback\.mjs" worker-rollback --to "\$PREVIOUS"$/, name);
    assert.equal(last.env.PREVIOUS, '${{ needs.' + c.deploy + '.outputs.previous }}', name);
    assert.equal(last.env.CLOUDFLARE_API_TOKEN, '${{ secrets.' + c.env + ' }}', name);
    for (const s of job.steps) if (s.uses) assert.match(s.uses, /@[0-9a-f]{40}$/, name + ': pinned');
  }
});
