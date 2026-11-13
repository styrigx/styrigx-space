/**
 * status 的每日任务（v5 S2 起；v6 P2c 加账号到期清理）：不另加 Cron，挂在 "41 * * * *" 上，只在 03:00 CST（UTC 19 点）那一轮
 * 经服务绑定 JOB_ACCOUNT 调账号 Worker 的命名入口 AccountJanitor.purgeExpiredUsers(at)。
 * v6 P4（定稿 v5.2 §十三）：分享短链整套删除，原 JOB_SPACE（space-core ShareJanitor）随之删除。
 * 运行：node --test tests/workers/status/daily.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { runDailyJobs, isDailyHour, DAILY_UTC_HOUR, DAILY_JOBS } from '../../../workers/status/src/daily.js';
import worker from '../../../workers/status/src/index.js';
import { USAGE_CRON } from '../../../workers/status/src/usage.js';

const R = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8');
/** Asia/Shanghai 墙上时间（UTC+8，无夏令时）→ 毫秒 */
const cst = (y, mo, d, h, mi = 41) => Date.UTC(y, mo - 1, d, h - 8, mi);
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

/** 账号 Worker 的 AccountJanitor 替身 @param {string[]} log @param {{throws?:boolean, fail?:boolean}} [o] */
function accountJanitor(log, o = {}) {
  return {
    async purgeExpiredUsers(at) {
      log.push('expire:' + at);
      if (o.throws) throw new Error('boom');
      return o.fail ? { ok: false, deleted: 0 } : { ok: true, deleted: 1 };
    },
  };
}

test('时段：只有 03:xx CST（= UTC 19 点）那一轮算每日；跨月、跨年、闰日都一样', () => {
  assert.equal(DAILY_UTC_HOUR, 19);
  assert.equal(isDailyHour(cst(2026, 11, 11, 3)), true);
  assert.equal(isDailyHour(cst(2026, 11, 11, 3, 0)), true);
  assert.equal(isDailyHour(cst(2026, 11, 11, 3, 59)), true);
  assert.equal(isDailyHour(cst(2027, 1, 1, 3)), true, '元旦 03:41 CST = 12-31 19:41 UTC');
  assert.equal(isDailyHour(cst(2028, 2, 29, 3)), true);
  for (const h of [0, 1, 2, 4, 5, 11, 12, 19, 23]) assert.equal(isDailyHour(cst(2026, 11, 11, h)), false, 'CST ' + h + ' 点不跑');
});

test('v6 P4：每日任务只剩 JOB_ACCOUNT（JOB_SPACE / purgeShareLinks 随分享短链删除）', () => {
  assert.deepEqual(DAILY_JOBS, { JOB_ACCOUNT: 'purgeExpiredUsers' });
});

test('runDailyJobs：03:41 CST 调一次 purgeExpiredUsers(at)、at 原样传；别的小时一次都不调', async () => {
  const log = [];
  const env = { JOB_ACCOUNT: accountJanitor(log) };
  let hit = 0;
  for (let h = 0; h < 24; h++) {
    const at = cst(2026, 11, 11, h);
    const out = await runDailyJobs(env, at);
    if (h === 3) { assert.deepEqual(out, { JOB_ACCOUNT: 'ok' }); hit++; } else assert.deepEqual(out, { JOB_ACCOUNT: 'not-now' }, 'CST ' + h);
  }
  assert.equal(hit, 1);
  assert.deepEqual(log, ['expire:' + cst(2026, 11, 11, 3)], '一天只调一次');
});

test('runDailyJobs：抛错 / 回 { ok:false } 只记 failed 不抛；没配绑定就跳过', async () => {
  const at = cst(2026, 11, 11, 3);
  await quiet(async () => {
    assert.deepEqual(await runDailyJobs({ JOB_ACCOUNT: accountJanitor([], { throws: true }) }, at), { JOB_ACCOUNT: 'failed' });
    assert.deepEqual(await runDailyJobs({ JOB_ACCOUNT: accountJanitor([], { fail: true }) }, at), { JOB_ACCOUNT: 'failed' });
  });
  assert.deepEqual(await runDailyJobs({}, at), { JOB_ACCOUNT: 'skipped' });
  assert.deepEqual(await runDailyJobs({ JOB_ACCOUNT: {} }, at), { JOB_ACCOUNT: 'skipped' });
  assert.deepEqual(await runDailyJobs(undefined, at), { JOB_ACCOUNT: 'skipped' });
});

function hourlySvc(log, name) {
  return { async run(at) { log.push(name + ':' + at); return { ok: true }; } };
}

test('scheduled：41 分那轮在 03:41 CST 清理到期用户 + 照常叫每小时任务；清理失败不挡每小时任务、不让 scheduled 抛错', async () => {
  for (const mode of [{}, { throws: true }, { fail: true }]) {
    const log = [];
    const at = cst(2026, 11, 11, 3);
    const env = { JOB_ATLAS: hourlySvc(log, 't'), JOB_AI: hourlySvc(log, 'a'), JOB_ACCOUNT: accountJanitor(log, mode) };
    const waits = [];
    await quiet(async () => {
      await worker.scheduled({ cron: USAGE_CRON, scheduledTime: at }, env, { waitUntil: (p) => waits.push(p) });
      await Promise.all(waits);
    });
    assert.equal(waits.length, 1);
    assert.deepEqual(log.slice().sort(), ['a:' + at, 't:' + at, 'expire:' + at].sort(), JSON.stringify(mode));
  }
});

test('scheduled：别的小时的 41 分、每分钟那轮都不清理', async () => {
  const log = [];
  const env = { JOB_ATLAS: hourlySvc(log, 't'), JOB_AI: hourlySvc(log, 'a'), JOB_ACCOUNT: accountJanitor(log) };
  const waits = [];
  await worker.scheduled({ cron: USAGE_CRON, scheduledTime: cst(2026, 11, 11, 4) }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.equal(log.filter((x) => x.startsWith('expire')).length, 0);
  assert.equal(log.length, 2, '每小时任务照常（atlas、ai）');
  const w2 = [];
  await quiet(async () => {
    await worker.scheduled({ cron: '* * * * *', scheduledTime: cst(2026, 11, 11, 3) }, { JOB_ACCOUNT: accountJanitor(log) }, { waitUntil: (p) => w2.push(p) });
    await Promise.all(w2);
  });
  assert.equal(log.filter((x) => x.startsWith('expire')).length, 0);
});

test('wrangler：不加 Cron；status 绑 JOB_ACCOUNT → styrigx-account 的 AccountJanitor；JOB_SPACE / ShareJanitor 已删', () => {
  const st = R('workers/status/wrangler.toml');
  assert.match(st, /^crons = \["\* \* \* \* \*", "41 \* \* \* \*"\]$/m, '还是两条 Cron');
  assert.doesNotMatch(st, /^binding = "JOB_SPACE"$/m);
  assert.doesNotMatch(st, /^entrypoint = "ShareJanitor"$/m);
  assert.doesNotMatch(R('workers/space-core/src/index.js'), /^export \{ ShareJanitor/m);
  assert.equal(existsSync(new URL('../../../workers/space-core/src/rpc/share-janitor.js', import.meta.url)), false);
  assert.match(st, /\[\[services\]\]\nbinding = "JOB_ACCOUNT"\nservice = "styrigx-account"\nentrypoint = "AccountJanitor"/);
  assert.match(R('workers/account/src/index.js'), /^export \{ AccountJanitor \} from '\.\/rpc\/account-janitor\.js';$/m);
  assert.match(R('workers/account/src/rpc/account-janitor.js'), /class AccountJanitor extends WorkerEntrypoint/);
  assert.doesNotMatch(R('workers/account/wrangler.toml'), /^\[triggers\]/m, '账号 Worker 不自带 Cron');
});
