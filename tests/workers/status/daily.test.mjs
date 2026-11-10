/**
 * status 的每日任务（v5 S2，2026-11-10）：不另加 Cron，挂在 "41 * * * *" 上，只在 03:00 CST（UTC 19 点）那一轮
 * 经服务绑定 JOB_SPACE 调 space-core 的命名入口 ShareJanitor.purgeShareLinks(at)，删掉过期 / 作废满 7 天的分享链接。
 * 运行：node --test tests/workers/status/daily.test.mjs
 */
import '../account/_cf-workers.mjs'; /* cloudflare:workers 替身：ShareJanitor 是 WorkerEntrypoint */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runDailyJobs, isDailyHour, DAILY_UTC_HOUR } from '../../../workers/status/src/daily.js';
import worker from '../../../workers/status/src/index.js';
import { USAGE_CRON } from '../../../workers/status/src/usage.js';
import { shareD1, HAS_SQLITE } from '../../fixtures/share-d1.mjs';
import { SQL } from '../../../workers/space-core/src/core/share-links.js';

const R = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8');
/** Asia/Shanghai 墙上时间（UTC+8，无夏令时）→ 毫秒 */
const cst = (y, mo, d, h, mi = 41) => Date.UTC(y, mo - 1, d, h - 8, mi);
const D = 86400e3;

function janitor(log, { fail = false, throws = false } = {}) {
  return {
    async purgeShareLinks(at) {
      log.push('purge:' + at);
      if (throws) throw new Error('boom');
      return fail ? { ok: false } : { ok: true, deleted: 2 };
    },
  };
}
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

test('时段：只有 03:xx CST（= UTC 19 点）那一轮算每日；跨月、跨年、闰日都一样', () => {
  assert.equal(DAILY_UTC_HOUR, 19);
  assert.equal(isDailyHour(cst(2026, 11, 11, 3)), true);
  assert.equal(isDailyHour(cst(2026, 11, 11, 3, 0)), true);
  assert.equal(isDailyHour(cst(2026, 11, 11, 3, 59)), true);
  assert.equal(isDailyHour(cst(2027, 1, 1, 3)), true, '元旦 03:41 CST = 12-31 19:41 UTC');
  assert.equal(isDailyHour(cst(2028, 2, 29, 3)), true);
  for (const h of [0, 1, 2, 4, 5, 11, 12, 19, 23]) assert.equal(isDailyHour(cst(2026, 11, 11, h)), false, 'CST ' + h + ' 点不跑');
});

test('runDailyJobs：03:41 CST 调一次 purgeShareLinks(at)、at 原样传；别的小时一次都不调', async () => {
  const log = [];
  const env = { JOB_SPACE: janitor(log) };
  let hit = 0;
  for (let h = 0; h < 24; h++) {
    const at = cst(2026, 11, 11, h);
    const out = await runDailyJobs(env, at);
    if (h === 3) { assert.deepEqual(out, { JOB_SPACE: 'ok' }); hit++; } else assert.deepEqual(out, { JOB_SPACE: 'not-now' }, 'CST ' + h);
  }
  assert.equal(hit, 1);
  assert.deepEqual(log, ['purge:' + cst(2026, 11, 11, 3)], '一天只调一次');
});

test('runDailyJobs：抛错 / 回 { ok:false } 只记 failed 不抛；没配绑定就跳过', async () => {
  const at = cst(2026, 11, 11, 3);
  await quiet(async () => {
    assert.deepEqual(await runDailyJobs({ JOB_SPACE: janitor([], { throws: true }) }, at), { JOB_SPACE: 'failed' });
    assert.deepEqual(await runDailyJobs({ JOB_SPACE: janitor([], { fail: true }) }, at), { JOB_SPACE: 'failed' });
  });
  assert.deepEqual(await runDailyJobs({}, at), { JOB_SPACE: 'skipped' });
  assert.deepEqual(await runDailyJobs({ JOB_SPACE: {} }, at), { JOB_SPACE: 'skipped' });
  assert.deepEqual(await runDailyJobs(undefined, at), { JOB_SPACE: 'skipped' });
});

function hourlySvc(log, name) {
  return { async run(at) { log.push(name + ':' + at); return { ok: true }; } };
}

test('scheduled：41 分那轮在 03:41 CST 清理 + 照常叫每小时任务；清理失败不挡每小时任务、不让 scheduled 抛错', async () => {
  for (const mode of [{}, { throws: true }, { fail: true }]) {
    const log = [];
    const at = cst(2026, 11, 11, 3);
    const env = { JOB_DAYMARK: hourlySvc(log, 'd'), JOB_CURIO: hourlySvc(log, 'c'), JOB_AI: hourlySvc(log, 'a'), JOB_SPACE: janitor(log, mode) };
    const waits = [];
    await quiet(async () => {
      await worker.scheduled({ cron: USAGE_CRON, scheduledTime: at }, env, { waitUntil: (p) => waits.push(p) });
      await Promise.all(waits);
    });
    assert.equal(waits.length, 1);
    assert.deepEqual(log.slice().sort(), ['a:' + at, 'c:' + at, 'd:' + at, 'purge:' + at].sort(), JSON.stringify(mode));
  }
});

test('scheduled：别的小时的 41 分、每分钟那轮都不清理', async () => {
  const log = [];
  const env = { JOB_DAYMARK: hourlySvc(log, 'd'), JOB_CURIO: hourlySvc(log, 'c'), JOB_AI: hourlySvc(log, 'a'), JOB_SPACE: janitor(log) };
  const waits = [];
  await worker.scheduled({ cron: USAGE_CRON, scheduledTime: cst(2026, 11, 11, 4) }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.equal(log.filter((x) => x.startsWith('purge')).length, 0);
  assert.equal(log.length, 3, '每小时任务照常');
  /* 每分钟那轮（03:41 也一样）走巡检，不碰 JOB_SPACE；巡检本身缺 D1 会自己打日志 */
  const w2 = [];
  await quiet(async () => {
    await worker.scheduled({ cron: '* * * * *', scheduledTime: cst(2026, 11, 11, 3) }, { JOB_SPACE: janitor(log) }, { waitUntil: (p) => w2.push(p) });
    await Promise.all(w2);
  });
  assert.equal(log.filter((x) => x.startsWith('purge')).length, 0);
});

test('wrangler：不加 Cron；status 绑 JOB_SPACE → styrigx-space-core 的 ShareJanitor；space-core 导出这个入口', () => {
  const st = R('workers/status/wrangler.toml');
  assert.match(st, /^crons = \["\* \* \* \* \*", "41 \* \* \* \*"\]$/m, '还是两条 Cron');
  assert.match(st, /\[\[services\]\]\nbinding = "JOB_SPACE"\nservice = "styrigx-space-core"\nentrypoint = "ShareJanitor"/);
  assert.match(R('workers/space-core/src/index.js'), /^export \{ ShareJanitor \} from '\.\/rpc\/share-janitor\.js';$/m);
  assert.match(R('workers/space-core/src/rpc/share-janitor.js'), /class ShareJanitor extends WorkerEntrypoint/);
});

/* ---------------- ShareJanitor.purgeShareLinks（space-core 那一头，真 SQL / 内存两种） ---------------- */

const KINDS = HAS_SQLITE ? [{ name: 'sqlite' }, { name: 'memory', memory: true }] : [{ name: 'memory', memory: true }];
const { ShareJanitor } = await import('../../../workers/space-core/src/rpc/share-janitor.js');

for (const K of KINDS) {
  test('[' + K.name + '] ShareJanitor.purgeShareLinks：删过期 / 作废满 7 天的；有效的、刚死不到 7 天的都留着；回 deleted', async () => {
    const db = shareD1({ memory: !!K.memory });
    const now = cst(2026, 11, 11, 3);
    let i = 0;
    const add = async (name, expires) => {
      i++;
      await db.prepare(SQL.insert).bind('id' + i, 'code' + String(i).padStart(18, '0'), name, '/', 0, now - 40 * D, expires).run();
      return 'id' + i;
    };
    await add('live', now + D);
    await add('exp6', now - 6 * D);
    await add('exp8', now - 8 * D);
    await db.prepare(SQL.revoke).bind(await add('rev6', now + D), now - 6 * D).run();
    await db.prepare(SQL.revoke).bind(await add('rev8', now + 30 * D), now - 8 * D).run();
    const j = new ShareJanitor({}, { D1_SPACE: db });
    assert.deepEqual(await j.purgeShareLinks(now), { ok: true, deleted: 2 });
    assert.deepEqual(db.rows().map((r) => r.name).sort(), ['exp6', 'live', 'rev6']);
    assert.deepEqual(await j.purgeShareLinks(now), { ok: true, deleted: 0 }, '再跑一次没东西可删');
  });
}

test('ShareJanitor.purgeShareLinks：没绑 D1 / D1 出错 → { ok:false }，不抛', async () => {
  await quiet(async () => {
    assert.deepEqual(await new ShareJanitor({}, {}).purgeShareLinks(1), { ok: false });
    const broken = { prepare: () => { throw new Error('d1 down'); } };
    assert.deepEqual(await new ShareJanitor({}, { D1_SPACE: broken }).purgeShareLinks(1), { ok: false });
  });
});
