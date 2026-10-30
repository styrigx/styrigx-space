/**
 * 账号拆分 PR2a：账号 Worker 的鉴权脚手架（还没有入口读写，只核对结构）。
 * - migrations/0003_account_auth.sql：九张表 + audit_ts 索引，全部 IF NOT EXISTS、重复跑不出错、与 wb_daily / settings_sync 不重名；
 *   逐列照搬网关 0005 / 0006（user_handle 多 legacy_handle，data_migration 同 kv_migration 结构）；共享 d1-state 直接可用
 * - src/identity/realm.js：REALM_ACCOUNT、三张账号票与网关 _kernel/realms.js 逐字段一致（只多 rootKey / rootIssues）；只依赖 workers/account/src/lib/
 * - src/secrets.js：Secrets Store → 字符串、60 秒缓存、失败不缓存；四个名字都在 wrangler.toml（同网关 store、secret_name 同网关）
 *
 * 运行：node --test tests/workers/account/account-auth-scaffold.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { makeAccountD1, withAccountAuthD1, ACCOUNT_AUTH_SQL, AUTH_TABLES } from './_d1.mjs';
import { genKeyPair } from '../_harness.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const read = (p) => readFileSync(REPO + p, 'utf8');
const acct = await import(REPO + 'workers/account/src/identity/realm.js');
const gw = await import(REPO + 'workers/auth-gateway/functions/_kernel/realms.js');
const { resolveSecrets, SECRET_NAMES, _resetSecretCache } = await import(REPO + 'workers/account/src/secrets.js');
const sharedD1 = await import(REPO + 'workers/account/src/lib/d1-state.js');
const sharedTickets = await import(REPO + 'workers/account/src/lib/tickets.js');

/* ---------------- 0003 建表 ---------------- */

const tablesOf = (raw) => raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const indexesOf = (raw) => raw.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name + '@' + r.tbl_name);
const plain = (rows) => rows.map((r) => ({ ...r }));
const colsOf = (raw, t) => raw.prepare('PRAGMA table_info(' + t + ')').all().map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value, pk: c.pk }));

test('0003：空库建出九张表 + audit_ts 索引，每条 CREATE 都带 IF NOT EXISTS', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec(ACCOUNT_AUTH_SQL);
  assert.deepEqual(tablesOf(raw), AUTH_TABLES.slice().sort());
  assert.deepEqual(indexesOf(raw), ['audit_ts@audit']);
  const creates = ACCOUNT_AUTH_SQL.split('\n').filter((l) => /^\s*CREATE\b/i.test(l));
  assert.equal(creates.length, 10);
  for (const l of creates) assert.match(l, /^CREATE (TABLE|INDEX) IF NOT EXISTS /, l);
  const sqlOnly = ACCOUNT_AUTH_SQL.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  assert.doesNotMatch(sqlOnly, /\b(DROP|ALTER|DELETE|UPDATE|INSERT)\b/i, '迁移只建表');
});

test('0003：幂等——同一份 SQL 跑两次、整套迁移再跑一遍都不出错，已有数据不动', () => {
  const db = makeAccountD1();
  db.raw.exec("INSERT INTO epoch (realm, value) VALUES ('account', 7)");
  db.raw.exec("INSERT INTO settings_sync (k, v, t, updated_at) VALUES ('sgx-x', '1', 1, 1)");
  db.raw.exec(ACCOUNT_AUTH_SQL);
  for (const f of readdirSync(REPO + 'workers/account/migrations').filter((n) => n.endsWith('.sql')).sort()) {
    db.raw.exec(read('workers/account/migrations/' + f));
  }
  assert.deepEqual(plain(db.rows('epoch')), [{ realm: 'account', value: 7 }]);
  assert.equal(db.rows('settings_sync').length, 1);
});

test('0003：与本库已有的 wb_daily（0001）、settings_sync（0002）不重名；整库表名唯一', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec(read('workers/account/migrations/0001_wellbeing.sql'));
  raw.exec(read('workers/account/migrations/0002_settings_sync.sql'));
  const data = tablesOf(raw);
  assert.deepEqual(data, ['settings_sync', 'wb_daily']);
  for (const t of AUTH_TABLES) assert.ok(!data.includes(t), t);
  const all = makeAccountD1();
  assert.deepEqual(tablesOf(all.raw), data.concat(AUTH_TABLES).sort());
  /* 迁移文件名编号不重 */
  const nums = readdirSync(REPO + 'workers/account/migrations').map((f) => f.slice(0, 4));
  assert.equal(new Set(nums).size, nums.length);
});

test('0003：逐列照搬网关 0005 / 0006（保留 realm 列）；user_handle 只多 legacy_handle，data_migration 同 kv_migration', () => {
  const g = new DatabaseSync(':memory:');
  g.exec(read('workers/auth-gateway/migrations/0005_lock_account_state.sql'));
  g.exec(read('workers/auth-gateway/migrations/0006_auth_state.sql'));
  const a = new DatabaseSync(':memory:');
  a.exec(ACCOUNT_AUTH_SQL);
  for (const t of ['epoch', 'password', 'passkey', 'challenge', 'attempt_limit', 'device', 'audit']) {
    assert.deepEqual(colsOf(a, t), colsOf(g, t), t);
    assert.equal(colsOf(a, t)[0].name, 'realm', t + '：第一列 realm');
  }
  assert.deepEqual(colsOf(a, 'user_handle'), colsOf(g, 'user_handle').concat([{ name: 'legacy_handle', type: 'TEXT', notnull: 1, dflt: "''", pk: 0 }]));
  assert.deepEqual(colsOf(a, 'data_migration'), colsOf(g, 'kv_migration'));
  const idx = (db) => db.prepare('PRAGMA index_info(audit_ts)').all().map((c) => c.name);
  assert.deepEqual(idx(a), idx(g));
  /* 临时钥匙留在网关 */
  assert.ok(!tablesOf(a).includes('tempkey'));
  assert.ok(!tablesOf(a).includes('kv_migration'));
});

test('0003 + 共享 d1-state：REALM_ACCOUNT 经 D1_ACCOUNT_AUTH 读写 epoch，行的 realm = account；legacy_handle 默认空串', async () => {
  const env = withAccountAuthD1({ D1_SETTINGS_SYNC: makeAccountD1() });
  assert.equal(env.D1_ACCOUNT_AUTH, env.D1_SETTINGS_SYNC, '同一个库');
  assert.equal(await sharedD1.readEpoch(env, acct.REALM_ACCOUNT), 0);
  assert.equal(await sharedD1.bumpEpoch(env, acct.REALM_ACCOUNT), 1);
  assert.equal(await sharedD1.bumpEpoch(env, acct.REALM_ACCOUNT), 2);
  assert.deepEqual(plain(env.D1_ACCOUNT_AUTH.rows('epoch')), [{ realm: 'account', value: 2 }]);
  env.D1_ACCOUNT_AUTH.raw.exec("INSERT INTO user_handle (realm, handle) VALUES ('account', 'h1')");
  assert.deepEqual(plain(env.D1_ACCOUNT_AUTH.rows('user_handle')), [{ realm: 'account', handle: 'h1', legacy_handle: '' }]);
  /* 没绑 D1_ACCOUNT_AUTH → 抛（调用方 fail closed） */
  await assert.rejects(() => sharedD1.readEpoch({}, acct.REALM_ACCOUNT), /d1-missing D1_ACCOUNT_AUTH/);
});

test('_d1.mjs：migrations: "data" 只建数据表（测 auth 表缺失时用）', () => {
  assert.deepEqual(tablesOf(makeAccountD1({ migrations: 'data' }).raw), ['settings_sync', 'wb_daily']);
  assert.deepEqual(tablesOf(makeAccountD1({ migrations: false }).raw), []);
});

/* ---------------- realm.js ---------------- */

test('realm：REALM_ACCOUNT 钉死字面量（拆分前网关 REALM_ACCOUNT 的值，PR3 起只在账号 Worker），另有 rootKey = SGX_ACCOUNT_ROOT_KEY、rootIssues = 两张账号短票', () => {
  const a = acct.REALM_ACCOUNT;
  assert.deepEqual(Object.keys(a).sort(), ['bys', 'challenge', 'cookie', 'cookieAttrs', 'd1Binding', 'epoch', 'id', 'keyName', 'maxAge', 'pepper', 'privateKey', 'publicKey', 'rootIssues', 'rootKey']);
  assert.equal(a.id, 'account');
  assert.equal(a.keyName, 'AccountKey');
  assert.equal(a.privateKey, 'SGX_ACCOUNT_PRIVATE');
  assert.equal(a.publicKey, 'SGX_ACCOUNT_PUBLIC');
  assert.equal(a.cookie, 'sgx-account-session');
  assert.equal(a.cookieAttrs, 'Path=/; HttpOnly; Secure; SameSite=Strict');
  assert.equal(a.maxAge, 34560000);
  assert.equal(a.pepper, 'SGX_PW_PEPPER', 'pepper 与网关共用同一个密值（方案 6.2）');
  assert.deepEqual(a.bys, ['password', 'passkey']);
  assert.equal(a.epoch, 'account-epoch');
  assert.deepEqual(a.challenge, { login: 'login', register: 'register', ttl: 300 });
  assert.equal(a.rootKey, 'SGX_ACCOUNT_ROOT_KEY');
  assert.deepEqual(a.rootIssues, ['AccountReauthTicket', 'AccountResetTicket']);
  assert.equal(a.d1Binding, 'D1_ACCOUNT_AUTH');
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.challenge) && Object.isFrozen(a.rootIssues) && Object.isFrozen(a.bys));
  /* 根密钥名不是网关的锁屏根密钥 */
  assert.notEqual(a.rootKey, gw.REALM_LOCK.rootKey);
  assert.equal(gw.REALM_LOCK.rootKey, 'SGX_ADMIN_KEY');
});

test('realm：三张账号票钉死字面量（方案第 8 节：cookie 名 / TTL / 属性 / by / 钥匙不变，切换时现有票继续有效）；网关不再有这三张票', () => {
  const names = ['AccountSessionTicket', 'AccountReauthTicket', 'AccountResetTicket'];
  assert.deepEqual(Object.keys(acct.TICKETS).sort(), names.slice().sort());
  const want = {
    AccountSessionTicket: { cookie: 'sgx-account-session', maxAge: 34560000, bys: ['password', 'passkey'] },
    AccountReauthTicket: { cookie: 'sgx-account-reauth', maxAge: 180, bys: ['password', 'passkey', 'root'] },
    AccountResetTicket: { cookie: 'sgx-account-reset', maxAge: 180, bys: ['root'] },
  };
  for (const n of names) {
    const t = acct.TICKETS[n];
    assert.deepEqual(Object.keys(t).sort(), ['bys', 'cookie', 'cookieAttrs', 'maxAge', 'privateKey', 'publicKey', 'realm'], n);
    assert.equal(t.cookie, want[n].cookie, n);
    assert.equal(t.maxAge, want[n].maxAge, n);
    assert.deepEqual(t.bys, want[n].bys, n);
    assert.equal(t.privateKey, 'SGX_ACCOUNT_PRIVATE', n);
    assert.equal(t.publicKey, 'SGX_ACCOUNT_PUBLIC', n);
    assert.equal(t.realm, 'account', n);
    assert.equal(t.cookieAttrs, 'Path=/; HttpOnly; Secure; SameSite=Strict', n);
    assert.ok(Object.isFrozen(t) && Object.isFrozen(t.bys), n);
    assert.equal(n in gw.TICKETS, false, '网关不再有 ' + n);
  }
});

test('realm：导出的常量钉死字面量；锁屏 / 根的东西不在这里', () => {
  const want = {
    KEY_ACCOUNT: 'AccountKey', ACCOUNT_EPOCH: 'account-epoch', ACCOUNT_SESSION_COOKIE: 'sgx-account-session',
    ACCOUNT_RESET_COOKIE: 'sgx-account-reset', ACCOUNT_REAUTH_COOKIE: 'sgx-account-reauth', BY_PASSWORD: 'password', BY_PASSKEY: 'passkey',
    BY_ROOT: 'root', ACCOUNT_SESSION_TICKET: 'AccountSessionTicket', ACCOUNT_RESET_TICKET: 'AccountResetTicket',
    ACCOUNT_REAUTH_TICKET: 'AccountReauthTicket', SHORT_TICKET_MAX_AGE: 180,
  };
  for (const [k, v] of Object.entries(want)) assert.equal(acct[k], v, k);
  assert.equal(acct.COOKIE_EXPIRED, gw.COOKIE_EXPIRED, '清 cookie 的过期串两边同值（各自一份 lib/cookies.js）');
  for (const k of ['REALM_LOCK', 'REALM_ROOT', 'LOCK_SESSION_COOKIE', 'LOCK_EPOCH', 'BY_TEMPKEY', 'BY_ACCOUNT', 'REALMS']) assert.ok(!(k in acct), k);
  /* 网关这边没有账号的名字 */
  for (const k of ['REALM_ACCOUNT', 'REALM_ROOT', 'KEY_ACCOUNT', 'ACCOUNT_EPOCH', 'ACCOUNT_SESSION_COOKIE', 'BY_ACCOUNT', 'ACCOUNT_SESSION_TICKET']) assert.ok(!(k in gw), 'gateway ' + k);
});

test('realm：realmCookie / realmClearCookie / realmPrivateKey / realmPublicKey / rpConfig / rpConfigMissing 输出钉死', async () => {
  const R = acct.REALM_ACCOUNT;
  assert.equal(acct.realmCookie(R, 'v'), 'sgx-account-session=v; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=34560000');
  assert.equal(acct.realmCookie(R, 'v', 60), 'sgx-account-session=v; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=60');
  assert.equal(acct.realmClearCookie(R), 'sgx-account-session=; Path=/; HttpOnly; Secure; SameSite=Strict; ' + acct.COOKIE_EXPIRED);
  assert.equal(acct.realmCookie(acct.TICKETS.AccountReauthTicket, 'x'), 'sgx-account-reauth=x; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=180');
  const env = { SGX_ACCOUNT_PRIVATE: 'P', SGX_ACCOUNT_PUBLIC: 'Q' };
  assert.equal(acct.realmPrivateKey(env, R), 'P');
  assert.equal(acct.realmPublicKey(env, R), 'Q');
  assert.equal(acct.realmPrivateKey({}, R), '');
  assert.equal(acct.realmPublicKey(null, R), '');
  assert.deepEqual(acct.rpConfig({ SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: 'https://styrigx.com' }), { rpId: 'styrigx.com', origin: 'https://styrigx.com' });
  assert.equal(acct.rpConfig({ SGX_RP_ID: 'styrigx.com' }), null);
  const x = acct.rpConfigMissing();
  assert.equal(x.status, 503);
  assert.equal((await x.json()).error, 'config');
});

test('realm：账号短票格式（"<cookie 名>|by.epoch.iat.exp" Ed25519）不变：按拆分前的格式手工签的票，账号 Worker 验得过', async () => {
  const { priv, pub } = await genKeyPair();
  const { ed25519Sign } = await import(REPO + 'workers/account/src/lib/crypto.js');
  for (const n of ['AccountReauthTicket', 'AccountResetTicket']) {
    const c = acct.TICKETS[n];
    const now = Date.now();
    const payload = 'root.3.' + now + '.' + (now + 180000);
    const val = payload + '.' + (await ed25519Sign(priv, c.cookie + '|' + payload));
    assert.equal(await sharedTickets.signShortTicket(priv, c, 'root', 3, now), val, n + '：账号 Worker 签出来逐字节相同');
    const req = new Request('https://styrigx.com/', { headers: { Cookie: c.cookie + '=' + val } });
    const r = await sharedTickets.verifyShortTicket(req, { SGX_ACCOUNT_PUBLIC: pub }, c, async () => 3);
    assert.equal(r.ok, true, n + ' ' + r.reason);
  }
});

test('realm.js 只依赖本 Worker 的 src/lib/（叶子模块）', () => {
  const src = read('workers/account/src/identity/realm.js');
  const specs = [...src.matchAll(/^\s*(?:import|export)\s[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(specs.length > 0);
  for (const s of specs) assert.match(s, /^\.\.\/lib\/[a-z0-9-]+\.js$/, s);
  assert.doesNotMatch(src, /\bimport\s*\(/);
});

/* ---------------- secrets.js ---------------- */

const store = (v) => ({ get: async () => v });
const blocks = (toml) => [...toml.matchAll(/^\[\[secrets_store_secrets\]\]\nbinding = "([A-Z0-9_]+)"\nstore_id = "([0-9a-f]+)"\nsecret_name = "([A-Z0-9_]+)"$/gm)]
  .map((m) => ({ binding: m[1], store: m[2], name: m[3] }));

test('secrets：四个名字 = REALM_ACCOUNT 用到的私钥 / 公钥 / pepper / 根密钥', () => {
  const R = acct.REALM_ACCOUNT;
  assert.deepEqual(SECRET_NAMES.slice().sort(), [R.privateKey, R.publicKey, R.rootKey, R.pepper].sort());
  assert.ok(Object.isFrozen(SECRET_NAMES));
});

test('secrets：wrangler.toml 正式段恰好这四个 Secrets Store 绑定，store 同网关，binding = secret_name；网关只共用 SGX_PW_PEPPER；预览不绑', () => {
  const toml = read('workers/account/wrangler.toml');
  const [prod, preview] = toml.split(/^\[env\.preview\]$/m);
  const mine = blocks(prod);
  const theirs = blocks(read('workers/auth-gateway/wrangler.toml'));
  assert.deepEqual(mine.map((b) => b.binding).sort(), SECRET_NAMES.slice().sort());
  const gwStore = new Set(theirs.map((b) => b.store));
  assert.equal(gwStore.size, 1);
  for (const b of mine) {
    assert.equal(b.name, b.binding, b.binding);
    assert.ok(gwStore.has(b.store), b.binding + '：store 同网关');
    const g = theirs.find((x) => x.binding === b.binding);
    if (b.binding === 'SGX_PW_PEPPER') assert.equal(g && g.name, 'SGX_PW_PEPPER', 'pepper 两边绑同一个密值（方案 6.2）');
    else assert.equal(g, undefined, b.binding + '：账号钥匙只绑在账号 Worker，网关不绑');
  }
  assert.deepEqual(theirs.map((b) => b.binding).sort(), ['SGX_ADMIN_KEY', 'SGX_LOCK_PRIVATE', 'SGX_LOCK_PUBLIC', 'SGX_PW_PEPPER'], '网关只剩 4 个（方案 10.1）');
  assert.equal(mine.find((b) => b.binding === 'SGX_ACCOUNT_ROOT_KEY').store, 'a5a984f365424401bad5ad6ddcd44479');
  const code = preview.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
  assert.doesNotMatch(code, /secrets_store_secrets|SGX_ACCOUNT_PRIVATE|SGX_ACCOUNT_ROOT_KEY|SGX_PW_PEPPER/, '预览照网关预览：不绑 Secrets Store，测试密钥由 CI 现生成');
});

test('resolveSecrets：绑定 → 字符串；字符串原样；其他绑定和变量不动；不改原 env', async () => {
  _resetSecretCache();
  const db = makeAccountD1();
  const env = { SGX_ACCOUNT_PRIVATE: store('A'), SGX_PW_PEPPER: 'P', D1_ACCOUNT_AUTH: db, SGX_ENV: 'production', SGX_LOCK_PRIVATE: store('L') };
  const out = await resolveSecrets(env, 1000);
  assert.equal(out.SGX_ACCOUNT_PRIVATE, 'A');
  assert.equal(out.SGX_PW_PEPPER, 'P');
  assert.equal(out.D1_ACCOUNT_AUTH, db);
  assert.equal(out.SGX_ENV, 'production');
  assert.equal('SGX_ACCOUNT_ROOT_KEY' in out, false, '没绑的不出现');
  assert.equal(typeof out.SGX_LOCK_PRIVATE, 'object', '不在名单里的不碰（账号 Worker 不管锁屏钥匙）');
  assert.equal(typeof env.SGX_ACCOUNT_PRIVATE, 'object');
});

test('resolveSecrets：60 秒缓存（轮换最多 60 秒生效）；取值失败留空且不缓存；不打印密值', async () => {
  _resetSecretCache();
  let n = 0;
  const counting = { get: async () => { n++; return 'v' + n; } };
  assert.equal((await resolveSecrets({ SGX_ACCOUNT_ROOT_KEY: counting }, 0)).SGX_ACCOUNT_ROOT_KEY, 'v1');
  assert.equal((await resolveSecrets({ SGX_ACCOUNT_ROOT_KEY: counting }, 30_000)).SGX_ACCOUNT_ROOT_KEY, 'v1');
  assert.equal((await resolveSecrets({ SGX_ACCOUNT_ROOT_KEY: counting }, 60_000)).SGX_ACCOUNT_ROOT_KEY, 'v1');
  assert.equal((await resolveSecrets({ SGX_ACCOUNT_ROOT_KEY: counting }, 60_001)).SGX_ACCOUNT_ROOT_KEY, 'v2');
  _resetSecretCache();
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  try {
    let fail = true;
    const flaky = { get: async () => { if (fail) throw new Error('boom secret-value'); return 'ok'; } };
    const out = await resolveSecrets({ SGX_PW_PEPPER: flaky, SGX_ACCOUNT_PUBLIC: store('pub') }, 0);
    assert.equal(out.SGX_PW_PEPPER, '');
    assert.equal(out.SGX_ACCOUNT_PUBLIC, 'pub');
    fail = false;
    assert.equal((await resolveSecrets({ SGX_PW_PEPPER: flaky, SGX_ACCOUNT_PUBLIC: store('pub') }, 1000)).SGX_PW_PEPPER, 'ok', '失败那轮没缓存，下个请求重试');
  } finally { console.error = orig; }
  assert.deepEqual(logs, ['[sgx-account] secret read failed: SGX_PW_PEPPER']);
  /* get() 返回非字符串 → 当作取值失败 */
  _resetSecretCache();
  assert.equal((await resolveSecrets({ SGX_ACCOUNT_PRIVATE: store(null) }, 0)).SGX_ACCOUNT_PRIVATE, '');
  _resetSecretCache();
});
