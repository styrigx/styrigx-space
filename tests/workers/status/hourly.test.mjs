/**
 * status 的每小时任务（2026-11-10）：免费账号只有 5 个 Cron Trigger，ai / curio-core / daymark-core 的每小时 Cron
 * 并进 status 的 "41 * * * *"，经服务绑定调各自的命名入口 HourlyJob.run(at)。
 * Atlas 后端合并（2026-11-14）：curio-core / daymark-core 合成 styrigx-atlas-core，两条绑定合成 JOB_ATLAS。
 */
import '../account/_cf-workers.mjs'; /* cloudflare:workers 替身：三个 HourlyJob 是 WorkerEntrypoint */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runHourlyJobs, HOURLY_ORDER } from '../../../workers/status/src/hourly.js';
import worker from '../../../workers/status/src/index.js';
import { USAGE_CRON } from '../../../workers/status/src/usage.js';

const R = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8');

function svc(log, name, { fail = false, throws = false, delay = 0 } = {}) {
  return {
    async run(at) {
      log.push(name + ':start:' + at);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      log.push(name + ':end');
      if (throws) throw new Error('boom');
      return { ok: !fail };
    },
  };
}

test('顺序：先 atlas（奇趣 + 日刻），结束后才跑 ai；at 原样传下去', async () => {
  const log = [];
  const env = { JOB_ATLAS: svc(log, 't', { delay: 20 }), JOB_AI: svc(log, 'a') };
  const out = await runHourlyJobs(env, 1234);
  assert.deepEqual(out, { JOB_ATLAS: 'ok', JOB_AI: 'ok' });
  assert.equal(log[0], 't:start:1234');
  assert.ok(log.indexOf('a:start:1234') > log.indexOf('t:end'));
  assert.deepEqual(HOURLY_ORDER, [['JOB_ATLAS'], ['JOB_AI']]);
});

test('合并后旧绑定 JOB_DAYMARK / JOB_CURIO 不再叫（防止 atlas 被叫两遍）', async () => {
  const log = [];
  const out = await runHourlyJobs({ JOB_DAYMARK: svc(log, 'd'), JOB_CURIO: svc(log, 'c'), JOB_ATLAS: svc(log, 't') }, 7);
  assert.deepEqual(out, { JOB_ATLAS: 'ok', JOB_AI: 'skipped' });
  assert.deepEqual(log, ['t:start:7', 't:end']);
});

test('失败 / 抛错只记 failed，不挡后面；没配的绑定跳过', async () => {
  const log = [];
  const errs = console.error; console.error = () => {};
  try {
    assert.deepEqual(await runHourlyJobs({ JOB_ATLAS: svc(log, 't', { throws: true }), JOB_AI: svc(log, 'a') }, 1), { JOB_ATLAS: 'failed', JOB_AI: 'ok' });
    assert.deepEqual(await runHourlyJobs({ JOB_ATLAS: svc(log, 't', { fail: true }) }, 1), { JOB_ATLAS: 'failed', JOB_AI: 'skipped' });
    assert.deepEqual(await runHourlyJobs({}, 1), { JOB_ATLAS: 'skipped', JOB_AI: 'skipped' });
  } finally { console.error = errs; }
});

test('41 分那轮：收用量 + 叫两个任务（atlas、ai）；每分钟那轮不叫', async () => {
  const log = [];
  const env = { JOB_ATLAS: svc(log, 't'), JOB_AI: svc(log, 'a') };
  const waits = [];
  await worker.scheduled({ cron: USAGE_CRON, scheduledTime: 42 }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.equal(waits.length, 1);
  assert.deepEqual(log.filter((x) => x.includes('start')).sort(), ['a:start:42', 't:start:42']);
});

test('wrangler：status 绑两个 HourlyJob 入口（atlas、ai），旧 JOB_DAYMARK / JOB_CURIO 删了；Worker 清掉自己的 Cron、入口再导出', () => {
  const st = R('workers/status/wrangler.toml');
  assert.doesNotMatch(st, /^binding = "JOB_(DAYMARK|CURIO)"$/m);
  assert.doesNotMatch(st, /^service = "styrigx-(curio|daymark)-core"$/m);
  for (const [b, s] of [['JOB_ATLAS', 'styrigx-atlas-core'], ['JOB_AI', 'styrigx-ai']]) {
    assert.match(st, new RegExp(`\\[\\[services\\]\\]\\nbinding = "${b}"\\nservice = "${s}"\\nentrypoint = "HourlyJob"`));
  }
  assert.match(st, /crons = \["\* \* \* \* \*", "41 \* \* \* \*"\]/);
  for (const w of ['ai', 'atlas-core']) {
    assert.match(R(`workers/${w}/wrangler.toml`), /^\[triggers\]\n(#.*\n)*crons = \[\]$/m, w);
    assert.match(R(`workers/${w}/src/index.js`), /export \{ HourlyJob \} from '\.\/rpc\/hourly-job\.js';/, w);
  }
  const dep = R('.github/workflows/deploy.yml');
  const job = dep.slice(dep.indexOf('  deploy-proxy-rules-worker:'));
  assert.match(job, /needs: \[quality, passkey-e2e, deploy-ai-worker, deploy-atlas-core\]/);
});

test('两个 HourlyJob.run（atlas、ai）：调各自的任务，出错回 { ok:false } 不抛', async () => {
  const { HourlyJob: T } = await import('../../../workers/atlas-core/src/rpc/hourly-job.js');
  const { HourlyJob: A } = await import('../../../workers/ai/src/rpc/hourly-job.js');
  const errs = console.error; console.error = () => {};
  try {
    for (const K of [T, A]) {
      const r = await new K({}, {}).run(1);
      assert.equal(typeof r.ok, 'boolean');
    }
  } finally { console.error = errs; }
});
