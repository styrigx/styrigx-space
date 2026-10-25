/**
 * 第 5 层 KV 键名一次性迁移脚本（scripts/migrate-kv-names.mjs）的纯函数部分：planMigration / verifyPlan / splitExisting / resolveBackupDir。
 * 不访问网络（REST 调用只在 main 里）。
 *
 * 运行：node --test tests/workers/auth-gateway/kv-migration.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { planMigration, verifyPlan, splitExisting, resolveBackupDir } from '../../../scripts/migrate-kv-names.mjs';
import { REALM_LOCK, REALM_ACCOUNT, REALM_ROOT } from '../../../workers/auth-gateway/functions/_kernel/realms.js';

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

test('planMigration：每个旧键 → 新键（与 realms.js 的新键名一致），值原样，过期时间沿用', () => {
  const plan = planMigration(sampleEntries(), NOW);
  const w = new Map(plan.writes.map((x) => [x.key, x]));
  assert.equal(w.get(REALM_LOCK.kv.password).value, '{"hash":"L","salt":"s"}');
  assert.equal(w.get(REALM_ACCOUNT.kv.password).value, '{"hash":"A","salt":"s"}');
  assert.equal(w.get(REALM_LOCK.kv.userHandle).value, 'lock-handle');
  assert.equal(w.get(REALM_ACCOUNT.kv.userHandle).value, 'acct-handle');
  assert.equal(w.get(REALM_LOCK.kv.epoch).value, '7');
  assert.equal(w.get(REALM_LOCK.kv.configured).value, '1');
  assert.equal(w.get(REALM_ACCOUNT.kv.configured).value, '1');
  assert.equal(w.get(REALM_LOCK.kv.resetSwitch).value, 'switch-value');
  assert.equal(w.get(REALM_LOCK.kv.passkeyChallengePrefix + 'c1').expiration, NOW + 300);
  assert.equal(w.get(REALM_LOCK.kv.passwordFailPrefix + '1.2.3.4').value, '2');
  assert.ok(w.has(REALM_LOCK.kv.passwordCooldownPrefix + '1.2.3.4'));
  assert.ok(w.has(REALM_LOCK.kv.tempkeyFailPrefix + '9.9.9.9'));
  assert.ok(w.has(REALM_LOCK.kv.tempkeyFailGlobal));
  assert.ok(w.has(REALM_ACCOUNT.kv.passkeyChallengePrefix + 'c3'));
  assert.ok(w.has(REALM_ACCOUNT.kv.deviceRevokedPrefix + 'DEV0000000000002'));
  assert.ok(w.has(REALM_ROOT.kv.failPrefix + '5.5.5.5'));
  assert.ok(w.has(REALM_ROOT.kv.failGlobal));
  assert.ok(w.has(REALM_ROOT.kv.auditPrefix + '1:x'));
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
  cur.set(REALM_LOCK.kv.epoch, { value: '8' });
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
