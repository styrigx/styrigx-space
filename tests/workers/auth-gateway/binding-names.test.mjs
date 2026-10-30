/**
 * 存储绑定名（2026-10-24）：绑定名 = <类型>_<存放的内容>；同一资源几套数据就绑几个名字，id 相同；预览与正式同名。
 * 运行：node --test tests/workers/auth-gateway/binding-names.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8');
/** [[...]] 块里 binding 与 id / database_id 的对应 */
function bindings(toml) {
  const out = {};
  for (const block of toml.split(/\n(?=\[\[)/)) {
    const b = block.match(/^binding = "([A-Z0-9_]+)"/m);
    const id = block.match(/^(?:id|database_id) = "([0-9a-f-]+)"/m);
    if (b && id) out[b[1]] = id[1];
  }
  return out;
}

/* 2026-10-27 起网关认证状态全部在 D1 styrigx-auth-gateway，不再绑任何 KV。
   账号拆分 PR3：网关只剩锁屏域 D1_LOCK_AUTH（D1_ACCOUNT_AUTH / D1_ROOT_AUTH 删掉，库里的账号旧行 PR4 已删）。
   Pages 预览跑的是组合入口（tests/web/e2e/preview-worker.js：网关 + 账号 Worker 代码），所以预览另绑 D1_ACCOUNT_AUTH 给账号那一半，
   同一个测试库 styrigx-test-preview。 */
const AUTH = { 'workers/auth-gateway/wrangler.toml': ['D1_LOCK_AUTH'], 'web/wrangler.toml': ['D1_LOCK_AUTH', 'D1_ACCOUNT_AUTH'] };
/* 以前的认证 KV / 重置开关 D1 绑定名：网关和 Pages 预览都不能再出现 */
const AUTH_GONE = ['KV_LOCK_DOOR', 'KV_ACCOUNT_LOGIN', 'D1_LOCK_RESET', 'D1_LOCK_DOOR', 'D1_ACCOUNT_LOGIN'];
/* 2026-10-24 起在账号 Worker styrigx-account（workers/account），网关和 Pages 预览都不再绑定 */
const ACCOUNT = ['KV_PROFILE', 'D1_SETTINGS_SYNC', 'D1_WELLBEING'];
const OLD = /\b(OWNER_KV|ACCOUNT_KV|SGX_D1|SEARCH_KV|STATUS_DB)\b|"CF_USAGE_TOKEN"/;
/** 去掉 # 注释（注释里可以提旧名字，绑定里不行） */
const code = (toml) => toml.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');

test('鉴权网关正式只绑 D1_LOCK_AUTH；Pages 预览（组合入口）另绑 D1_ACCOUNT_AUTH，同一个库；没有任何 KV；不绑 D1_ROOT_AUTH / 账号资料库', () => {
  for (const p of ['workers/auth-gateway/wrangler.toml', 'web/wrangler.toml']) {
    const toml = read(p);
    const src = code(toml);
    assert.doesNotMatch(toml, OLD, p);
    const m = bindings(toml);
    const d1 = [...src.matchAll(/^\[\[(?:env\.preview\.)?d1_databases\]\]\s*\nbinding = "([A-Z0-9_]+)"/gm)].map((x) => x[1]);
    assert.deepEqual(d1.slice().sort(), AUTH[p].slice().sort(), p + '：D1 绑定恰好是这几个');
    for (const n of AUTH[p]) assert.equal(m[n], m.D1_LOCK_AUTH, p + '：' + n + ' 与 D1_LOCK_AUTH 同一个库');
    assert.equal(m.D1_ROOT_AUTH, undefined, p + '：D1_ROOT_AUTH 已删（根域并入锁屏域）');
    /* 正式 = styrigx-auth-gateway；Pages 预览 = 所有 Worker 预览共用的测试库 styrigx-test-preview（2026-10-29） */
    const dbName = p === 'web/wrangler.toml' ? 'styrigx-test-preview' : 'styrigx-auth-gateway';
    assert.match(src, new RegExp('^database_name = "' + dbName + '"$', 'm'), p);
    for (const db of src.match(/^database_name = ".*"$/gm) || []) assert.equal(db, 'database_name = "' + dbName + '"', p + ' ' + db);
    /* 没有 KV：不绑 kv_namespaces，也没有任何 KV_* 绑定名 */
    assert.doesNotMatch(src, /^\[\[(?:env\.preview\.)?kv_namespaces\]\]/m, p + '：不应再有 kv_namespaces');
    assert.doesNotMatch(src, /^binding = "KV_/m, p + '：不应再有 KV_* 绑定');
    for (const n of AUTH_GONE) assert.ok(!new RegExp('\\b' + n + '\\b').test(src), p + ' 不该再绑 ' + n);
    for (const n of ACCOUNT) assert.equal(m[n], undefined, p + ' 不该再绑 ' + n);
    assert.equal((src.match(/^migrations_dir = /gm) || []).length, 1, p + '：migrations_dir 只配一次');
    /* migrations_dir 在 D1_LOCK_AUTH 那一块 */
    const lockBlock = src.split(/\n(?=\[\[)/).find((blk) => /^binding = "D1_LOCK_AUTH"/m.test(blk)) || '';
    assert.match(lockBlock, /^migrations_dir = /m, p + '：migrations_dir 写在 D1_LOCK_AUTH');
  }
});

test('账号 Worker 正式 / 预览：D1_SETTINGS_SYNC = D1_WELLBEING = D1_ACCOUNT_AUTH（styrigx-account），KV 只剩头像 KV_PROFILE，不碰网关认证库', () => {
  const toml = read('workers/account/wrangler.toml');
  assert.doesNotMatch(toml, OLD);
  const [prod, preview] = toml.split(/^\[env\.preview\]$/m);
  const m = bindings(prod);
  for (const n of ACCOUNT) assert.ok(m[n], '缺 ' + n);
  assert.equal(m.KV_SETTINGS_SYNC, undefined, 'KV_SETTINGS_SYNC 已删（2026-10-27 设置同步搬到 D1）');
  assert.equal(m.KV_PROFILE, 'b20701f5f48e498e897bc6f0bd81643f');
  assert.equal(m.D1_WELLBEING, '03f60d23-9c2f-4f3d-a692-764ccaac6f5d');
  assert.equal(m.D1_SETTINGS_SYNC, m.D1_WELLBEING, '设置同步和数字健康是同一个库');
  /* 2026-10-29 PR2：账号 Worker 只绑 D1_ACCOUNT_AUTH，而且指向账号库 styrigx-account（不是网关的认证库）；锁屏 / 根的认证绑定一个都不绑 */
  assert.equal(m.D1_ACCOUNT_AUTH, m.D1_WELLBEING, 'D1_ACCOUNT_AUTH = 账号库 styrigx-account');
  assert.notEqual(m.D1_ACCOUNT_AUTH, '6931d1da-3502-480d-b0bd-de1bc4829d1d', '不许指向网关认证库');
  for (const n of ['D1_LOCK_AUTH', 'D1_ROOT_AUTH'].concat(AUTH_GONE)) assert.equal(m[n], undefined, '账号 Worker 不该绑 ' + n);
  const pm = bindings(code(preview));
  for (const n of ['D1_LOCK_AUTH', 'D1_ROOT_AUTH'].concat(AUTH_GONE)) assert.equal(pm[n], undefined, '账号 Worker 预览不该绑 ' + n);
  assert.equal(pm.D1_ACCOUNT_AUTH, pm.D1_WELLBEING, '预览 D1_ACCOUNT_AUTH = 测试库');
  assert.equal(pm.KV_PROFILE, '193b4d68b8ac4c6f8c0ba16b5ea78b14', '预览 KV = 测试专用 namespace');
  assert.equal(pm.KV_SETTINGS_SYNC, undefined);
  /* 预览 D1 = 测试库 styrigx-test-preview（2026-10-29），两个名字同一个库，绝不是正式库 */
  assert.equal(pm.D1_WELLBEING, '1339bb0b-f9f8-4e3d-b413-ff07ca28ce69');
  assert.equal(pm.D1_SETTINGS_SYNC, pm.D1_WELLBEING);
  assert.notEqual(pm.D1_WELLBEING, m.D1_WELLBEING);
});

test('搜索 / 监测：KV_SEARCH_INDEX、D1_UPTIME_MONITOR + D1_CLOUDFLARE_USAGE、SGX_CF_USAGE_TOKEN', () => {
  const s = read('workers/search-index/wrangler.toml');
  assert.doesNotMatch(s, OLD);
  assert.ok(bindings(s).KV_SEARCH_INDEX);
  const st = read('workers/status/wrangler.toml');
  assert.doesNotMatch(st, OLD);
  const m = bindings(st);
  assert.ok(m.D1_UPTIME_MONITOR);
  assert.equal(m.D1_UPTIME_MONITOR, m.D1_CLOUDFLARE_USAGE);
  assert.match(st, /binding = "SGX_CF_USAGE_TOKEN"\nstore_id = "[0-9a-f]+"\nsecret_name = "SGX_CF_USAGE_TOKEN"/);
});

test('预览统一用测试资源（2026-10-29）：网关 / 账号 / 短链的预览 D1 都是 styrigx-test-preview，迁移记录表各不相同，CI 三套迁移都跑', () => {
  const TEST_D1 = '1339bb0b-f9f8-4e3d-b413-ff07ca28ce69';
  const files = { 'web/wrangler.toml': 'workers/auth-gateway/wrangler.toml', 'workers/account/wrangler.toml': null, 'workers/share/wrangler.toml': null };
  const tables = new Set();
  for (const [p, prodPath] of Object.entries(files)) {
    const src = code(read(p));
    const parts = src.split(/^\[env\.preview\]$/m);
    const prod = prodPath ? code(read(prodPath)) : parts[0];
    const preview = prodPath ? src : parts[1];
    const blocks = preview.split(/\n(?=\[\[)/).filter((b) => /^\[\[env\.preview\.d1_databases\]\]/.test(b));
    assert.ok(blocks.length > 0, p + '：预览要有 D1');
    const tbl = new Set();
    for (const b of blocks) {
      assert.match(b, /^database_name = "styrigx-test-preview"$/m, p);
      assert.equal((b.match(/^database_id = "([0-9a-f-]+)"$/m) || [])[1], TEST_D1, p);
      tbl.add((b.match(/^migrations_table = "([a-z0-9_]+)"$/m) || [, 'd1_migrations'])[1]);
    }
    /* 同一个 Worker 的几个绑定（同一个库）用同一张记录表；不同 Worker 不能共用 */
    assert.equal(tbl.size, 1, p + '：' + [...tbl].join(','));
    const t = [...tbl][0];
    assert.ok(!tables.has(t), p + '：迁移记录表 ' + t + ' 和别的 Worker 重了');
    tables.add(t);
    /* 正式块不动：不出现测试库，也不改迁移记录表（改了会让正式库把迁移重跑一遍） */
    assert.ok(!prod.split(/^\[env\.preview\]$/m)[0].includes(TEST_D1), p + '：正式不许指向测试库');
    assert.doesNotMatch(prod.split(/^\[env\.preview\]$/m)[0], /^migrations_table = /m, p + '：正式不设 migrations_table');
  }
  /* 旧的预览资源一个都不许再出现（代码里，注释也不许） */
  for (const p of Object.keys(files).concat(['.github/workflows/deploy.yml'])) {
    assert.doesNotMatch(read(p), /styrigx-auth-gateway-preview|d417e421-75bb-4425-bdc8-54856b88578f|03e1f9f4-dd7e-47cc-abe7-79dc5afe3e81|a5ee2a75f00d4308959b2bea55247ff6|5084ea8ef2444156ba48203220b93df6/, p);
  }
  /* CI：部署预览前对测试库跑三套迁移（网关在 web/，账号 / 短链在各自目录，都 --env preview） */
  const wf = read('.github/workflows/deploy.yml');
  const step = wf.slice(wf.indexOf('- name: Apply D1 migrations to preview'), wf.indexOf('- name: Deploy to preview'));
  assert.match(step, /working-directory: web\n/);
  assert.match(step, /\n {10}npx --yes "wrangler@\$WRANGLER_VERSION" d1 migrations apply styrigx-test-preview --remote --env preview\n/);
  for (const d of ['account', 'share']) {
    assert.ok(step.includes('(cd ../workers/' + d + ' && npx --yes "wrangler@$WRANGLER_VERSION" d1 migrations apply styrigx-test-preview --remote --env preview)'), d);
  }
  for (const t of tables) assert.ok(step.includes('FROM ' + t + ' '), 'CI 列出 ' + t);
});
