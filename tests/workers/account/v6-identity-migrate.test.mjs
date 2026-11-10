/**
 * v6 凭据迁移 SQL 生成器（space/scripts/v6-identity-migrate.mjs；P1 只写脚本，不对生产执行）：
 * - 对照表：账号凭据 → root（pepper_id account），进站凭据 → styrigx（pepper_id space），styrigx 默认组
 * - WebAuthn 红线：credential_id、record 逐字节不变，user handle 逐字节照抄（root 用账号 handle / legacy，styrigx 用进站 handle / legacy）
 * - 迁完 admit 用的表能直接用（用户、组到位）
 * - 幂等：再跑一遍不变；凭据 ID 撞了 → 给了账号导出时脚本直接报错；没给时 SQL 撞主键失败（不悄悄丢）
 * - 只追加：生成的 SQL 里没有 UPDATE / DELETE / DROP / ALTER；脚本不连 Cloudflare（不 import child_process、不调 wrangler）
 * - 导出解析：wrangler --json 的格式；行数 / 字段 / credId 不一致、有通行密钥没 handle → 报错
 *
 * 运行：node --test tests/workers/account/v6-identity-migrate.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeAccountD1 } from './_d1.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const M = await import(REPO + 'space/scripts/v6-identity-migrate.mjs');

const PUB = { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' };
const ACC_PK = JSON.stringify({ name: '', provider: 'samsung-pass', aaguid: 'a', createdAt: 1, lastUsedAt: 2, credId: 'acc-cred-1', publicKey: PUB, signCount: 7, uv: 1 });
const LOCK_PK1 = JSON.stringify({ name: "Gray's phone", provider: '', aaguid: '', createdAt: 3, lastUsedAt: 0, credId: 'lock-cred-1', publicKey: PUB, signCount: 0, uv: 1 });
const LOCK_PK2 = '{"credId":"lock-cred-2","publicKey":{"kty":"EC"},  "signCount":9}';
const LOCK_PW = '{"salt":"c2FsdA==","hash":"aGFzaA==","iterations":100000,"peppered":true,"updatedAt":5}';
const ACC_PW = '{"salt":"YWNj","hash":"cm9vdA==","iterations":100000,"peppered":true,"updatedAt":6}';

/** wrangler d1 execute --json 的输出形状 */
const spaceExport = (o = {}) => [
  { results: o.pw === undefined ? [{ record: LOCK_PW }] : o.pw, success: true, meta: {} },
  { results: o.pk === undefined ? [{ credential_id: 'lock-cred-1', record: LOCK_PK1 }, { credential_id: 'lock-cred-2', record: LOCK_PK2 }] : o.pk, success: true, meta: {} },
  { results: o.uh === undefined ? [{ handle: 'LOCK_handle_xyz', legacy_handle: '' }] : o.uh, success: true, meta: {} },
];

function accountDb() {
  const d1 = makeAccountD1();
  const raw = d1.raw;
  raw.prepare('INSERT INTO account_password (id, record) VALUES (1, ?)').run(ACC_PW);
  raw.prepare('INSERT INTO account_passkey (credential_id, record) VALUES (?, ?)').run('acc-cred-1', ACC_PK);
  raw.prepare('INSERT INTO account_user_handle (id, handle, legacy_handle) VALUES (1, ?, ?)').run('ACC_handle_abc', 'LEGACY_from_lock');
  return raw;
}
const rows = (raw, sql) => raw.prepare(sql).all().map((r) => ({ ...r }));
const NOW = 1762800000000;

test('对照表：root / styrigx、默认组、pepper_id、handle；credential_id / record 逐字节不变', () => {
  const raw = accountDb();
  raw.exec(M.generateSql(M.parseSpaceExport(spaceExport()), { now: NOW }));
  assert.deepEqual(rows(raw, 'SELECT uid, name, avatar, expires_at, epoch, disabled FROM account_users ORDER BY uid'), [
    { uid: 0, name: 'root', avatar: '', expires_at: 0, epoch: 0, disabled: 0 },
    { uid: 1000, name: 'styrigx', avatar: 'avatar:', expires_at: 0, epoch: 0, disabled: 0 },
  ]);
  assert.deepEqual(rows(raw, 'SELECT grp FROM account_user_groups WHERE uid = 1000 ORDER BY grp').map((r) => r.grp),
    ['ai', 'curio-write', 'daymark-write', 'listen', 'status', 'sudoers', 'wheel']);
  assert.deepEqual(rows(raw, 'SELECT uid FROM account_user_groups WHERE uid = 0'), [], 'root 不进组');
  assert.deepEqual(rows(raw, 'SELECT uid, record, pepper_id, must_change, expires_at FROM account_user_password ORDER BY uid'), [
    { uid: 0, record: ACC_PW, pepper_id: 'account', must_change: 0, expires_at: 0 },
    { uid: 1000, record: LOCK_PW, pepper_id: 'space', must_change: 0, expires_at: 0 },
  ]);
  assert.deepEqual(rows(raw, 'SELECT credential_id, uid, user_handle, legacy_handle, record FROM account_user_passkey ORDER BY credential_id'), [
    { credential_id: 'acc-cred-1', uid: 0, user_handle: 'ACC_handle_abc', legacy_handle: 'LEGACY_from_lock', record: ACC_PK },
    { credential_id: 'lock-cred-1', uid: 1000, user_handle: 'LOCK_handle_xyz', legacy_handle: '', record: LOCK_PK1 },
    { credential_id: 'lock-cred-2', uid: 1000, user_handle: 'LOCK_handle_xyz', legacy_handle: '', record: LOCK_PK2 },
  ]);
  /* 旧表一行不动 */
  assert.equal(rows(raw, 'SELECT record FROM account_password')[0].record, ACC_PW);
  assert.equal(rows(raw, 'SELECT COUNT(*) AS n FROM account_passkey')[0].n, 1);
});

test('幂等：再跑一遍（含换了 now）什么都不变', () => {
  const raw = accountDb();
  const sql = M.generateSql(M.parseSpaceExport(spaceExport()), { now: NOW });
  raw.exec(sql);
  const snap = () => ['account_users', 'account_user_groups', 'account_user_password', 'account_user_passkey'].map((t) => JSON.stringify(rows(raw, 'SELECT * FROM ' + t + ' ORDER BY 1, 2')));
  const a = snap();
  raw.exec(sql);
  raw.exec(M.generateSql(M.parseSpaceExport(spaceExport()), { now: NOW + 999 }));
  assert.deepEqual(snap(), a);
});

test('凭据 ID 撞了：给了账号导出 → 脚本报错不出 SQL；没给 → SQL 撞主键失败', () => {
  const clash = spaceExport({ pk: [{ credential_id: 'acc-cred-1', record: ACC_PK }] });
  assert.throws(() => M.generateSql(M.parseSpaceExport(clash), { now: NOW, accountCredentialIds: M.parseAccountExport([{ results: [{ credential_id: 'acc-cred-1' }] }]) }), /撞了/);
  const raw = accountDb();
  assert.throws(() => raw.exec(M.generateSql(M.parseSpaceExport(clash), { now: NOW })), /UNIQUE|PRIMARY/);
});

test('只追加，不连 Cloudflare', () => {
  const sql = M.generateSql(M.parseSpaceExport(spaceExport()), { now: NOW });
  const code = sql.split('\n').filter((l) => !l.startsWith('--')).join('\n');
  assert.doesNotMatch(code, /\b(UPDATE|DELETE|DROP|ALTER|REPLACE)\b/i);
  const src = readFileSync(REPO + 'space/scripts/v6-identity-migrate.mjs', 'utf8');
  assert.doesNotMatch(src, /child_process|spawn|execSync|fetch\(/);
  for (const s of [M.SPACE_EXPORT_SQL, M.ACCOUNT_EXPORT_SQL]) for (const part of s.split(';')) assert.match(part.trim(), /^SELECT\b/);
});

test('没有进站密码 / 通行密钥：只建用户和组、搬 root', () => {
  const raw = accountDb();
  raw.exec(M.generateSql(M.parseSpaceExport(spaceExport({ pw: [], pk: [], uh: [] })), { now: NOW }));
  assert.deepEqual(rows(raw, 'SELECT uid FROM account_user_password').map((r) => r.uid), [0]);
  assert.deepEqual(rows(raw, 'SELECT uid FROM account_user_passkey').map((r) => r.uid), [0]);
});

test('导出解析：格式不对 / credId 不一致 / 有通行密钥没 handle / 多行 → 报错', () => {
  assert.throws(() => M.parseSpaceExport([{ results: [] }]), /3 组/);
  assert.throws(() => M.parseSpaceExport(spaceExport({ pk: [{ credential_id: 'x', record: '{"credId":"y"}' }] })), /不一致/);
  assert.throws(() => M.parseSpaceExport(spaceExport({ uh: [] })), /user handle/);
  assert.throws(() => M.parseSpaceExport(spaceExport({ pw: [{ record: '{}' }, { record: '{}' }] })), /至多一行/);
  assert.throws(() => M.parseSpaceExport([{ results: [], success: false }, { results: [] }, { results: [] }]), /success=false/);
  assert.throws(() => M.generateSql(M.parseSpaceExport(spaceExport()), { now: 0 }), /now/);
  assert.equal(M.q("a'b"), "'a''b'");
});
