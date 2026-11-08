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
   账号拆分 PR3：网关只剩锁屏域 D1_LOCK_AUTH（D1_ROOT_AUTH 删掉，库里的账号旧行 PR4 已删）。
   Pages 预览跑的是组合入口（tests/space/e2e/helpers/preview-worker.js：网关 + 账号 Worker 代码），所以预览另绑 D1_ACCOUNT 给账号那一半
   （命名 v2：账号库一个名字），同一个测试库 styrigx-test-preview。 */
const AUTH = { 'workers/auth-gateway/wrangler.toml': ['D1_LOCK_AUTH'], 'space/web/wrangler.toml': ['D1_LOCK_AUTH', 'D1_ACCOUNT'] };
/* 以前的认证 KV / 重置开关 D1 绑定名：网关和 Pages 预览都不能再出现 */
const AUTH_GONE = ['KV_LOCK_DOOR', 'KV_ACCOUNT_LOGIN', 'D1_LOCK_RESET', 'D1_LOCK_DOOR', 'D1_ACCOUNT_LOGIN'];
/* 命名 v2：账号库以前三个名字指向同一个库，现在只叫 D1_ACCOUNT；旧名哪里都不许再绑 */
const ACCOUNT_GONE = ['D1_ACCOUNT_AUTH', 'D1_SETTINGS_SYNC', 'D1_WELLBEING'];
/* 2026-10-24 起在账号 Worker styrigx-account（workers/account），网关和 Pages 预览都不再绑定 */
const ACCOUNT = ['KV_PROFILE'].concat(ACCOUNT_GONE);
const OLD = /\b(OWNER_KV|ACCOUNT_KV|SGX_D1|SEARCH_KV|STATUS_DB)\b|"CF_USAGE_TOKEN"/;
/** 去掉 # 注释（注释里可以提旧名字，绑定里不行） */
const code = (toml) => toml.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');

test('鉴权网关正式只绑 D1_LOCK_AUTH；Pages 预览（组合入口）另绑 D1_ACCOUNT，同一个库；没有任何 KV；不绑 D1_ROOT_AUTH / 账号资料库', () => {
  for (const p of ['workers/auth-gateway/wrangler.toml', 'space/web/wrangler.toml']) {
    const toml = read(p);
    const src = code(toml);
    assert.doesNotMatch(toml, OLD, p);
    const m = bindings(toml);
    const d1 = [...src.matchAll(/^\[\[(?:env\.preview\.)?d1_databases\]\]\s*\nbinding = "([A-Z0-9_]+)"/gm)].map((x) => x[1]);
    assert.deepEqual(d1.slice().sort(), AUTH[p].slice().sort(), p + '：D1 绑定恰好是这几个');
    for (const n of AUTH[p]) assert.equal(m[n], m.D1_LOCK_AUTH, p + '：' + n + ' 与 D1_LOCK_AUTH 同一个库');
    assert.equal(m.D1_ROOT_AUTH, undefined, p + '：D1_ROOT_AUTH 已删（根域并入锁屏域）');
    /* 正式 = 主站共用库 styrigx-space-gateway（2026-11 合库，前身 styrigx-auth-gateway）；Pages 预览 = 所有 Worker 预览共用的测试库 styrigx-test-preview（2026-10-29） */
    const dbName = p === 'space/web/wrangler.toml' ? 'styrigx-test-preview' : 'styrigx-space-gateway';
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

test('账号 Worker 正式 / 预览：只有一个 D1 绑定 D1_ACCOUNT（styrigx-account），KV 只剩头像 KV_PROFILE，不碰网关认证库', () => {
  const toml = read('workers/account/wrangler.toml');
  assert.doesNotMatch(toml, OLD);
  const [prod, preview] = toml.split(/^\[env\.preview\]$/m);
  const m = bindings(code(prod));
  assert.equal(m.KV_SETTINGS_SYNC, undefined, 'KV_SETTINGS_SYNC 已删（2026-10-27 设置同步搬到 D1）');
  assert.equal(m.KV_PROFILE, 'b20701f5f48e498e897bc6f0bd81643f');
  /* 命名 v2：设置同步 / 数字健康 / 账号身份是同一个库，只叫 D1_ACCOUNT（功能靠表名分：settings_sync、wb_daily、account_*） */
  assert.equal(m.D1_ACCOUNT, '03f60d23-9c2f-4f3d-a692-764ccaac6f5d', 'D1_ACCOUNT = 账号库 styrigx-account');
  assert.notEqual(m.D1_ACCOUNT, '6931d1da-3502-480d-b0bd-de1bc4829d1d', '不许指向网关认证库');
  const d1 = (src) => [...code(src).matchAll(/^\[\[(?:env\.preview\.)?d1_databases\]\]\s*\nbinding = "([A-Z0-9_]+)"/gm)].map((x) => x[1]);
  assert.deepEqual(d1(prod), ['D1_ACCOUNT'], '正式只有一个 D1 绑定');
  assert.deepEqual(d1(preview), ['D1_ACCOUNT'], '预览只有一个 D1 绑定');
  for (const n of ['D1_LOCK_AUTH', 'D1_ROOT_AUTH'].concat(AUTH_GONE, ACCOUNT_GONE)) assert.equal(m[n], undefined, '账号 Worker 不该绑 ' + n);
  const pm = bindings(code(preview));
  for (const n of ['D1_LOCK_AUTH', 'D1_ROOT_AUTH'].concat(AUTH_GONE, ACCOUNT_GONE)) assert.equal(pm[n], undefined, '账号 Worker 预览不该绑 ' + n);
  assert.equal(pm.KV_PROFILE, '193b4d68b8ac4c6f8c0ba16b5ea78b14', '预览 KV = 测试专用 namespace');
  assert.equal(pm.KV_SETTINGS_SYNC, undefined);
  /* 预览 D1 = 测试库 styrigx-test-preview（2026-10-29），绝不是正式库 */
  assert.equal(pm.D1_ACCOUNT, '1339bb0b-f9f8-4e3d-b413-ff07ca28ce69');
  assert.notEqual(pm.D1_ACCOUNT, m.D1_ACCOUNT);
});

test('搜索 / 监测：KV_SEARCH_INDEX（P4-2b 起只在 ai）、D1_UPTIME_MONITOR + D1_CLOUDFLARE_USAGE、SGX_CF_USAGE_TOKEN', () => {
  const s = read('workers/ai/wrangler.toml');
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
  const files = { 'space/web/wrangler.toml': 'workers/auth-gateway/wrangler.toml', 'workers/account/wrangler.toml': null, 'workers/share/wrangler.toml': null };
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
    /* 正式块：不出现测试库。迁移记录表：账号（独立库 styrigx-account）不设；网关 / 短链在主站共用库 styrigx-space-gateway 里各用各的（2026-11 合库） */
    const prodTop = prod.split(/^\[env\.preview\]$/m)[0];
    assert.ok(!prodTop.includes(TEST_D1), p + '：正式不许指向测试库');
    const wantProdTable = { 'space/web/wrangler.toml': 'd1_migrations_gateway', 'workers/account/wrangler.toml': null, 'workers/share/wrangler.toml': 'd1_migrations_share' }[p];
    if (wantProdTable) assert.match(prodTop, new RegExp('^migrations_table = "' + wantProdTable + '"$', 'm'), p);
    else assert.doesNotMatch(prodTop, /^migrations_table = /m, p + '：正式不设 migrations_table');
  }
  /* 旧的预览资源一个都不许再出现（代码里，注释也不许） */
  for (const p of Object.keys(files).concat(['.github/workflows/deploy.yml'])) {
    assert.doesNotMatch(read(p), /styrigx-auth-gateway-preview|d417e421-75bb-4425-bdc8-54856b88578f|03e1f9f4-dd7e-47cc-abe7-79dc5afe3e81|a5ee2a75f00d4308959b2bea55247ff6|5084ea8ef2444156ba48203220b93df6/, p);
  }
  /* CI：部署预览前对测试库跑三套迁移（网关在 space/web/，账号 / 短链在各自目录，都 --env preview） */
  const wf = read('.github/workflows/deploy.yml');
  const step = wf.slice(wf.indexOf('- name: Apply D1 migrations to preview'), wf.indexOf('- name: Deploy to preview'));
  assert.match(step, /working-directory: space\/web\n/);
  assert.match(step, /\n {10}npx --yes "wrangler@\$WRANGLER_VERSION" d1 migrations apply styrigx-test-preview --remote --env preview\n/);
  for (const d of ['account', 'share']) {
    assert.ok(step.includes('(cd ../../workers/' + d + ' && npx --yes "wrangler@$WRANGLER_VERSION" d1 migrations apply styrigx-test-preview --remote --env preview)'), d);
  }
  for (const t of tables) assert.ok(step.includes('FROM ' + t + ' '), 'CI 列出 ' + t);
});

test('主站数据一套 styrigx-space-gateway（2026-11 合库）：网关 / 短链 / 监测各自独立、D1 同一个库、迁移记录表各一张；搜索索引 KV 同名一套；账号 D1 / KV 不动', () => {
  const SPACE_D1 = '39d037fe-6ab3-410d-a090-4d7ce8d48d83';
  const SPACE_KV = '608cf3e27184481cbca2922950506d87';
  const top = (p) => code(read(p)).split(/^\[env\.preview\]$/m)[0];
  const want = { 'workers/auth-gateway/wrangler.toml': ['D1_LOCK_AUTH', 'd1_migrations_gateway'],
    'workers/share/wrangler.toml': ['D1_SHARE_LINK', 'd1_migrations_share'],
    'workers/status/wrangler.toml': ['D1_UPTIME_MONITOR', 'd1_migrations_status'] };
  const tables = new Set();
  for (const [p, [first, table]] of Object.entries(want)) {
    const src = top(p);
    for (const db of src.match(/^database_name = ".*"$/gm)) assert.equal(db, 'database_name = "styrigx-space-gateway"', p);
    for (const id of src.match(/^database_id = ".*"$/gm)) assert.equal(id, 'database_id = "' + SPACE_D1 + '"', p);
    const blk = src.split(/\n(?=\[\[)/).find((b) => new RegExp('^binding = "' + first + '"', 'm').test(b));
    assert.match(blk, new RegExp('^migrations_dir = "migrations"\nmigrations_table = "' + table + '"$', 'm'), p);
    assert.equal((src.match(/^migrations_table = /gm) || []).length, 1, p);
    assert.ok(!tables.has(table)); tables.add(table);
  }
  /* 旧库 id 不再出现在任何绑定里 */
  for (const p of Object.keys(want)) assert.doesNotMatch(code(read(p)), /6931d1da-3502-480d-b0bd-de1bc4829d1d|59bddcea-17cb-466a-90c9-16606d5b4b7e|31970da7-4b8f-4180-ad93-c170649188dc/, p);
  /* 搜索索引 KV：读的 ai 和写的 curio-core / daymark-core 一起换到 styrigx-space-gateway（只换一边会读写两个命名空间） */
  for (const p of ['workers/ai/wrangler.toml', 'workers/curio-core/wrangler.toml', 'workers/daymark-core/wrangler.toml']) {
    assert.equal(bindings(code(read(p))).KV_SEARCH_INDEX, SPACE_KV, p);
    assert.doesNotMatch(code(read(p)), /bd1babcc3fe74d58994e254c74d34ced/, p);
  }
  /* 账号独立：D1 styrigx-account、KV_PROFILE 不动 */
  const acct = top('workers/account/wrangler.toml');
  assert.doesNotMatch(acct, new RegExp(SPACE_D1 + '|' + SPACE_KV + '|styrigx-space-gateway'));
  assert.equal(bindings(acct).D1_ACCOUNT, '03f60d23-9c2f-4f3d-a692-764ccaac6f5d');
  assert.equal(bindings(acct).KV_PROFILE, 'b20701f5f48e498e897bc6f0bd81643f');
  /* 同一个库里三套表不重名（网关原表名、share_*、status_*） */
  const names = (dir) => [...readFileSync(new URL('../../../' + dir, import.meta.url), 'utf8').matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX) IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  const share = names('workers/share/migrations/0001_baseline.sql');
  const status = names('workers/status/migrations/0001_baseline.sql');
  assert.ok(share.every((n) => n.startsWith('share_')), share.join(','));
  assert.ok(status.every((n) => n.startsWith('status_')), status.join(','));
});
