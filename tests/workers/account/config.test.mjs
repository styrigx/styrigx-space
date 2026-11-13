/**
 * 账号 Worker 的命名与配置（core/config.js、lib/db.js、secrets.js、wrangler.toml 的 Secrets Store / D1 绑定）：
 * - challenge 用途、Secrets 名钉死字面量（命名 v2；v6 P4 删三张票 / 两个纪元 / by）
 * - 账号 Worker 不自己建表（表只由 migrations 建）；0007 / 0008 只加列
 * - secrets：四个名字；wrangler.toml 正式段恰好这四个 Secrets Store 绑定（binding = secret_name，store 同网关），预览不绑
 * - resolveSecrets：绑定 → 字符串、60 秒缓存、取值失败留空且不缓存
 * - 退役名单（space/scripts/check/retired-names.json）里的旧名不出现在账号 Worker 源码里
 *
 * 运行：node --test tests/workers/account/config.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { makeAccountD1, ACCOUNT_TABLES, IDENTITY_TABLES } from './_d1.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const SRC = REPO + 'workers/account/src/';
const config = await import(SRC + 'core/config.js');
const db = await import(SRC + 'lib/db.js');
const { SECRET_NAMES, resolveSecrets, _resetSecretCache } = await import(SRC + 'secrets.js');

test('旧账号会话的时长与三张票 / 两个纪元 / 旧恢复密钥常量已删（v6 P4，定稿 v5.3 §十三；旧设备行保留期随 core/devices.js 删除，v6 清理 #11/#12）', () => {
  for (const gone of ['TICKET_MAX_AGE', 'LEGACY_SESSION_MAX_AGE', 'TICKET', 'EPOCH', 'BY_PASSWORD', 'BY_PASSKEY', 'BY_RECOVERY_KEY', 'RECOVERY_KEY_SECRET']) assert.equal(gone in config, false, gone);
});

test('challenge 有效期 / Secrets 名钉死', () => {
  assert.equal(config.CHALLENGE_TTL, 300);
  for (const gone of ['SIGNING_PRIVATE', 'SIGNING_PUBLIC']) assert.equal(gone in config, false, gone + '（签名钥匙对删除，定稿 v5.3 §十二）');
  assert.equal(config.PASSWORD_PEPPER_SECRET, 'SGX_ACCOUNT_PASSWORD_PEPPER');
  assert.equal(config.RESCUE_KEY_SECRET, 'SGX_ACCOUNT_RESCUE_KEY');
  for (const gone of ['CHALLENGE_PURPOSE', 'KEY_ACCOUNT_PASSKEY', 'PASSKEY_DISPLAY_NAME']) assert.equal(gone in config, false, gone + '（旧账号通行密钥入口删除）');
  assert.equal(db.DB_BINDING, 'D1_ACCOUNT');
});

test('rpConfig / rpConfigMissing：两个都在才给；缺 → 503 config', async () => {
  assert.deepEqual(config.rpConfig({ SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: 'https://styrigx.com' }), { rpId: 'styrigx.com', origin: 'https://styrigx.com' });
  assert.equal(config.rpConfig({ SGX_RP_ID: 'styrigx.com' }), null);
  const r = config.rpConfigMissing();
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'config');
});

test('账号 Worker 不自己建表（v6 P4 收尾：表只由 migrations/ 建，部署 job 先 d1 migrations apply 再部署）；0007 只给 account_device 加 uid、0008 只给 account_sessions 加 device', () => {
  for (const gone of ['ACCOUNT_SCHEMA', 'IDENTITY_SCHEMA', 'withSchema', 'readEpoch', 'bumpEpoch']) assert.equal(gone in db, false, gone + ' 删了');
  assert.doesNotMatch(readFileSync(SRC + 'lib/db.js', 'utf8'), /CREATE (TABLE|INDEX)|no such table|account_epoch WHERE/i);
  const b = makeAccountD1({ migrations: 'pre-uid' }).raw;
  const c = makeAccountD1().raw;
  const all = [...ACCOUNT_TABLES, ...IDENTITY_TABLES];
  const cols = (d, t) => d.prepare('PRAGMA table_info(' + t + ')').all().map((c) => [c.name, c.type, c.notnull, c.pk, c.dflt_value]);
  for (const t of all) assert.deepEqual(cols(c, t), t === 'account_device' ? cols(b, t).concat([['uid', 'INTEGER', 1, 0, '1000']]) : t === 'account_sessions' ? cols(b, t).concat([['device', 'TEXT', 0, 0, null]]) : cols(b, t), '0007 / 0008 后 ' + t);
  const names = (d) => d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'account_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(names(b), [...all].sort());
});

test('secrets：两个名字 = 账号密码 pepper + 救援钥匙（v6 P4 删旧恢复密钥与进站密码 pepper，应用授权删除时删签名钥匙对，定稿 v5.3 §九 / §十二 / §十三）', () => {
  assert.deepEqual([...SECRET_NAMES], ['SGX_ACCOUNT_PASSWORD_PEPPER', 'SGX_ACCOUNT_RESCUE_KEY']);
});

test('wrangler.toml：正式段恰好这两个 Secrets Store 绑定，binding = secret_name，store 同网关；预览不绑；不再绑 SGX_ACCOUNT_ROOT_KEY / SGX_ACCOUNT_RECOVERY_KEY / SGX_SPACE_PASSWORD_PEPPER', () => {
  const toml = readFileSync(REPO + 'workers/account/wrangler.toml', 'utf8');
  const code = toml.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
  const [prod, preview] = code.split(/^\[env\.preview\]$/m);
  const mine = [...prod.matchAll(/\[\[secrets_store_secrets\]\]\nbinding = "([A-Z_]+)"\nstore_id = "([0-9a-f]+)"\nsecret_name = "([A-Z_]+)"/g)].map((m) => ({ binding: m[1], store: m[2], name: m[3] }));
  assert.deepEqual(mine.map((b) => b.binding), [...SECRET_NAMES]);
  for (const b of mine) {
    assert.equal(b.binding, b.name);
    assert.equal(b.store, 'a5a984f365424401bad5ad6ddcd44479');
  }
  assert.doesNotMatch(code, /SGX_ACCOUNT_ROOT_KEY/);
  assert.doesNotMatch(code, /SGX_ACCOUNT_RECOVERY_KEY|SGX_SPACE_PASSWORD_PEPPER|SGX_SPACE_|SGX_ACCOUNT_PRIVATE|SGX_ACCOUNT_PUBLIC/);
  assert.doesNotMatch(preview, /secrets_store_secrets|SGX_ACCOUNT_/);
});

test('resolveSecrets：绑定 → 字符串；字符串原样；其他绑定不动；60 秒缓存（救援钥匙不缓存）；取值失败留空且不缓存', async () => {
  _resetSecretCache();
  const store = (v) => ({ get: async () => v });
  const d = makeAccountD1();
  const out = await resolveSecrets({ SGX_ACCOUNT_PASSWORD_PEPPER: store('A'), D1_ACCOUNT: d, SGX_SPACE_PRIVATE: store('L'), SGX_ACCOUNT_PRIVATE: store('K') }, 0);
  assert.equal(out.SGX_ACCOUNT_PASSWORD_PEPPER, 'A');
  assert.equal(typeof out.SGX_ACCOUNT_PRIVATE, 'object', '删掉的签名钥匙名不再换');
  assert.equal(out.D1_ACCOUNT, d);
  assert.equal(typeof out.SGX_SPACE_PRIVATE, 'object', '不是自己的名字不换');
  assert.equal('SGX_ACCOUNT_RESCUE_KEY' in out, false, '没绑的不出现');
  _resetSecretCache();
  let n = 0;
  const counting = { get: async () => 'v' + (++n) };
  assert.equal((await resolveSecrets({ SGX_ACCOUNT_PASSWORD_PEPPER: counting }, 0)).SGX_ACCOUNT_PASSWORD_PEPPER, 'v1');
  assert.equal((await resolveSecrets({ SGX_ACCOUNT_PASSWORD_PEPPER: counting }, 60_000)).SGX_ACCOUNT_PASSWORD_PEPPER, 'v1');
  assert.equal((await resolveSecrets({ SGX_ACCOUNT_PASSWORD_PEPPER: counting }, 60_001)).SGX_ACCOUNT_PASSWORD_PEPPER, 'v2');
  _resetSecretCache();
  /* 救援钥匙每个请求现取（定稿 §九「改完运行时即时生效」），缓存期内 pepper 照旧走缓存 */
  let r = 0;
  let p = 0;
  const rescue = { get: async () => 'r' + (++r) };
  const pepper = { get: async () => 'p' + (++p) };
  const e1 = await resolveSecrets({ SGX_ACCOUNT_PASSWORD_PEPPER: pepper, SGX_ACCOUNT_RESCUE_KEY: rescue }, 0);
  const e2 = await resolveSecrets({ SGX_ACCOUNT_PASSWORD_PEPPER: pepper, SGX_ACCOUNT_RESCUE_KEY: rescue }, 1);
  assert.deepEqual([e1.SGX_ACCOUNT_RESCUE_KEY, e2.SGX_ACCOUNT_RESCUE_KEY], ['r1', 'r2'], '救援钥匙不缓存');
  assert.deepEqual([e1.SGX_ACCOUNT_PASSWORD_PEPPER, e2.SGX_ACCOUNT_PASSWORD_PEPPER], ['p1', 'p1'], 'pepper 60 秒缓存');
  _resetSecretCache();
  const failing = { get: async () => { throw new Error('x'); } };
  assert.equal((await resolveSecrets({ SGX_ACCOUNT_PASSWORD_PEPPER: failing }, 0)).SGX_ACCOUNT_PASSWORD_PEPPER, '');
  assert.equal((await resolveSecrets({ SGX_ACCOUNT_PASSWORD_PEPPER: store('ok') }, 1)).SGX_ACCOUNT_PASSWORD_PEPPER, 'ok', '失败那轮没缓存');
  assert.equal((await resolveSecrets({ SGX_ACCOUNT_RESCUE_KEY: failing }, 2)).SGX_ACCOUNT_RESCUE_KEY, '');
  assert.equal((await resolveSecrets({ SGX_ACCOUNT_RESCUE_KEY: store('ok') }, 3)).SGX_ACCOUNT_RESCUE_KEY, 'ok');
  _resetSecretCache();
});

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = dir + '/' + f;
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

test('退役名单：space/scripts/check/retired-names.json 里的旧名不出现在账号 Worker 源码（含注释）和 wrangler.toml 的配置里', () => {
  const retired = JSON.parse(readFileSync(REPO + 'space/scripts/check/retired-names.json', 'utf8'));
  assert.ok(Array.isArray(retired.account) && retired.account.length > 10);
  const files = walk(SRC).concat([REPO + 'workers/account/wrangler.toml']);
  const hits = [];
  for (const f of files) {
    let text = readFileSync(f, 'utf8');
    // wrangler.toml 只查配置不查注释：SGX_RP_ID / SGX_ORIGIN 下面紧挨着的几行注释故意不动——
    // WebAuthn 红线检查（对 main 的 wrangler.toml diff 里 grep SGX_RP_ID|SGX_ORIGIN）连 hunk 头都要是空的
    if (f.endsWith('.toml')) text = text.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
    for (const name of retired.account) {
      if (new RegExp('(?<![\\w-])' + name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&') + '(?![\\w-])').test(text)) hits.push(f.replace(SRC, 'src/').replace(REPO, '') + ': ' + name);
    }
  }
  assert.deepEqual(hits, []);
});
