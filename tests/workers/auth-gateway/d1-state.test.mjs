/**
 * _kernel/d1-state.js 与 D1 上的认证状态（2026-10-27 全部从 KV 搬来；网关不再绑定 KV，运行时不读 KV、没有回落）。
 * - 建表语句（SCHEMA）与 migrations/0005_lock_account_state.sql + 0006_auth_state.sql 逐条一致；迁移编号不和别的撞
 * - 正式网关不跑迁移：表不存在时第一次查询自建，再整次重试
 * - 纪元：每次都读 D1（不缓存，D1 里一变下一次读就是新值）；原子自增（并发推进拿到的值两两不同）；新库从 0 起步
 * - 出错一律抛（D1 出错、D1 没绑），不写；绑定按域：lock 只经 D1_LOCK_AUTH，account 只经 D1_ACCOUNT_AUTH，root 只经 D1_ROOT_AUTH
 * - 密码 / 通行密钥只读写 D1；env 里放一个碰一下就抛错的 KV 也照常工作
 * - challenge：一条 DELETE ... WHERE realm AND id AND purpose AND expires_at > now RETURNING 消费；
 *   并发两次只有一次成功；过期的在被清掉之前就不认；purpose / realm 对不上不认也不删
 * - 源码扫描：网关和共享模块 workers/shared/ 任何源码都不用 withSession（安全读只走主库）
 *
 * 运行：node --test tests/workers/auth-gateway/d1-state.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA, readEpoch, bumpEpoch, getPasswordRecord, putPasswordRecord, deletePasswordRecord, listPasskeyRecords, putPasskeyRecord,
  getPasskeyRecord, deletePasskeyRecord, updatePasskeyRecord, userHandleRecord,
} from '../../../workers/auth-gateway/functions/_kernel/d1-state.js';
import { issueChallenge, consumeChallenge } from '../../../workers/shared/passkey-verify.js';
import { REALM_LOCK, REALM_ACCOUNT, REALM_ROOT } from '../../../workers/auth-gateway/functions/_kernel/realms.js';
import { makeAuthD1, forbiddenKV } from '../_harness.mjs';

const MIG_DIR = new URL('../../../workers/auth-gateway/migrations/', import.meta.url);
const GATEWAY = fileURLToPath(new URL('../../../workers/auth-gateway/', import.meta.url));
const envOf = (db) => ({ D1_LOCK_AUTH: db, D1_ACCOUNT_AUTH: db, D1_ROOT_AUTH: db });

/** 去掉 -- 注释、压空白，按分号拆成语句 */
function statements(sql) {
  return sql.split('\n').map((l) => l.replace(/--.*$/, '')).join(' ').split(';').map((x) => x.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim()).filter(Boolean);
}

test('SCHEMA 与 migrations/0005 + 0006 逐条一致（按文件顺序）；全部幂等；迁移编号在本库里不重复', () => {
  const files = ['0005_lock_account_state.sql', '0006_auth_state.sql'].map((f) => readFileSync(new URL(f, MIG_DIR), 'utf8'));
  assert.deepEqual(files.flatMap(statements), SCHEMA.map((s) => statements(s)[0]));
  for (const s of SCHEMA) assert.match(s, /^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /, '幂等：代码兜底建表和迁移重复跑都不出错');
  const nums = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).map((f) => f.slice(0, 4));
  assert.equal(new Set(nums).size, nums.length, nums.join(','));
  /* 0006 的六张表都有 realm 列 */
  const db = makeAuthD1();
  for (const t of ['user_handle', 'challenge', 'attempt_limit', 'tempkey', 'device', 'audit', 'epoch', 'passkey', 'password']) {
    const cols = db.raw.prepare('PRAGMA table_info(' + t + ')').all().map((c) => c.name);
    assert.ok(cols.includes('realm'), t + ' 缺 realm 列');
  }
  /* 不再有「已配置」表：configured 由凭证推出，不存 */
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.ok(!tables.some((n) => /configured/.test(n)), tables.join(','));
});

test('表不存在（正式网关的部署不跑迁移）：第一次查询自建表，读写照常', async () => {
  const db = makeAuthD1({ migrations: false });
  const env = envOf(db);
  assert.equal(await readEpoch(env, REALM_LOCK), 0);
  assert.equal(await bumpEpoch(env, REALM_ACCOUNT), 1);
  await putPasskeyRecord(env, REALM_LOCK, { credId: 'c1', publicKey: 'pk' });
  assert.deepEqual((await listPasskeyRecords(env, REALM_LOCK)).map((r) => r.credId), ['c1']);
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, ['attempt_limit', 'audit', 'challenge', 'device', 'epoch', 'kv_migration', 'passkey', 'password', 'tempkey', 'user_handle']);
});

test('纪元：每次都读 D1（不缓存）——D1 里改了，下一次读就是新值；新库从 0 起步', async () => {
  const db = makeAuthD1();
  const env = envOf(db);
  assert.equal(await readEpoch(env, REALM_ACCOUNT), 0, '新库：从没推进过');
  db.setEpoch('lock', 42);
  assert.deepEqual(await Promise.all([readEpoch(env, REALM_LOCK), readEpoch(env, REALM_LOCK)]), [42, 42]);
  db.setEpoch('lock', 43); /* 别的请求推进了纪元（吊销）：这一次读必须看到 */
  assert.equal(await readEpoch(env, REALM_LOCK), 43);
  const before = db.calls.length;
  await readEpoch(env, REALM_LOCK);
  assert.ok(db.calls.slice(before).some((s) => /^SELECT value FROM epoch WHERE realm = \?$/.test(s)), '每一次读都查了 D1');
});

test('纪元：原子自增——10 次并发推进拿到 10 个不同的值，最后 = 起点 + 10', async () => {
  const db = makeAuthD1({ epochs: { account: 4 } });
  const env = envOf(db);
  const got = await Promise.all(Array.from({ length: 10 }, () => bumpEpoch(env, REALM_ACCOUNT)));
  assert.deepEqual(got.slice().sort((a, b) => a - b), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.equal(db.epoch('account'), 14);
  assert.equal(db.epoch('lock'), null, '推进 account 不碰 lock');
  assert.ok(db.calls.some((s) => /^UPDATE epoch SET value = value \+ 1 WHERE realm = \? RETURNING value$/.test(s)), '用的是 UPDATE ... RETURNING');
});

test('纪元：读 / 推进出错都抛错且不写（D1 出错、D1 没绑）', async () => {
  const db = makeAuthD1({ epochs: { lock: 5 } });
  db.failOn = (sql) => /^UPDATE/.test(sql);
  await assert.rejects(bumpEpoch(envOf(db), REALM_LOCK));
  assert.equal(db.epoch('lock'), 5);
  db.failOn = (sql) => /FROM epoch/.test(sql);
  await assert.rejects(readEpoch(envOf(db), REALM_LOCK));
  await assert.rejects(readEpoch({}, REALM_LOCK), /d1-missing D1_LOCK_AUTH/);
  await assert.rejects(bumpEpoch({}, REALM_ACCOUNT), /d1-missing D1_ACCOUNT_AUTH/);
});

test('绑定按域：lock 只经 D1_LOCK_AUTH，account 只经 D1_ACCOUNT_AUTH，root 只经 D1_ROOT_AUTH；别的 realm 拒', async () => {
  const lockDb = makeAuthD1();
  const onlyLock = { D1_LOCK_AUTH: lockDb };
  assert.equal(await bumpEpoch(onlyLock, REALM_LOCK), 1);
  await assert.rejects(readEpoch(onlyLock, REALM_ACCOUNT), /d1-missing D1_ACCOUNT_AUTH/);
  await assert.rejects(getPasswordRecord(onlyLock, REALM_ACCOUNT), /d1-missing D1_ACCOUNT_AUTH/);
  await assert.rejects(issueChallenge(onlyLock, REALM_ROOT, 'x', 'c', 60), /d1-missing D1_ROOT_AUTH/);
  await assert.rejects(readEpoch(onlyLock, { id: 'app' }), /bad realm/);
});

test('没有 KV：env 里的 KV 碰一下就抛错，密码 / 通行密钥 / user handle / 纪元 / challenge 照常读写', async () => {
  const touched = [];
  const db = makeAuthD1();
  const env = { ...envOf(db), KV_LOCK_DOOR: forbiddenKV('KV_LOCK_DOOR', touched), KV_ACCOUNT_LOGIN: forbiddenKV('KV_ACCOUNT_LOGIN', touched) };
  await putPasswordRecord(env, REALM_LOCK, { salt: 's', hash: 'H' });
  assert.equal((await getPasswordRecord(env, REALM_LOCK)).hash, 'H');
  await putPasskeyRecord(env, REALM_ACCOUNT, { credId: 'k1', publicKey: 'pk' });
  assert.equal((await getPasskeyRecord(env, REALM_ACCOUNT, 'k1')).publicKey, 'pk');
  assert.equal(await userHandleRecord(env, REALM_LOCK, true, () => 'h1'), 'h1');
  assert.equal(await bumpEpoch(env, REALM_LOCK), 1);
  const cid = await issueChallenge(env, REALM_LOCK, 'auth', 'CH', 60);
  assert.equal((await consumeChallenge(env, REALM_LOCK, 'auth', cid)).challenge, 'CH');
  assert.deepEqual(touched, []);
});

test('密码：只读写 D1；改完下一次读就是新的；删了就没有（没有任何回落来源）', async () => {
  const db = makeAuthD1();
  const env = envOf(db);
  const lockRec = { salt: 's', hash: 'H1', iterations: 100000, peppered: true, updatedAt: 1 };
  db.putPassword('lock', lockRec);
  assert.deepEqual(await getPasswordRecord(env, REALM_LOCK), lockRec);
  assert.equal(await getPasswordRecord(env, REALM_ACCOUNT), null, 'account 读自己那一行');
  await putPasswordRecord(env, REALM_LOCK, { ...lockRec, hash: 'H2' });
  assert.equal((await getPasswordRecord(env, REALM_LOCK)).hash, 'H2', '改完下一次读就是新的（KV 时代最长约 60 秒还读到旧的）');
  await deletePasswordRecord(env, REALM_LOCK);
  assert.equal(await getPasswordRecord(env, REALM_LOCK), null);
  assert.deepEqual(db.rows('password'), []);
  assert.deepEqual(db.rows('kv_migration'), [], '运行时从不写导入标记');
});

test('通行密钥：更新只改还在的那条（删掉的不会被写回来）；删返回被删的记录', async () => {
  const db = makeAuthD1();
  const env = envOf(db);
  await putPasskeyRecord(env, REALM_LOCK, { credId: 'a', signCount: 1 });
  assert.equal(await updatePasskeyRecord(env, REALM_LOCK, { credId: 'a', signCount: 2 }), true);
  assert.equal((await deletePasskeyRecord(env, REALM_LOCK, 'a')).signCount, 2);
  assert.equal(await updatePasskeyRecord(env, REALM_LOCK, { credId: 'a', signCount: 3 }), false);
  assert.equal(await getPasskeyRecord(env, REALM_LOCK, 'a'), null);
  assert.equal(await deletePasskeyRecord(env, REALM_LOCK, 'a'), null);
});

/* ---------------- challenge ---------------- */

test('challenge：只经一条 DELETE ... WHERE realm AND id AND purpose AND expires_at > now RETURNING 消费，消费前不先 SELECT', async () => {
  const db = makeAuthD1();
  const env = envOf(db);
  const cid = await issueChallenge(env, REALM_ACCOUNT, 'login', 'CH1', 300);
  const before = db.calls.length;
  const got = await consumeChallenge(env, REALM_ACCOUNT, 'login', cid);
  assert.equal(got.challenge, 'CH1');
  assert.equal(got.purpose, 'login');
  const sqls = db.calls.slice(before);
  assert.deepEqual(sqls, ['DELETE FROM challenge WHERE realm = ? AND id = ? AND purpose = ? AND expires_at > ? RETURNING challenge, purpose, expires_at']);
  assert.deepEqual(db.rows('challenge'), [], '消费完就没了');
  assert.equal(await consumeChallenge(env, REALM_ACCOUNT, 'login', cid), null, '第二次消费拿不到');
});

test('challenge：同一个 cid 并发两次消费，恰好一次成功', async () => {
  for (let i = 0; i < 20; i++) {
    const db = makeAuthD1();
    const env = envOf(db);
    const cid = await issueChallenge(env, REALM_LOCK, 'auth', 'CH-' + i, 300);
    const res = await Promise.all([consumeChallenge(env, REALM_LOCK, 'auth', cid), consumeChallenge(env, REALM_LOCK, 'auth', cid)]);
    assert.equal(res.filter(Boolean).length, 1, JSON.stringify(res));
    assert.equal(res.find(Boolean).challenge, 'CH-' + i);
  }
});

test('challenge：过期的在被清掉之前就不认（行还在，消费照样拿不到）', async () => {
  const db = makeAuthD1();
  const env = envOf(db);
  db.raw.prepare('INSERT INTO challenge (realm, id, purpose, challenge, expires_at) VALUES (?, ?, ?, ?, ?)').run('lock', 'old-cid', 'auth', 'OLD', Date.now() - 1);
  assert.equal(await consumeChallenge(env, REALM_LOCK, 'auth', 'old-cid'), null);
  assert.equal(db.rows('challenge').length, 1, '没有清理，靠 expires_at > now 拒的');
  /* 正好到期（expires_at == now）也不认 */
  const now = Date.now() + 5000;
  db.raw.prepare('INSERT INTO challenge (realm, id, purpose, challenge, expires_at) VALUES (?, ?, ?, ?, ?)').run('lock', 'edge', 'auth', 'E', now);
  const realNow = Date.now;
  Date.now = () => now;
  try {
    assert.equal(await consumeChallenge(env, REALM_LOCK, 'auth', 'edge'), null);
  } finally {
    Date.now = realNow;
  }
});

test('challenge：purpose / realm 对不上不认也不删；签发时顺手清掉本域过期的；出错当作没有', async () => {
  const db = makeAuthD1();
  const env = envOf(db);
  const cid = await issueChallenge(env, REALM_LOCK, 'register', 'R', 300);
  assert.equal(await consumeChallenge(env, REALM_LOCK, 'auth', cid), null, 'purpose 不对');
  assert.equal(await consumeChallenge(env, REALM_ACCOUNT, 'register', cid), null, 'realm 不对');
  assert.equal(db.rows('challenge').length, 1, '对不上的不删');
  assert.equal(await consumeChallenge(env, REALM_LOCK, 'register', ''), null);
  assert.equal(await consumeChallenge(env, REALM_LOCK, 'register', /** @type {any} */ (null)), null);
  db.raw.prepare('INSERT INTO challenge (realm, id, purpose, challenge, expires_at) VALUES (?, ?, ?, ?, ?)').run('lock', 'stale', 'auth', 'S', Date.now() - 1000);
  db.raw.prepare('INSERT INTO challenge (realm, id, purpose, challenge, expires_at) VALUES (?, ?, ?, ?, ?)').run('account', 'stale2', 'login', 'S', Date.now() - 1000);
  await issueChallenge(env, REALM_LOCK, 'auth', 'N', 300);
  const ids = db.rows('challenge').map((r) => r.id);
  assert.ok(!ids.includes('stale'), '本域过期的清掉');
  assert.ok(ids.includes('stale2'), '别的域不碰');
  db.failOn = (sql) => /^DELETE FROM challenge/.test(sql);
  assert.equal(await consumeChallenge(env, REALM_LOCK, 'register', cid), null, 'D1 出错按没有处理（fail closed）');
});

/* ---------------- 源码扫描 ---------------- */

/** 网关源码（src/ + functions/）和共享模块（workers/shared/，网关、账号、分享 Worker 共用）里的 .js */
function gatewaySources() {
  const out = [];
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      const p = path.join(dir, n);
      if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p); continue; }
      if (/\.(m?js|cjs|ts)$/.test(n)) out.push(p);
    }
  };
  walk(path.join(GATEWAY, 'src'));
  walk(path.join(GATEWAY, 'functions'));
  walk(path.join(GATEWAY, '..', 'shared'));
  return out;
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

test('源码扫描：网关和 workers/shared/ 任何源码都不用 withSession（纪元 / 吊销 / challenge / 计数只读主库）', () => {
  const files = gatewaySources();
  assert.ok(files.length > 20, '扫到了网关源码：' + files.length);
  assert.ok(files.some((f) => f.endsWith(path.join('shared', 'd1-state.js'))), '扫到了 workers/shared/d1-state.js');
  const bad = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (/withSession/.test(stripComments(src))) bad.push(path.relative(GATEWAY, f));
    /* 注释也不许教人用（「必须用 'first-primary'」这类说法会被照抄）；只许说「不用」 */
    for (const line of src.split('\n')) {
      if (/withSession\s*\(/.test(line)) bad.push(path.relative(GATEWAY, f) + ': ' + line.trim());
    }
  }
  assert.deepEqual(bad, []);
  /* 也不读任何 KV 绑定（运行时没有 KV 回落） */
  const kv = files.filter((f) => /\benv\s*(\.|\[\s*['"])KV_/.test(stripComments(readFileSync(f, 'utf8'))));
  assert.deepEqual(kv.map((f) => path.relative(GATEWAY, f)), []);
});

test('0007（user_handle 加 legacy_handle，预览共库兼容）：只有一条 ADD COLUMN；网关跑完全部迁移后 user_handle 读写照旧，代码不读写新列', async () => {
  const sql = readFileSync(new URL('0007_user_handle_legacy_handle.sql', MIG_DIR), 'utf8');
  assert.deepEqual(statements(sql), ["ALTER TABLE user_handle ADD COLUMN legacy_handle TEXT NOT NULL DEFAULT ''"]);
  const db = makeAuthD1();
  assert.deepEqual(db.raw.prepare('PRAGMA table_info(user_handle)').all().map((c) => c.name), ['realm', 'handle', 'legacy_handle']);
  const env = envOf(db);
  const h1 = await userHandleRecord(env, REALM_LOCK, true, () => 'LOCK-H');
  assert.equal(h1, 'LOCK-H');
  assert.equal(await userHandleRecord(env, REALM_LOCK, true, () => 'OTHER'), 'LOCK-H', '已有就复用');
  assert.equal(await userHandleRecord(env, REALM_ACCOUNT, false, () => 'X'), '', '不新建 → 空');
  assert.deepEqual({ ...db.raw.prepare("SELECT * FROM user_handle WHERE realm = 'lock'").get() }, { realm: 'lock', handle: 'LOCK-H', legacy_handle: '' });
  /* 网关源码不碰这一列 */
  const gwSrc = (d) => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? gwSrc(p) : p.endsWith('.js') ? [readFileSync(p, 'utf8')] : []; });
  assert.ok(!gwSrc(GATEWAY).some((s) => s.includes('legacy_handle')));
});
