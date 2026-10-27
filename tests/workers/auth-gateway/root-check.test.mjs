/**
 * 根凭证比对（_kernel/root-check.js checkRootCredential）的耗时对齐 padTo：
 * - 比对失败：先计数、再写审计，最后调 padTo，然后才返回 401 auth（真失败与假入口耗时一致）
 * - 比对成功：不调 padTo
 * - 被限速（429）、限速 D1 读出错（503）、计数写 D1 出错（503）：不走到比对，也不调 padTo
 * root-auth 把 padTo 接到自己的 t0 上：真路径失败与无会话假入口都对齐同一个耗时。
 *
 * 存储：D1_ROOT_AUTH（realm='root'）的 attempt_limit（kind='rootkey'）和 audit 两张表。
 *
 * 运行：node --test tests/workers/auth-gateway/root-check.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRootCredential } from '../../../workers/auth-gateway/functions/_kernel/root-check.js';
import { makeAuthD1 } from '../_harness.mjs';

const ROOT_KEY = 'root-key-for-tests-0123456789';

/**
 * 执行过的 SQL → 语义化的写操作序列（读和顺手清过期行不算），padTo 插在同一条时间线上。
 * @param {string} sql
 */
function classify(sql) {
  const s = String(sql);
  if (/^\s*INSERT INTO attempt_limit/i.test(s)) return /'\*'/.test(s) ? 'attempt:global' : 'attempt:ip';
  if (/^\s*DELETE FROM attempt_limit WHERE realm = \? AND kind = \? AND bucket = \?/i.test(s)) return 'attempt:clear';
  if (/^\s*INSERT INTO audit/i.test(s)) return 'audit';
  if (/^\s*(UPDATE|INSERT|REPLACE)/i.test(s)) return 'write:' + s.slice(0, 40); /* 其他写：断言里会显出来 */
  return null; /* SELECT、过期清理 */
}

function setup() {
  const db = makeAuthD1();
  const padTo = async () => { db.calls.push('padTo'); };
  const log = () => db.calls.map((c) => (c === 'padTo' ? c : classify(c))).filter(Boolean);
  const attempt = (bucket) => db.raw.prepare("SELECT * FROM attempt_limit WHERE realm = 'root' AND kind = 'rootkey' AND bucket = ?").get(bucket) || null;
  const audits = () => db.raw.prepare('SELECT * FROM audit ORDER BY ts, id').all().map((r) => Object.assign({}, r));
  return { db, padTo, log, attempt, audits, env: { SGX_ROOT_KEY: ROOT_KEY, D1_ROOT_AUTH: db } };
}
const run = (s, key, ip = '192.0.2.10') => checkRootCredential({ env: s.env, ip, key, auditPath: 'lock-reset', padTo: s.padTo });

test('比对失败：计数 → 审计 → padTo → 401 auth（padTo 在审计写入之后、只调一次）', async () => {
  const s = setup();
  const r = await run(s, 'wrong');
  assert.equal(r.ok, false);
  assert.equal(r.response.status, 401);
  assert.deepEqual(await r.response.json(), { ok: false, error: 'auth' });
  assert.deepEqual(s.log(), ['attempt:ip', 'attempt:global', 'audit', 'padTo']);
  /* D1 行：单 IP 计 1、全局计 1、审计一行（realm=root，失败） */
  assert.equal(s.attempt('192.0.2.10').count, 1);
  assert.equal(s.attempt('*').count, 1);
  const a = s.audits();
  assert.equal(a.length, 1);
  assert.equal(a[0].realm, 'root');
  assert.equal(a[0].ok, 0);
  assert.equal(a[0].path, 'lock-reset');
  assert.equal(a[0].ip_prefix, '192.0.2.x', '只存 IP 前缀');
});

test('空串 / 只有空白的输入也是比对失败，同样 padTo', async () => {
  for (const key of ['', '   \n\t']) {
    const s = setup();
    const r = await run(s, key);
    assert.equal(r.response.status, 401);
    const log = s.log();
    assert.equal(log.filter((x) => x === 'padTo').length, 1);
    assert.equal(log[log.length - 1], 'padTo');
    assert.equal(s.attempt('192.0.2.10').count, 1, '空输入也计数');
  }
});

test('比对成功：不调 padTo；清掉本 IP 计数（全局窗口不动），不写审计（审计由调用方签票前写）', async () => {
  const s = setup();
  const r = await run(s, '  ' + ROOT_KEY + '\n');
  assert.equal(r.ok, true);
  assert.equal(s.log().includes('padTo'), false);
  /* 唯一的写：清本 IP 的行（单条 DELETE，没有行时也是空操作，不插入任何东西） */
  assert.deepEqual(s.log(), ['attempt:clear']);
  assert.equal(s.attempt('192.0.2.10'), null);
  /* 之前输错过：本 IP 的行被删掉，全局窗口保留 */
  const s2 = setup();
  await run(s2, 'wrong');
  await run(s2, 'wrong');
  assert.equal(s2.attempt('192.0.2.10').count, 2);
  const r2 = await run(s2, ROOT_KEY);
  assert.equal(r2.ok, true);
  assert.equal(s2.attempt('192.0.2.10'), null);
  assert.equal(s2.attempt('*').count, 2, '全局窗口不因成功清零');
});

test('本 IP 被锁（429 cooldown）：写审计，不比对、不 padTo', async () => {
  const s = setup();
  const now = Date.now();
  s.db.raw.prepare("INSERT INTO attempt_limit (realm, kind, bucket, count, strikes, locked_until, window_start, expires_at) VALUES ('root', 'rootkey', '192.0.2.10', 0, 0, ?, ?, ?)")
    .run(now + 60000, now, now + 3600000);
  const r = await run(s, ROOT_KEY);
  assert.equal(r.response.status, 429);
  assert.deepEqual(await r.response.json(), { ok: false, error: 'cooldown' });
  assert.deepEqual(s.log(), ['audit']);
  assert.equal(s.audits()[0].ok, 0);
  assert.ok(s.attempt('192.0.2.10').locked_until > now, '码对也不清锁定');
});

test('锁定行已过期（expires_at 过了）：读时不认，照常比对', async () => {
  const s = setup();
  const now = Date.now();
  s.db.raw.prepare("INSERT INTO attempt_limit (realm, kind, bucket, count, strikes, locked_until, window_start, expires_at) VALUES ('root', 'rootkey', '192.0.2.10', 0, 0, ?, ?, ?)")
    .run(now + 60000, now - 7200000, now - 1);
  const r = await run(s, ROOT_KEY);
  assert.equal(r.ok, true);
});

test('限速 D1 读出错：503 server，不比对、不 padTo、不写任何东西', async () => {
  const s = setup();
  s.db.failOn = (sql) => /^\s*SELECT/i.test(sql) && /attempt_limit/.test(sql);
  const r = await run(s, ROOT_KEY);
  assert.equal(r.response.status, 503);
  assert.deepEqual(await r.response.json(), { ok: false, error: 'server' });
  assert.deepEqual(s.log(), []);
});

test('失败计数写不进去：503 server（fail closed），不 padTo', async () => {
  const s = setup();
  s.db.failOn = (sql) => /^\s*INSERT INTO attempt_limit/i.test(sql);
  const r = await run(s, 'wrong');
  assert.equal(r.response.status, 503);
  assert.deepEqual(await r.response.json(), { ok: false, error: 'server' });
  assert.equal(s.log().includes('padTo'), false);
  assert.equal(s.attempt('192.0.2.10'), null);
});

test('没绑 D1_ROOT_AUTH：500 config（不比对）', async () => {
  const r = await checkRootCredential({ env: { SGX_ROOT_KEY: ROOT_KEY }, ip: '192.0.2.12', key: ROOT_KEY, auditPath: 'lock-reset' });
  assert.equal(r.ok, false);
  assert.equal(r.response.status, 500);
});

test('没有传 padTo 时失败照常返回 401（lock-reset 路径）', async () => {
  const s = setup();
  const r = await checkRootCredential({ env: s.env, ip: '192.0.2.11', key: 'wrong', auditPath: 'lock-reset' });
  assert.equal(r.response.status, 401);
});
