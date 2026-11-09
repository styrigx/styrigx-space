/**
 * 账号 Worker 的命名与配置（core/config.js、lib/db.js ACCOUNT_SCHEMA、secrets.js、wrangler.toml 的 Secrets Store / D1 绑定）：
 * - 三张票、两个纪元、by、challenge 用途、Secrets 名钉死字面量（命名 v2）
 * - ACCOUNT_SCHEMA 与 migrations/0005_account_tables.sql 建出的表逐列一致
 * - secrets：四个名字；wrangler.toml 正式段恰好这四个 Secrets Store 绑定（binding = secret_name，store 同网关），预览不绑
 * - resolveSecrets：绑定 → 字符串、60 秒缓存、取值失败留空且不缓存
 * - 退役名单（space/scripts/retired-names.json）里的旧名不出现在账号 Worker 源码里
 *
 * 运行：node --test tests/workers/account/config.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { makeAccountD1, ACCOUNT_TABLES } from './_d1.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const SRC = REPO + 'workers/account/src/';
const config = await import(SRC + 'core/config.js');
const db = await import(SRC + 'lib/db.js');
const { SECRET_NAMES, resolveSecrets, _resetSecretCache } = await import(SRC + 'secrets.js');

test('三张票：cookie 名 / 时长 / by / 带不带 deviceId / 归哪个纪元钉死', () => {
  assert.deepEqual(Object.keys(config.TICKET), ['session', 'reauth', 'reset']);
  const pick = (t) => ({ name: t.name, cookie: t.cookie, maxAge: t.maxAge, bys: [...t.bys], device: t.device, span: t.span, epoch: t.epoch });
  assert.deepEqual(pick(config.TICKET.session), { name: 'session', cookie: 'sgx-account-session', maxAge: 2592000, bys: ['password', 'passkey'], device: true, span: false, epoch: 'session' });
  assert.deepEqual(pick(config.TICKET.reauth), { name: 'reauth', cookie: 'sgx-account-reauth', maxAge: 180, bys: ['password', 'passkey'], device: true, span: true, epoch: 'session' });
  assert.deepEqual(pick(config.TICKET.reset), { name: 'reset', cookie: 'sgx-account-reset', maxAge: 180, bys: ['recovery-key'], device: false, span: true, epoch: 'reset' });
  assert.ok(Object.isFrozen(config.TICKET) && Object.isFrozen(config.TICKET.session.bys));
});

test('纪元 / by / challenge 用途 / Secrets 名 / 显示名钉死（API 值一律小写连字符）', () => {
  assert.deepEqual({ ...config.EPOCH }, { session: 'session', reset: 'reset' });
  assert.deepEqual([config.BY_PASSWORD, config.BY_PASSKEY, config.BY_RECOVERY_KEY], ['password', 'passkey', 'recovery-key']);
  assert.deepEqual({ ...config.CHALLENGE_PURPOSE }, { session: 'session', reauth: 'reauth', keysAdd: 'keys-add', resetAdd: 'reset-add' });
  for (const v of Object.values(config.CHALLENGE_PURPOSE)) assert.match(v, /^[a-z]+(-[a-z]+)*$/);
  assert.equal(config.CHALLENGE_TTL, 300);
  assert.equal(config.SIGNING_PRIVATE, 'SGX_ACCOUNT_PRIVATE');
  assert.equal(config.SIGNING_PUBLIC, 'SGX_ACCOUNT_PUBLIC');
  assert.equal(config.RECOVERY_KEY_SECRET, 'SGX_ACCOUNT_RECOVERY_KEY');
  assert.equal(config.PASSWORD_PEPPER_SECRET, 'SGX_ACCOUNT_PASSWORD_PEPPER');
  assert.equal(config.KEY_ACCOUNT_PASSKEY, 'AccountPasskey');
  assert.equal(config.PASSKEY_DISPLAY_NAME, 'Sloan Gray');
  assert.equal(db.DB_BINDING, 'D1_ACCOUNT');
});

test('rpConfig / rpConfigMissing：两个都在才给；缺 → 503 config', async () => {
  assert.deepEqual(config.rpConfig({ SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: 'https://styrigx.com' }), { rpId: 'styrigx.com', origin: 'https://styrigx.com' });
  assert.equal(config.rpConfig({ SGX_RP_ID: 'styrigx.com' }), null);
  const r = config.rpConfigMissing();
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'config');
});

test('ACCOUNT_SCHEMA（兜底建表）与 0005 建出的 account_* 表逐列一致；每条都 IF NOT EXISTS', () => {
  const a = new DatabaseSync(':memory:');
  for (const s of db.ACCOUNT_SCHEMA) { assert.match(s, /IF NOT EXISTS/); a.exec(s); }
  const b = makeAccountD1().raw;
  const cols = (d, t) => d.prepare('PRAGMA table_info(' + t + ')').all().map((c) => [c.name, c.type, c.notnull, c.pk, c.dflt_value]);
  for (const t of ACCOUNT_TABLES) assert.deepEqual(cols(a, t), cols(b, t), t);
  const names = (d) => d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'account_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(names(a), [...ACCOUNT_TABLES].sort());
  assert.deepEqual(names(b), [...ACCOUNT_TABLES].sort());
});

test('secrets：四个名字 = 签名钥匙一对 + 恢复密钥 + 账号密码 pepper', () => {
  assert.deepEqual([...SECRET_NAMES], ['SGX_ACCOUNT_PRIVATE', 'SGX_ACCOUNT_PUBLIC', 'SGX_ACCOUNT_RECOVERY_KEY', 'SGX_ACCOUNT_PASSWORD_PEPPER']);
});

test('wrangler.toml：正式段恰好这四个 Secrets Store 绑定，binding = secret_name，store 同网关；预览不绑；不再绑 SGX_SPACE_PASSWORD_PEPPER / SGX_ACCOUNT_ROOT_KEY', () => {
  const toml = readFileSync(REPO + 'workers/account/wrangler.toml', 'utf8');
  const code = toml.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
  const [prod, preview] = code.split(/^\[env\.preview\]$/m);
  const mine = [...prod.matchAll(/\[\[secrets_store_secrets\]\]\nbinding = "([A-Z_]+)"\nstore_id = "([0-9a-f]+)"\nsecret_name = "([A-Z_]+)"/g)].map((m) => ({ binding: m[1], store: m[2], name: m[3] }));
  assert.deepEqual(mine.map((b) => b.binding), [...SECRET_NAMES]);
  for (const b of mine) {
    assert.equal(b.binding, b.name);
    assert.equal(b.store, 'a5a984f365424401bad5ad6ddcd44479');
  }
  assert.doesNotMatch(code, /SGX_SPACE_PASSWORD_PEPPER|SGX_ACCOUNT_ROOT_KEY/);
  assert.doesNotMatch(preview, /secrets_store_secrets|SGX_ACCOUNT_/);
});

test('resolveSecrets：绑定 → 字符串；字符串原样；其他绑定不动；60 秒缓存；取值失败留空且不缓存', async () => {
  _resetSecretCache();
  const store = (v) => ({ get: async () => v });
  const d = makeAccountD1();
  const out = await resolveSecrets({ SGX_ACCOUNT_PRIVATE: store('A'), SGX_ACCOUNT_PASSWORD_PEPPER: 'P', D1_ACCOUNT: d, SGX_SPACE_PRIVATE: store('L') }, 0);
  assert.equal(out.SGX_ACCOUNT_PRIVATE, 'A');
  assert.equal(out.SGX_ACCOUNT_PASSWORD_PEPPER, 'P');
  assert.equal(out.D1_ACCOUNT, d);
  assert.equal(typeof out.SGX_SPACE_PRIVATE, 'object', '不是自己的名字不换');
  assert.equal('SGX_ACCOUNT_RECOVERY_KEY' in out, false, '没绑的不出现');
  _resetSecretCache();
  let n = 0;
  const counting = { get: async () => 'v' + (++n) };
  assert.equal((await resolveSecrets({ SGX_ACCOUNT_RECOVERY_KEY: counting }, 0)).SGX_ACCOUNT_RECOVERY_KEY, 'v1');
  assert.equal((await resolveSecrets({ SGX_ACCOUNT_RECOVERY_KEY: counting }, 60_000)).SGX_ACCOUNT_RECOVERY_KEY, 'v1');
  assert.equal((await resolveSecrets({ SGX_ACCOUNT_RECOVERY_KEY: counting }, 60_001)).SGX_ACCOUNT_RECOVERY_KEY, 'v2');
  _resetSecretCache();
  const failing = { get: async () => { throw new Error('x'); } };
  assert.equal((await resolveSecrets({ SGX_ACCOUNT_RECOVERY_KEY: failing }, 0)).SGX_ACCOUNT_RECOVERY_KEY, '');
  assert.equal((await resolveSecrets({ SGX_ACCOUNT_RECOVERY_KEY: store('ok') }, 1)).SGX_ACCOUNT_RECOVERY_KEY, 'ok', '失败那轮没缓存');
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

test('退役名单：space/scripts/retired-names.json 里的旧名不出现在账号 Worker 源码（含注释）和 wrangler.toml 的配置里', () => {
  const retired = JSON.parse(readFileSync(REPO + 'space/scripts/retired-names.json', 'utf8'));
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
