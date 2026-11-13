/**
 * src/core/d1-state.js 与 D1 上的网关状态（2026-10-27 全部从 KV 搬来；网关不再绑定 KV，运行时不读 KV、没有回落）。
 * - 建表语句（SCHEMA）只剩运行时读写的 attempt_limit 与 audit，每条与 migrations/0001_baseline.sql 一致（旧进站 8 张表的建表语句 v6 P4 收尾删除）
 * - 正式网关不跑迁移：表不存在时第一次查询自建，再整次重试
 * - 出错一律抛（D1 没绑）；网关只有锁屏域：只经 D1_SPACE，'account' / 'root' 一律 bad realm
 * - 源码扫描：网关和共享模块 workers/space-core/src/lib/ 任何源码都不用 withSession（安全读只走主库）
 * v6 P4（定稿 v5.2 §十三）：纪元 / 密码 / 通行密钥 / user handle / challenge 的读写随进站签发删除，对应用例一并删除。
 *
 * 运行：node --test tests/workers/space-core/d1-state.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA, onAuthDb, realmOf, sweepExpired } from '../../../workers/space-core/src/core/d1-state.js';
import { REALM_LOCK } from '../../../workers/space-core/src/core/realms.js';
import { makeAuthD1, forbiddenKV } from '../_harness.mjs';

const MIG_DIR = new URL('../../../workers/space-core/migrations/', import.meta.url);
const GATEWAY = fileURLToPath(new URL('../../../workers/space-core/', import.meta.url));
const envOf = (db) => ({ D1_SPACE: db });

/** 去掉 -- 注释、压空白，按分号拆成语句 */
function statements(sql) {
  return sql.split('\n').map((l) => l.replace(/--.*$/, '')).join(' ').split(';').map((x) => x.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim()).filter(Boolean);
}

/** 旧进站 8 张表（定稿 v5.4 §十一：建表语句删了，生产在部署绿后由 docs/architecture/archive/ops/v6-p4-drop-space-legacy.sql drop） */
const LEGACY8 = ['epoch', 'passkey', 'password', 'user_handle', 'challenge', 'device', 'kv_migration', 'lock_reset_switch'];

test('SCHEMA 只剩运行时读写的 attempt_limit 与 audit（含索引），每条与 migrations/0001_baseline.sql 里的同一条一致；旧进站 8 张表、tempkey、分享表都不在代码兜底里；全部幂等；两个迁移文件', async () => {
  const base = statements(readFileSync(new URL('0001_baseline.sql', MIG_DIR), 'utf8'));
  const mine = SCHEMA.map((s) => statements(s)[0]);
  assert.deepEqual(mine.map((s) => s.replace(/\(.*$/, '').trim()),
    ['CREATE TABLE IF NOT EXISTS attempt_limit', 'CREATE TABLE IF NOT EXISTS audit', 'CREATE INDEX IF NOT EXISTS audit_ts ON audit']);
  for (const s of mine) assert.ok(base.includes(s), '和基线逐字一致：' + s);
  for (const s of SCHEMA) assert.match(s, /^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /, '幂等：代码兜底建表和迁移重复跑都不出错');
  assert.deepEqual(readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort(), ['0001_baseline.sql', '0002_drop_tempkey.sql']);
  for (const s of SCHEMA) assert.doesNotMatch(s, /tempkey|share_link|share_fail/, '代码兜底不建 tempkey / 分享表');
  for (const t of LEGACY8) for (const s of SCHEMA) assert.doesNotMatch(s, new RegExp('EXISTS ' + t + ' '), 'v6 P4 收尾：代码兜底不再建 ' + t + '（Gray 11-11 19:52、20:11）');
  /* drop SQL 文件列着这 8 张 */
  const drop = statements(readFileSync(new URL('../../../docs/architecture/archive/ops/v6-p4-drop-space-legacy.sql', import.meta.url), 'utf8'));
  assert.deepEqual(drop, LEGACY8.map((t) => 'DROP TABLE IF EXISTS ' + t));
  /* 运行时两张表都有 realm 列 */
  const db = makeAuthD1();
  for (const t of ['attempt_limit', 'audit']) {
    const cols = db.raw.prepare('PRAGMA table_info(' + t + ')').all().map((c) => c.name);
    assert.ok(cols.includes('realm'), t + ' 缺 realm 列');
  }
  /* 不再有「已配置」表：configured 由凭证推出，不存 */
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.ok(!tables.some((n) => /configured/.test(n)), tables.join(','));
});

test('v5 收尾 0002_drop_tempkey.sql：在装了 0001 且有数据的库上跑——删 tempkey 表和索引、删 share_link.key_id 列（其余列和行原样）、清 attempt_limit 里 kind=tempkey 的行', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('0001_baseline.sql', MIG_DIR), 'utf8'));
  raw.prepare("INSERT INTO tempkey (realm, id, name, code_hash, link, created_at, expires_at) VALUES ('lock', 'tk1', 'guest', 'h', 0, 1, 9e15)").run();
  raw.prepare("INSERT INTO share_link (id, code, name, target, session_sec, key_id, created_at, expires_at, opens) VALUES ('L1', 'C1', 'n', '/x', 3600, 'tk2', 5, 9e15, 2)").run();
  for (const [kind, bucket] of [['tempkey', '1.2.3'], ['tempkey', '*'], ['password', '1.2.3'], ['spacekey', '*']]) {
    raw.prepare("INSERT INTO attempt_limit (realm, kind, bucket, count, expires_at) VALUES ('lock', ?, ?, 1, 9e15)").run(kind, bucket);
  }
  raw.exec(readFileSync(new URL('0002_drop_tempkey.sql', MIG_DIR), 'utf8'));
  const names = raw.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all().map((r) => r.name);
  assert.ok(!names.includes('tempkey') && !names.includes('tempkey_code'), names.join(','));
  const cols = raw.prepare('PRAGMA table_info(share_link)').all().map((c) => c.name);
  assert.deepEqual(cols, ['id', 'code', 'name', 'target', 'session_sec', 'created_at', 'expires_at', 'revoked_at', 'opens', 'last_open_at']);
  assert.deepEqual({ ...raw.prepare('SELECT id, code, target, session_sec, created_at, opens FROM share_link').get() }, { id: 'L1', code: 'C1', target: '/x', session_sec: 3600, created_at: 5, opens: 2 });
  assert.ok(names.includes('share_link_created'), '分享链接的索引还在');
  assert.deepEqual(raw.prepare('SELECT kind, bucket FROM attempt_limit ORDER BY kind, bucket').all().map((r) => r.kind + ':' + r.bucket), ['password:1.2.3', 'spacekey:*']);
  /* 不带 key_id 的 INSERT（原 core/share-links.js SQL.insert；v6 P4 分享短链删除后模块删了）在迁移后的表上能跑 */
  raw.prepare('INSERT INTO share_link (id, code, name, target, session_sec, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('L2', 'C2', '', '/', 0, 6, 9e15);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM share_link').get().n, 2);
});

test('表不存在（正式网关的部署不跑迁移）：第一次查询自建表，读写照常', async () => {
  const db = makeAuthD1({ migrations: false });
  const env = envOf(db);
  const n = await onAuthDb(env, REALM_LOCK, async (d) => (await d.prepare('SELECT COUNT(*) AS n FROM audit').first()).n);
  assert.equal(Number(n), 0);
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, ['attempt_limit', 'audit'], '兜底只建运行时的两张，旧进站表不会被建回来');
});

test('绑定按域：网关只有锁屏域，只经 D1_SPACE；account / root / 别的 realm 一律拒（账号拆分 PR3）', async () => {
  const lockDb = makeAuthD1();
  await assert.rejects(async () => onAuthDb({}, REALM_LOCK, async () => 1), /d1-missing D1_SPACE/);
  await assert.rejects(async () => onAuthDb({ D1_ACCOUNT_AUTH: lockDb }, REALM_LOCK, async () => 1), /d1-missing D1_SPACE/);
  assert.equal(realmOf('lock'), REALM_LOCK);
  for (const bad of ['account', 'root', { id: 'app' }, { id: 'account', d1Binding: 'D1_SPACE' }]) {
    assert.throws(() => realmOf(bad), /bad realm/, JSON.stringify(bad));
  }
  for (const t of ['epoch', 'device']) await assert.rejects(sweepExpired(lockDb, t, 'lock'), /bad table/, t);
});

test('没有 KV：env 里的 KV 碰一下就抛错，D1 读写照常', async () => {
  const touched = [];
  const db = makeAuthD1();
  const env = { ...envOf(db), KV_LOCK_DOOR: forbiddenKV('KV_LOCK_DOOR', touched), KV_ACCOUNT_LOGIN: forbiddenKV('KV_ACCOUNT_LOGIN', touched) };
  await onAuthDb(env, REALM_LOCK, (d) => d.prepare("INSERT INTO audit (realm, id, ts, ip_prefix, ok, expires_at) VALUES ('lock', 'a1', 1, '1.2.3', 1, 9e15)").run());
  await onAuthDb(env, REALM_LOCK, (d) => sweepExpired(d, 'audit', 'lock', 2));
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM audit').get().n, 1, '没过期的不清');
  assert.deepEqual(touched, []);
});

/** 网关源码（src/）里的 .js */
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
  return out;
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

test('源码扫描：网关和 workers/space-core/src/lib/ 任何源码都不用 withSession（纪元 / 吊销 / challenge / 计数只读主库）', () => {
  const files = gatewaySources();
  assert.ok(files.length > 20, '扫到了网关源码：' + files.length);
  assert.ok(files.some((f) => f.endsWith(path.join('core', 'd1-state.js'))), '扫到了 workers/space-core/src/core/d1-state.js');
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

test('0007（user_handle 加 legacy_handle，预览共库兼容；L2b 起在 migrations-archive/gateway/，基线直接带这一列）：只有一条 ADD COLUMN；跑完基线后 user_handle 读写照旧，代码除了建表语句不读写新列', async () => {
  const sql = readFileSync(new URL('../migrations-archive/gateway/0007_user_handle_legacy_handle.sql', MIG_DIR), 'utf8');
  assert.deepEqual(statements(sql), ["ALTER TABLE user_handle ADD COLUMN legacy_handle TEXT NOT NULL DEFAULT ''"]);
  const db = makeAuthD1();
  assert.deepEqual(db.raw.prepare('PRAGMA table_info(user_handle)').all().map((c) => c.name), ['realm', 'handle', 'legacy_handle']);
  /* v6 P4：进站签发删除，网关源码不再读写 user_handle（收尾起 SCHEMA 也不再建它，源码里没有 legacy_handle） */
  const gwSrc = (d) => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? gwSrc(p) : p.endsWith('.js') ? [readFileSync(p, 'utf8')] : []; });
  assert.ok(!gwSrc(GATEWAY).some((s) => s.replace(/CREATE TABLE IF NOT EXISTS user_handle \([^)]*\)/g, '').replace(/^\s*\*.*$/gm, '').includes('legacy_handle')));
});
