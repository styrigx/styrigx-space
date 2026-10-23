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

const AUTH = ['KV_LOCK_DOOR', 'KV_ACCOUNT_LOGIN', 'D1_LOCK_RESET'];
/* 2026-10-24 起在账号 Worker styrigx-account（workers/account），网关和 Pages 预览都不再绑定 */
const ACCOUNT = ['KV_PROFILE', 'KV_SETTINGS_SYNC', 'D1_WELLBEING'];
const OLD = /\b(OWNER_KV|ACCOUNT_KV|SGX_D1|SEARCH_KV|STATUS_DB)\b|"CF_USAGE_TOKEN"/;

test('鉴权网关正式 / 预览：三个绑定名齐全、同一资源的两个名字 id 相同；不再绑账号库', () => {
  for (const p of ['workers/auth-gateway/wrangler.toml', 'web/wrangler.toml']) {
    const toml = read(p);
    assert.doesNotMatch(toml, OLD, p);
    const m = bindings(toml);
    for (const n of AUTH) assert.ok(m[n], p + ' 缺 ' + n);
    for (const n of ACCOUNT) assert.equal(m[n], undefined, p + ' 不该再绑 ' + n);
    assert.equal(m.KV_LOCK_DOOR, m.KV_ACCOUNT_LOGIN, p);
    assert.equal((toml.match(/^migrations_dir = /gm) || []).length, 1, p + '：migrations_dir 只配一次');
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
  for (const n of AUTH) assert.equal(m[n], undefined, '账号 Worker 不该绑 ' + n);
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
