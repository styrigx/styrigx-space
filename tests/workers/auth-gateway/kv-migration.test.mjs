/**
 * 两个一次性迁移脚本，都不访问网络（REST 调用只在 main / cfApi 里；这里用内存替身）：
 * - scripts/migrate-kv-names.mjs（第 5 层 KV 键名）：planMigration / verifyPlan / splitExisting / resolveBackupDir
 * - scripts/migrate-kv-to-d1.mjs（2026-10-27 KV → D1，网关上线前跑一次）：planAuthImport / runPlan / readKv / wantedKey / d1IdOf。
 *   --dry-run 一行不写；apply 导入；再跑一次幂等（不重复、不把 D1 里删掉的写回来）；--verify 通过；中途失败再跑补齐。
 *
 * 运行：node --test tests/workers/auth-gateway/kv-migration.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { planMigration, verifyPlan, splitExisting, resolveBackupDir } from '../../../scripts/migrate-kv-names.mjs';
import {
  planAuthImport, runPlan, readKv, wantedKey, d1IdOf, AUTH_KV_NAMESPACE,
} from '../../../scripts/migrate-kv-to-d1.mjs';
import { makeAuthD1 } from '../_harness.mjs';

const NOW = 1_800_000_000;
const pk = (credId, cls, extra) => JSON.stringify(Object.assign({ name: 'k-' + credId, provider: '', aaguid: '', createdAt: 1, lastUsedAt: 0, credId, publicKey: { kty: 'EC' }, signCount: 3, uv: 1 }, cls ? { class: cls } : {}, extra || {}));

function sampleEntries() {
  return [
    { name: 'lock-pw', value: '{"hash":"L","salt":"s"}' },
    { name: 'owner-pw', value: '{"hash":"A","salt":"s"}' },
    { name: 'owner-user-id', value: 'lock-handle' },
    { name: 'owner-user-id:owner', value: 'acct-handle' },
    { name: 'session-epoch', value: '7' },
    { name: 'account-epoch', value: '3' },
    { name: 'account-prefs', value: '{}' },
    { name: 'layer:lock', value: '1' },
    { name: 'layer:owner', value: '1' },
    { name: 'recovery-switch', value: 'switch-value' },
    { name: 'owner-passkey-index', value: JSON.stringify(['LOCKCRED00001', 'ACCTCRED00001', 'APPCRED000001', 'GONECRED00001', 'OLDLOCK000001']) },
    { name: 'owner-passkey:LOCKCRED0000', value: pk('LOCKCRED00001', 'lock'), metadata: { name: 'k' } },
    { name: 'owner-passkey:ACCTCRED0000', value: pk('ACCTCRED00001', 'owner') },
    { name: 'owner-passkey:APPCRED00000', value: pk('APPCRED000001', 'app') },
    { name: 'owner-passkey:OLDLOCK00000', value: pk('OLDLOCK000001', '') },
    { name: 'owner-passkeys', value: '[]' },
    { name: 'pk-challenge:c1', value: '{"challenge":"x"}', expiration: NOW + 300 },
    { name: 'lockreset-challenge:c2', value: '{"challenge":"y"}', expiration: NOW + 30 },
    { name: 'pw-fail:1.2.3.4', value: '2', expiration: NOW + 3600 },
    { name: 'pw-lock:1.2.3.4', value: String(NOW * 1000), expiration: NOW + 120 },
    { name: 'lock-temp:TKID0000000000a', value: '{"id":"TKID0000000000a"}', expiration: NOW + 3600 },
    { name: 'lock-temp-code:abc', value: 'TKID0000000000a', expiration: NOW + 3600 },
    { name: 'lock-temp-revoked:TKID0000000000b', value: '1', expiration: NOW + 3600 },
    { name: 'lock-temp-fail:9.9.9.9', value: '{"count":1}', expiration: NOW + 900 },
    { name: 'lock-temp-global', value: '{"count":1}', expiration: NOW + 3600 },
    { name: 'account-challenge:c3', value: '{"challenge":"z"}', expiration: NOW + 300 },
    { name: 'account-dev:DEV0000000000001', value: JSON.stringify({ sid: 'DEV0000000000001', by: 'password', lastSeen: 5 }), expiration: NOW + 86400 },
    { name: 'account-revoked:DEV0000000000002', value: '1', expiration: NOW + 86400 },
    { name: 'root-auth-fail:5.5.5.5', value: '{"count":1}', expiration: NOW + 3600 },
    { name: 'root-auth-global', value: '{"count":1}', expiration: NOW + 3600 },
    { name: 'root-auth-audit:1:x', value: '{"ok":true}', expiration: NOW + 86400 },
    { name: 'something-else', value: '1' },
  ];
}

test('planMigration：每个旧键 → 新键（第 5 层 KV 键名，2026-10-27 前的线上格式，逐字写死），值原样，过期时间沿用', () => {
  const plan = planMigration(sampleEntries(), NOW);
  const w = new Map(plan.writes.map((x) => [x.key, x]));
  assert.equal(w.get('lock-password').value, '{"hash":"L","salt":"s"}');
  assert.equal(w.get('account-password').value, '{"hash":"A","salt":"s"}');
  assert.equal(w.get('lock-user-id').value, 'lock-handle');
  assert.equal(w.get('account-user-id').value, 'acct-handle');
  assert.equal(w.get('lock-epoch').value, '7');
  assert.equal(w.get('lock-configured').value, '1');
  assert.equal(w.get('account-configured').value, '1');
  assert.equal(w.get('lock-reset-switch').value, 'switch-value');
  assert.equal(w.get('lock-passkey-challenge:' + 'c1').expiration, NOW + 300);
  assert.equal(w.get('lock-password-fail:' + '1.2.3.4').value, '2');
  assert.ok(w.has('lock-password-cooldown:' + '1.2.3.4'));
  assert.ok(w.has('lock-tempkey-fail:' + '9.9.9.9'));
  assert.ok(w.has('lock-tempkey-fail-global'));
  assert.ok(w.has('account-passkey-challenge:' + 'c3'));
  assert.ok(w.has('account-device-revoked:' + 'DEV0000000000002'));
  assert.ok(w.has('root-fail:' + '5.5.5.5'));
  assert.ok(w.has('root-fail-global'));
  assert.ok(w.has('root-audit:' + '1:x'));
  /* account-epoch / account-prefs 键名不变：不写也不删；不认识的键只报告 */
  assert.ok(!w.has('account-epoch') && !plan.deleteOld.includes('account-epoch') && !plan.deleteOld.includes('account-prefs'));
  assert.deepEqual(plan.unknown, ['something-else']);
  /* 不写任何旧名字 */
  for (const x of plan.writes) assert.match(x.key, /^(lock|account|root)-/, x.key);
});

test('planMigration：通行密钥按 class 分流、去掉 class；索引拆两份（保序、只留记录还在的）；class=app 不迁移', () => {
  const plan = planMigration(sampleEntries(), NOW);
  const w = new Map(plan.writes.map((x) => [x.key, x]));
  const lockRec = JSON.parse(w.get('lock-passkey:LOCKCRED0000').value);
  assert.equal('class' in lockRec, false);
  assert.equal(lockRec.credId, 'LOCKCRED00001');
  assert.equal(lockRec.signCount, 3);
  assert.deepEqual(lockRec.publicKey, { kty: 'EC' });
  assert.deepEqual(w.get('lock-passkey:LOCKCRED0000').metadata, { name: 'k' });
  assert.ok(w.has('lock-passkey:OLDLOCK00000'), '没有 class 的早期记录按锁屏');
  assert.equal(JSON.parse(w.get('account-passkey:ACCTCRED0000').value).credId, 'ACCTCRED00001');
  assert.ok(![...w.keys()].some((k) => k.includes('APPCRED')));
  assert.deepEqual(JSON.parse(w.get('lock-passkey-index').value), ['LOCKCRED00001', 'OLDLOCK000001']);
  assert.deepEqual(JSON.parse(w.get('account-passkey-index').value), ['ACCTCRED00001']);
  assert.ok(plan.skipped.some((s) => s.key === 'owner-passkey:APPCRED00000' && s.reason === 'class=app'));
  assert.ok(plan.deleteOld.includes('owner-passkey:APPCRED00000'));
  assert.ok(plan.deleteOld.includes('owner-passkey-index'));
  assert.ok(plan.deleteOld.includes('owner-passkeys'));
});

test('planMigration：设备记录 sid → deviceId；临时钥匙 lock-temp:* / -code / -revoked 不迁移但删除；快过期的跳过', () => {
  const plan = planMigration(sampleEntries(), NOW);
  const w = new Map(plan.writes.map((x) => [x.key, x]));
  const dev = JSON.parse(w.get('account-device:DEV0000000000001').value);
  assert.deepEqual(dev, { deviceId: 'DEV0000000000001', by: 'password', lastSeen: 5 });
  assert.equal(w.get('account-device:DEV0000000000001').expiration, NOW + 86400);
  for (const k of ['lock-temp:TKID0000000000a', 'lock-temp-code:abc', 'lock-temp-revoked:TKID0000000000b']) {
    assert.ok(plan.deleteOld.includes(k), k);
    assert.ok(plan.skipped.some((s) => s.key === k && s.reason === 'not-migrated'), k);
  }
  assert.ok(![...w.keys()].some((k) => k.startsWith('lock-tempkey:') || k.startsWith('lock-tempkey-code:') || k.startsWith('lock-tempkey-revoked:')));
  /* 30 秒后过期：不写（KV 要求至少 60 秒），旧键照样在删除列表 */
  assert.ok(!w.has('lock-reset-challenge:c2'));
  assert.ok(plan.skipped.some((s) => s.key === 'lockreset-challenge:c2' && s.reason === 'expired'));
  assert.ok(plan.deleteOld.includes('lockreset-challenge:c2'));
});

test('planMigration：幂等——已迁移的新键不报未知，不重复计划', () => {
  const plan = planMigration([{ name: 'lock-password', value: '{}' }, { name: 'account-passkey-index', value: '[]' }, { name: 'root-fail-global', value: '{}' }], NOW);
  assert.deepEqual(plan, { writes: [], deleteOld: [], skipped: [], unknown: [] });
});

test('verifyPlan：值一致才通过（JSON 按解析比较）；--delete-old 只查存在，带过期的消失也算正常', () => {
  const plan = planMigration(sampleEntries(), NOW);
  const cur = new Map(plan.writes.map((x) => [x.key, { value: x.value }]));
  assert.equal(verifyPlan(plan.writes, cur).ok, true);
  /* 字段顺序不同也算一致 */
  const k = 'account-device:DEV0000000000001';
  cur.set(k, { value: JSON.stringify({ lastSeen: 5, by: 'password', deviceId: 'DEV0000000000001' }) });
  assert.equal(verifyPlan(plan.writes, cur).ok, true);
  cur.set('lock-epoch', { value: '8' });
  const v = verifyPlan(plan.writes, cur);
  assert.equal(v.ok, false);
  assert.deepEqual(v.mismatches, [{ key: 'lock-epoch', reason: 'value' }]);
  /* 部署后：值变了（新代码推了纪元）不算错；challenge 过期消失不算错；没有 TTL 的键缺了算错 */
  cur.delete('lock-passkey-challenge:c1');
  assert.equal(verifyPlan(plan.writes, cur, { presenceOnly: true }).ok, true);
  cur.delete('lock-password');
  assert.deepEqual(verifyPlan(plan.writes, cur, { presenceOnly: true }).mismatches, [{ key: 'lock-password', reason: 'missing' }]);
});

test('splitExisting：目标键已存在的不写（重跑 / 部署后误跑不回滚纪元）', () => {
  const entries = sampleEntries().concat([{ name: 'lock-epoch', value: '9' }]);
  const plan = planMigration(entries, NOW);
  const { toWrite, existing } = splitExisting(plan.writes, new Set(entries.map((e) => e.name)));
  assert.deepEqual(existing.map((w) => w.key), ['lock-epoch']);
  assert.ok(!toWrite.some((w) => w.key === 'lock-epoch'));
  assert.equal(toWrite.length + existing.length, plan.writes.length);
  /* 全新 namespace：全部要写 */
  assert.equal(splitExisting(plan.writes, new Set()).toWrite.length, plan.writes.length);
});

test('resolveBackupDir：默认在 home 下；仓库内（含仓库根）拒绝；--backup-dir 缺值拒绝', () => {
  const repo = path.resolve('/tmp/sgx-repo');
  assert.equal(resolveBackupDir([], repo, '/home/u'), path.join('/home/u', '.sgx-kv-backups'));
  assert.equal(resolveBackupDir(['--backup-dir', '/tmp/bk'], repo, '/home/u'), path.resolve('/tmp/bk'));
  assert.equal(resolveBackupDir(['--backup-dir', '/tmp/sgx-repo-bk'], repo, '/home/u'), path.resolve('/tmp/sgx-repo-bk'));
  assert.throws(() => resolveBackupDir(['--backup-dir', repo], repo, '/home/u'), /仓库/);
  assert.throws(() => resolveBackupDir(['--backup-dir', path.join(repo, 'scripts')], repo, '/home/u'), /仓库/);
  assert.throws(() => resolveBackupDir([], repo, repo), /仓库/);
  assert.throws(() => resolveBackupDir(['--backup-dir'], repo, '/home/u'), /目录/);
  assert.throws(() => resolveBackupDir(['--backup-dir', '--apply'], repo, '/home/u'), /目录/);
});

/* ================================================================
 * scripts/migrate-kv-to-d1.mjs：KV → D1 一次性导入
 * ================================================================ */

const T0 = 1_800_000_000_000; /* 毫秒 */
const S0 = T0 / 1000; /* KV list 的 expiration 是秒 */
const pkRec = (credId, extra) => JSON.stringify({ name: 'k-' + credId, provider: '', aaguid: '', createdAt: 1, lastUsedAt: 0, credId, publicKey: { kty: 'EC' }, signCount: 3, uv: 1, ...(extra || {}) });

/** 上线前认证库 KV 的样本：键 → { value, expiration? }（readKv 的输出格式） */
function legacyAuthKv() {
  const e = (value, expiration) => (expiration ? { value, expiration } : { value });
  return new Map([
    ['lock-password', e(JSON.stringify({ salt: 's', hash: 'LOCKHASH', iterations: 100000, peppered: true }))],
    ['account-password', e(JSON.stringify({ salt: 's', hash: 'ACCTHASH', iterations: 100000, peppered: true }))],
    ['lock-passkey-index', e(JSON.stringify(['LOCKCRED0002x', 'LOCKCRED0001x', 'GONECRED0000x']))],
    ['lock-passkey:LOCKCRED0001', e(pkRec('LOCKCRED0001x'))],
    ['lock-passkey:LOCKCRED0002', e(pkRec('LOCKCRED0002x'))],
    /* 索引不存在：按前缀 */
    ['account-passkey:ACCTCRED0001', e(pkRec('ACCTCRED0001x'))],
    ['lock-user-id', e('lock-handle-legacy')],
    ['account-user-id', e('acct-handle-legacy')],
    ['lock-epoch', e('6')],
    /* account-epoch 没有 → 1 */
    ['account-device:DEV0000000000001', e(JSON.stringify({ deviceId: 'DEV0000000000001', by: 'password', lastSeen: 5 }), S0 + 86400)],
    ['account-device:DEV0000000000002', e(JSON.stringify({ deviceId: 'DEV0000000000002', by: 'passkey', lastSeen: 6 }), S0 + 86400)],
    ['account-device-revoked:DEV0000000000002', e('1', S0 + 3600)],
    ['account-device:DEVEXPIRED000001', e(JSON.stringify({ deviceId: 'DEVEXPIRED000001' }), S0 - 1)],
    ['lock-tempkey:TKID0000000000a1', e(JSON.stringify({ id: 'TKID0000000000a1', name: 'guest', h: 'CODEHASH1', createdAt: T0 - 1000, expiresAt: T0 + 3600e3 }))],
    ['lock-tempkey:TKLINK000000000b', e(JSON.stringify({ id: 'TKLINK000000000b', name: '', link: true, createdAt: T0 - 1000, expiresAt: T0 + 3600e3 }))],
    ['lock-tempkey:TKOLD0000000000c', e(JSON.stringify({ id: 'TKOLD0000000000c', name: 'old', h: 'CODEHASH3', createdAt: 1, expiresAt: T0 - 1 }))],
    ['lock-tempkey:TKREV0000000000d', e(JSON.stringify({ id: 'TKREV0000000000d', name: 'rev', h: 'CODEHASH4', createdAt: 1, expiresAt: T0 + 3600e3 }))],
    ['lock-tempkey-revoked:TKREV0000000000d', e('1', S0 + 3600)],
  ]);
}
/** 不该导入的键（计数、challenge、已配置标记、重置开关、审计、临时码索引） */
const NOT_IMPORTED = ['lock-password-fail:1.2.3.4', 'lock-password-cooldown:1.2.3.4', 'account-password-fail-global', 'lock-tempkey-fail:1.2.3.4',
  'root-fail:1.2.3.4', 'root-fail-global', 'lock-passkey-challenge:c1', 'account-passkey-challenge:c2', 'lock-reset-challenge:c3',
  'lock-configured', 'account-configured', 'lock-reset-switch', 'root-audit:1:x', 'lock-tempkey-code:abc'];

/**
 * runPlan 用的 D1 REST 替身：node:sqlite（makeAuthD1 的 raw，不跑迁移 = 正式库上线前的状态，只有 0001 的表也没有）。
 * 记下每条语句；failWhen(sql, params) 返回 true 的那条抛错（模拟中途失败）。
 */
function restD1() {
  const db = makeAuthD1({ migrations: false });
  const calls = [];
  const api = {
    failWhen: (_sql, _params) => false,
    async d1(sql, params) {
      calls.push(sql);
      if (api.failWhen(sql, params || [])) throw new Error('D1 query HTTP 500');
      const st = db.raw.prepare(sql);
      if (/^\s*SELECT\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) return { results: st.all(...(params || [])).map((r) => ({ ...r })), meta: { changes: 0 } };
      const r = st.run(...(params || []));
      return { results: [], meta: { changes: Number(r.changes || 0) } };
    },
  };
  return { db, api, calls };
}
const tableNames = (db) => db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
const count = (db, t) => (tableNames(db).includes(t) ? db.raw.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n : 0);
const AUTH_TABLES = ['epoch', 'password', 'passkey', 'user_handle', 'device', 'tempkey', 'kv_migration', 'challenge', 'attempt_limit', 'audit'];
const snapshot = (db) => Object.fromEntries(AUTH_TABLES.map((t) => [t, tableNames(db).includes(t) ? db.raw.prepare('SELECT * FROM ' + t + ' ORDER BY 1, 2').all().map((r) => ({ ...r })) : null]));

test('migrate-kv-to-d1 --dry-run：一行不写、不建表；只发 SELECT；输出只有计数，不打印任何值', async () => {
  const { db, api, calls } = restD1();
  const plan = planAuthImport(legacyAuthKv(), T0);
  const res = await runPlan(api, plan, { mode: 'dry-run' });
  assert.equal(res.ok, true);
  assert.equal(res.written, 0);
  assert.deepEqual(tableNames(db), [], '不建表');
  for (const sql of calls) assert.match(sql, /^SELECT /, sql);
  const out = res.lines.join('\n');
  for (const secret of ['LOCKHASH', 'ACCTHASH', 'lock-handle-legacy', 'CODEHASH1', 'kty']) assert.ok(!out.includes(secret), secret + ' 不应出现在输出里');
  assert.match(out, /lock-passkey: 2 row\(s\) planned/);
  /* 已经导入过的库上 dry-run：同样一行不写，并标出会跳过 */
  const done = restD1();
  await runPlan(done.api, plan, { mode: 'apply' });
  const before = snapshot(done.db);
  const n = done.calls.length;
  const again = await runPlan(done.api, plan, { mode: 'dry-run' });
  assert.deepEqual(snapshot(done.db), before);
  for (const sql of done.calls.slice(n)) assert.match(sql, /^SELECT /, sql);
  assert.match(again.lines.join('\n'), /lock-password: 1 row\(s\) planned \(already imported: will be skipped\)/);
});

test('migrate-kv-to-d1 apply：建表（同 SCHEMA）并导入；纪元 = KV + 1（没有 → 1）；设备 / 临时钥匙保留作废状态、跳过过期；计数 / challenge / 标记不导', async () => {
  const kv = legacyAuthKv();
  for (const k of NOT_IMPORTED) kv.set(k, { value: '1', expiration: S0 + 3600 });
  const { db, api } = restD1();
  const res = await runPlan(api, planAuthImport(kv, T0), { mode: 'apply' });
  assert.equal(res.ok, true);
  for (const t of ['epoch', 'password', 'passkey', 'user_handle', 'device', 'tempkey', 'kv_migration', 'challenge', 'attempt_limit', 'audit']) {
    assert.ok(tableNames(db).includes(t), '建了表 ' + t);
  }
  const rows = (t) => db.raw.prepare('SELECT * FROM ' + t).all().map((r) => ({ ...r }));
  assert.deepEqual(Object.fromEntries(rows('epoch').map((r) => [r.realm, r.value])), { lock: 7, account: 1 }, '上线后旧会话 / 票全部失效一次');
  const pw = Object.fromEntries(rows('password').map((r) => [r.realm, JSON.parse(r.record).hash]));
  assert.deepEqual(pw, { lock: 'LOCKHASH', account: 'ACCTHASH' });
  const pk = db.raw.prepare('SELECT realm, credential_id, record FROM passkey ORDER BY rowid').all();
  assert.deepEqual(pk.map((r) => r.realm + ':' + r.credential_id), ['lock:LOCKCRED0002x', 'lock:LOCKCRED0001x', 'account:ACCTCRED0001x'], '按索引顺序；索引里记录已不在的那把跳过');
  assert.equal(JSON.parse(pk[0].record).signCount, 3, '记录原样');
  assert.deepEqual(Object.fromEntries(rows('user_handle').map((r) => [r.realm, r.handle])), { lock: 'lock-handle-legacy', account: 'acct-handle-legacy' });
  const dev = Object.fromEntries(rows('device').map((r) => [r.device_id, r]));
  assert.deepEqual(Object.keys(dev).sort(), ['DEV0000000000001', 'DEV0000000000002'], '过期的设备不导');
  assert.equal(dev.DEV0000000000001.revoked_at, 0);
  assert.equal(dev.DEV0000000000001.expires_at, (S0 + 86400) * 1000, 'expires_at 沿用 KV 的过期时间');
  assert.ok(dev.DEV0000000000002.revoked_at > 0, '已单独退出的设备导成已退出（它的票照样拒）');
  for (const r of rows('device')) assert.equal(r.realm, 'account');
  const tk = Object.fromEntries(rows('tempkey').map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(tk).sort(), ['TKID0000000000a1', 'TKLINK000000000b', 'TKREV0000000000d'], '过期的临时钥匙不导');
  assert.equal(tk.TKID0000000000a1.code_hash, 'CODEHASH1');
  assert.equal(tk.TKID0000000000a1.revoked_at, 0);
  assert.equal(tk.TKLINK000000000b.link, 1);
  assert.equal(tk.TKLINK000000000b.code_hash, null);
  assert.ok(tk.TKREV0000000000d.revoked_at > 0, '已作废的临时钥匙导成已作废');
  assert.equal(tk.TKREV0000000000d.code_hash, null, '已作废的不带码哈希（输不进来）');
  for (const r of rows('tempkey')) assert.equal(r.realm, 'lock');
  assert.equal(count(db, 'challenge'), 0);
  assert.equal(count(db, 'attempt_limit'), 0);
  assert.equal(count(db, 'audit'), 0);
  assert.deepEqual(rows('kv_migration').map((r) => r.name).sort(), ['account-device', 'account-passkey', 'account-password', 'lock-passkey', 'lock-password', 'lock-tempkey']);
  /* 只读 KV 里计划要的键：计数 / challenge / 标记一律不取值 */
  for (const k of NOT_IMPORTED) assert.equal(wantedKey(k), false, k);
  for (const k of ['lock-password', 'account-passkey:x', 'lock-passkey-index', 'lock-user-id', 'account-epoch', 'account-device:x', 'account-device-revoked:x', 'lock-tempkey:x', 'lock-tempkey-revoked:x']) {
    assert.equal(wantedKey(k), true, k);
  }
});

test('migrate-kv-to-d1：第二次 apply 幂等——不写任何行；上线后在 D1 改过 / 删过的不会被旧 KV 值盖回去；纪元不回退', async () => {
  const plan = planAuthImport(legacyAuthKv(), T0);
  const { db, api } = restD1();
  const first = await runPlan(api, plan, { mode: 'apply' });
  assert.ok(first.written > 0);
  const snap = snapshot(db);
  const second = await runPlan(api, plan, { mode: 'apply' });
  assert.equal(second.written, 0);
  assert.deepEqual(snapshot(db), snap, '再跑一次什么都不变');
  /* 上线后：删了一把通行密钥、改了密码、纪元推进了 */
  db.raw.prepare("DELETE FROM passkey WHERE realm = 'lock' AND credential_id = 'LOCKCRED0001x'").run();
  db.raw.prepare("UPDATE password SET record = '{\"hash\":\"NEW\"}' WHERE realm = 'lock'").run();
  db.raw.prepare("UPDATE epoch SET value = 20 WHERE realm = 'lock'").run();
  /* 有人又跑了一次（同一份 KV，或者按新时间重新算的计划） */
  const third = await runPlan(api, planAuthImport(legacyAuthKv(), T0 + 1000), { mode: 'apply' });
  assert.equal(third.written, 0);
  assert.equal(count(db, 'passkey'), 2, '删掉的不写回来');
  assert.equal(JSON.parse(db.raw.prepare("SELECT record FROM password WHERE realm = 'lock'").get().record).hash, 'NEW');
  assert.equal(db.raw.prepare("SELECT value FROM epoch WHERE realm = 'lock'").get().value, 20, '纪元不回退（旧票不复活）');
});

test('migrate-kv-to-d1 --verify：导入前失败（逐条列出缺的）；导入后通过；verify 本身不写', async () => {
  const plan = planAuthImport(legacyAuthKv(), T0);
  const { db, api, calls } = restD1();
  const pre = await runPlan(api, plan, { mode: 'verify' });
  assert.equal(pre.ok, false);
  assert.ok(pre.missing.some((m) => m.startsWith('lock-password password')), pre.missing.join('\n'));
  assert.ok(pre.missing.includes('lock-password (marker missing)'), pre.missing.join('\n'));
  assert.deepEqual(tableNames(db), [], 'verify 不建表');
  for (const sql of calls) assert.match(sql, /^SELECT /, sql);
  await runPlan(api, plan, { mode: 'apply' });
  const snap = snapshot(db);
  const post = await runPlan(api, plan, { mode: 'verify' });
  assert.equal(post.ok, true, post.missing.join('\n'));
  assert.deepEqual(post.missing, []);
  assert.match(post.lines[post.lines.length - 1], /^verify OK$/);
  assert.deepEqual(snapshot(db), snap);
  /* 导入后有一行丢了 → verify 失败 */
  db.raw.prepare("DELETE FROM user_handle WHERE realm = 'account'").run();
  const lost = await runPlan(api, plan, { mode: 'verify' });
  assert.equal(lost.ok, false);
  assert.deepEqual(lost.missing, ['account-user-handle user_handle {"realm":"account"}']);
});

test('migrate-kv-to-d1：中途失败 → 该类不写标记；再跑一次补齐，已写的行不重复', async () => {
  const plan = planAuthImport(legacyAuthKv(), T0);
  const { db, api } = restD1();
  let n = 0;
  api.failWhen = (sql) => /INTO passkey/.test(sql) && ++n === 2; /* 第二把通行密钥写失败 */
  await assert.rejects(runPlan(api, plan, { mode: 'apply' }), /HTTP 500/);
  assert.equal(count(db, 'passkey'), 1);
  assert.ok(!db.raw.prepare("SELECT 1 FROM kv_migration WHERE name = 'lock-passkey'").get(), '没写完不写标记');
  api.failWhen = () => false;
  const res = await runPlan(api, plan, { mode: 'apply' });
  assert.equal(res.ok, true);
  assert.equal(count(db, 'passkey'), 3);
  assert.equal((await runPlan(api, plan, { mode: 'verify' })).ok, true);
});

test('migrate-kv-to-d1：纪元在 D1 已有时不动（INSERT OR IGNORE）；epochWhenMissing=false 时 KV 没有就不写', async () => {
  const { db, api } = restD1();
  await api.d1('CREATE TABLE IF NOT EXISTS epoch (realm TEXT PRIMARY KEY, value INTEGER NOT NULL)', []);
  await api.d1("INSERT INTO epoch (realm, value) VALUES ('lock', 99)", []);
  await runPlan(api, planAuthImport(legacyAuthKv(), T0), { mode: 'apply' });
  assert.equal(db.raw.prepare("SELECT value FROM epoch WHERE realm = 'lock'").get().value, 99);
  const plan = planAuthImport(new Map(), T0, { epochWhenMissing: false });
  assert.deepEqual(plan.families.filter((f) => /-epoch$/.test(f.name)).flatMap((f) => f.statements), []);
  const dflt = planAuthImport(new Map(), T0);
  assert.deepEqual(dflt.families.filter((f) => /-epoch$/.test(f.name)).map((f) => f.statements[0].params), [['lock', 1], ['account', 1]]);
});

test('migrate-kv-to-d1 readKv：只为计划要的键取值，带上 KV 的过期时间；只读（没有 put / delete）', async () => {
  const store = new Map([['lock-password', 'P'], ['lock-password-fail:1.2.3.4', '3'], ['account-device:D1', '{}'], ['lock-configured', '1']]);
  const got = [];
  const api = {
    async kvList(ns) { assert.equal(ns, AUTH_KV_NAMESPACE); return [...store.keys()].map((name) => ({ name, expiration: name === 'account-device:D1' ? 123 : undefined })); },
    async kvGet(ns, key) { got.push(key); return store.has(key) ? store.get(key) : null; },
  };
  const m = await readKv(/** @type {any} */ (api), AUTH_KV_NAMESPACE);
  assert.deepEqual([...m.keys()].sort(), ['account-device:D1', 'lock-password']);
  assert.deepEqual(got.sort(), ['account-device:D1', 'lock-password'], '计数 / 标记不取值');
  assert.equal(m.get('account-device:D1').expiration, 123);
  /* 脚本源码不写 KV */
  const src = readFileSync(new URL('../../../scripts/migrate-kv-to-d1.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /method:\s*'(PUT|DELETE)'/);
  assert.doesNotMatch(src, /\/bulk/);
});

test('migrate-kv-to-d1 d1IdOf：默认库 = 网关 wrangler.toml 的 D1_LOCK_AUTH（styrigx-auth-gateway）；--preview 读 web/wrangler.toml，两者不同', () => {
  const prod = readFileSync(new URL('../../../workers/auth-gateway/wrangler.toml', import.meta.url), 'utf8');
  const pv = readFileSync(new URL('../../../web/wrangler.toml', import.meta.url), 'utf8');
  assert.equal(d1IdOf(prod, 'D1_LOCK_AUTH'), '6931d1da-3502-480d-b0bd-de1bc4829d1d');
  assert.ok(d1IdOf(pv, 'D1_LOCK_AUTH'));
  assert.notEqual(d1IdOf(pv, 'D1_LOCK_AUTH'), d1IdOf(prod, 'D1_LOCK_AUTH'));
  assert.equal(d1IdOf(prod, 'KV_LOCK_DOOR'), '', '网关不再绑 KV');
  assert.equal(AUTH_KV_NAMESPACE, 'b796097c90104000992b7713f61e16ea');
});
