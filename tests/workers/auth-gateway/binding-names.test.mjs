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

/* 2026-10-27 起网关认证状态全部在 D1 styrigx-auth-gateway：三个按凭证域命名的绑定（D1_<域>_AUTH），同一个库，不再绑任何 KV */
const AUTH = ['D1_LOCK_AUTH', 'D1_ACCOUNT_AUTH', 'D1_ROOT_AUTH'];
/* 以前的认证 KV / 重置开关 D1 绑定名：网关和 Pages 预览都不能再出现 */
const AUTH_GONE = ['KV_LOCK_DOOR', 'KV_ACCOUNT_LOGIN', 'D1_LOCK_RESET', 'D1_LOCK_DOOR', 'D1_ACCOUNT_LOGIN'];
/* 2026-10-24 起在账号 Worker styrigx-account（workers/account），网关和 Pages 预览都不再绑定 */
const ACCOUNT = ['KV_PROFILE', 'KV_SETTINGS_SYNC', 'D1_WELLBEING'];
const OLD = /\b(OWNER_KV|ACCOUNT_KV|SGX_D1|SEARCH_KV|STATUS_DB)\b|"CF_USAGE_TOKEN"/;
/** 去掉 # 注释（注释里可以提旧名字，绑定里不行） */
const code = (toml) => toml.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');

test('鉴权网关正式 / 预览：恰好三个 D1 认证绑定（同一个库），没有任何 KV；不再绑账号库', () => {
  for (const p of ['workers/auth-gateway/wrangler.toml', 'web/wrangler.toml']) {
    const toml = read(p);
    const src = code(toml);
    assert.doesNotMatch(toml, OLD, p);
    const m = bindings(toml);
    const d1 = [...src.matchAll(/^\[\[(?:env\.preview\.)?d1_databases\]\]\s*\nbinding = "([A-Z0-9_]+)"/gm)].map((x) => x[1]);
    assert.deepEqual(d1.slice().sort(), AUTH.slice().sort(), p + '：D1 绑定恰好是这三个');
    for (const n of AUTH) assert.ok(m[n], p + ' 缺 ' + n);
    assert.equal(m.D1_ACCOUNT_AUTH, m.D1_LOCK_AUTH, p + '：三个名字是同一个库');
    assert.equal(m.D1_ROOT_AUTH, m.D1_LOCK_AUTH, p + '：三个名字是同一个库');
    assert.match(src, /^database_name = "styrigx-auth-gateway(-preview)?"$/m, p);
    for (const db of src.match(/^database_name = ".*"$/gm) || []) assert.match(db, /"styrigx-auth-gateway(-preview)?"/, p + ' ' + db);
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

test('账号 Worker 正式 / 预览：KV_PROFILE = KV_SETTINGS_SYNC（同一个库），不碰认证库', () => {
  const toml = read('workers/account/wrangler.toml');
  assert.doesNotMatch(toml, OLD);
  const [prod, preview] = toml.split(/^\[env\.preview\]$/m);
  const m = bindings(prod);
  for (const n of ACCOUNT) assert.ok(m[n], '缺 ' + n);
  assert.equal(m.KV_PROFILE, m.KV_SETTINGS_SYNC);
  assert.equal(m.KV_PROFILE, 'b20701f5f48e498e897bc6f0bd81643f');
  assert.equal(m.D1_WELLBEING, '03f60d23-9c2f-4f3d-a692-764ccaac6f5d');
  for (const n of AUTH.concat(AUTH_GONE)) assert.equal(m[n], undefined, '账号 Worker 不该绑 ' + n);
  const pm = bindings(preview);
  assert.equal(pm.KV_PROFILE, 'a5ee2a75f00d4308959b2bea55247ff6');
  assert.equal(pm.KV_PROFILE, pm.KV_SETTINGS_SYNC);
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
