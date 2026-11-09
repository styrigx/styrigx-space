/**
 * 2.11 定稿测试：进站凭证 / 锁屏凭证鉴权拆分。
 *
 * 九组（定稿第十节）：
 * 1. 越权：scope 不匹配 403；lock passkey 开 stepup 被拒；已配置层拒 by=space
 * 2. 无 lock 会话：单用锁屏凭证进入口 2、单用进站凭证进入口 1 均被拒
 * 3. 重置锁屏（账号拆分 PR3，方案第 7 节）：只锁屏凭证或只根（开关关闭）被拒；两者都过拿到 lockreset（by=password / passkey）；
 *    lockreset 访问主页面/APP/会话/入口1/2 均 403 且不产生 sgx-verified；
 *    完成后旧会话失效；锁屏凭证一项都没有时被拒；网关不读账号凭证
 * 4. 开关：缺失/过期/超 24 小时/格式错误时单根被拒；有效时单根拿到 lockreset；
 *    有效时仍被拒
 * 5. 假入口（只剩 lock-reset，锁屏已设置时）：提交正确 SGX_SPACE_RECOVERY_KEY 返回 401 auth，与错误密钥响应逐字节相同；lock-reauth 要先进门（任何 by）
 * 6. 接管：未配时根可代管；配置后失效；接管后旧 root 票/会话被拒；
 *    D1 读失败时根代管被拒
 * 7. pepper：旧 hash 重哈希；缺 pepper fail closed；锁屏密码不再与账号密码比对（网关不读账号表）
 * 8. /api/space-auth：错误 401 auth，缺 Origin 403；/api/owner-auth 不可用
 * 9. 限速：进站凭证各路径共用计数
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession } from './_tickets.mjs';
import { makeKV, genKeyPair, postReq, authD1For } from '../_harness.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;

/* 恢复开关：2026-10-27 起在 D1（D1_SPACE），不再有 KV 键（模块不再导出键名）；方案 9.4 起表名 lock_reset_switch */
const SWITCH_MOD = await import('../../../workers/space-core/src/core/lock-reset-switch.js');
assert.equal('LOCK_RESET_SWITCH_KEY' in SWITCH_MOD, false, '开关不再是 KV 键');

test('预览库按编号跑网关迁移（PR4）：0008 把旧表 recovery_switch 的行拷进 lock_reset_switch，0009 再 DROP 旧表；行原样', async () => {
  const fs = await import('node:fs');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = REPO + 'workers/space-core/migrations/';
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.includes('0009_drop_recovery_switch.sql'));
  const db = new DatabaseSync(':memory:');
  for (const f of files) {
    if (f === '0008_lock_reset_switch.sql') db.exec("INSERT INTO recovery_switch VALUES ('OLD_USED', 5, 1), ('OLD_UNSEEN', 0, 0)");
    db.exec(fs.readFileSync(dir + f, 'utf8'));
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.ok(!tables.includes('recovery_switch'), '旧表已删');
  assert.deepEqual(db.prepare('SELECT hash, first_seen, used FROM lock_reset_switch ORDER BY hash').all().map((r) => ({ ...r })),
    [{ hash: 'OLD_UNSEEN', first_seen: 0, used: 0 }, { hash: 'OLD_USED', first_seen: 5, used: 1 }]);
  assert.equal(fs.readFileSync(dir + '0009_drop_recovery_switch.sql', 'utf8').replace(/--.*$/gm, '').trim(), 'DROP TABLE IF EXISTS recovery_switch;');
});

test('恢复开关表名 lock_reset_switch（方案 9.4）：CREATE_SQL 与 migrations/0008_lock_reset_switch.sql 的建表语句一致；模块去掉注释后不再出现旧表名 recovery_switch', async () => {
  const fs = await import('node:fs');
  const flat = (x) => x.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
  const mig = fs.readFileSync(REPO + 'workers/space-core/migrations/0008_lock_reset_switch.sql', 'utf8')
    .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').split(';').map(flat).filter(Boolean);
  assert.equal(mig[0], SWITCH_MOD.CREATE_SQL);
  assert.equal(mig[1], 'INSERT OR IGNORE INTO lock_reset_switch (hash, first_seen, used) SELECT hash, first_seen, used FROM recovery_switch');
  const code = fs.readFileSync(REPO + 'workers/space-core/src/core/lock-reset-switch.js', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /recovery_switch/);
  assert.equal((code.match(/\block_reset_switch\b/g) || []).length, 7, 'CREATE_SQL + 6 条读写');
  /* 网关运行时代码（src/）去掉注释后都不再读写旧表 */
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d + '/' + e.name) : /\.m?js$/.test(e.name) ? [d + '/' + e.name] : []));
  for (const f of walk(REPO + 'workers/space-core/src')) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''), /recovery_switch/, f);
  }
});

/* 测试用 Ed25519 密钥（运行时生成，仅测试，不用于生产） */
let TEST_PRIV_PEM = '';
let TEST_PUB_PEM = '';

async function genTestKeys() {
  ({ priv: TEST_PRIV_PEM, pub: TEST_PUB_PEM } = await genKeyPair());
}
await genTestKeys();

function baseEnv(kv, overrides) {
  return Object.assign({
    D1_SPACE: authD1For(kv),
    SGX_SPACE_RECOVERY_KEY: 'test-root-key-12345',
    SGX_SPACE_PRIVATE: TEST_PRIV_PEM,
    SGX_SPACE_PUBLIC: TEST_PUB_PEM,
    SGX_SPACE_PASSWORD_PEPPER: 'test-pepper', SGX_SPACE_TEMPKEY_PEPPER: 'test-pepper',
    SGX_RP_ID: 'test.example.com',
    SGX_ORIGIN: 'https://test.example.com',
  }, overrides || {});
}

/*
 * 「已配置」= D1 里锁屏自己真有凭证（layers.js realCredentialPresence）。
 * configuredKV({ lock, account })：一份 kv（只当 authD1For 的钥匙），对应的 D1 里写好锁屏密码；account 只往库里摆一行
 * realm='account' 的密码（拆分前遗留的行，网关不该读到它）。
 * 账号密码固定 'account-pass-1'，锁屏密码 'lock-pass-1'（pepper = baseEnv 的 test-pepper）。
 */
const { makePasswordRecord: mkPw } = await import(REPO + '/workers/space-core/src/core/password.js');
const ACCOUNT_PW_REC = await mkPw('account-pass-1', 'test-pepper');
const LOCK_PW_REC = await mkPw('lock-pass-1', 'test-pepper');
function configuredKV(o) {
  const kv = makeKV();
  const db = authD1For(kv);
  if (o && o.lock) db.putPassword('lock', LOCK_PW_REC);
  if (o && o.account) db.putPassword('account', ACCOUNT_PW_REC);
  return kv;
}

/* ============ 1. 越权 ============ */



/* ============ 2. 无 lock 会话 ============ */


test('2.11 v3 L1：恢复钥匙不签 reauth 票——purpose=lock-reauth 有没有会话都 → 400 purpose，不比对、不计数、不签票', async () => {
  const { onRequestPost } = await import(REPO + '/workers/space-core/src/api/space-auth.js');
  const kv = configuredKV({ lock: true });
  const env = baseEnv(kv);
  const cookie = 'sgx-space-session=' + (await testLockSession(TEST_PRIV_PEM, 0, 'password'));
  for (const h of [undefined, { Cookie: cookie }]) {
    const res = await onRequestPost({ request: postReq('https://test.example.com/api/space-auth', { key: 'test-root-key-12345', purpose: 'lock-reauth' }, h), env });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: 'purpose' });
    const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
    assert.ok(!sc.some((c) => c.startsWith('sgx-space-reauth=')), '不签 LockReauthTicket');
  }
  assert.equal(switchDb(kv).raw.prepare("SELECT COUNT(*) AS n FROM attempt_limit WHERE realm = 'lock' AND kind = 'spacekey'").get().n, 0);
});

/* ============ 3. 重置锁屏 ============ */

test('2.11 重置锁屏：开关关闭时只锁屏凭证被拒（缺进站凭证 → 401）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/space-core/src/api/lock-reset.js');
  const kv = configuredKV({ lock: true });
  const env = baseEnv(kv);
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify',
    lockProof: { type: 'password', password: 'lock-pass-1' },
    /* 无 spaceKey */
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('Set-Cookie'), null);
});

/* ============ 4. 恢复开关（D1 lock_reset_switch：计时 / 单次） ============ */

const DAY_MS = 24 * 3600 * 1000;
/** 某份 kv 对应的那个 D1（baseEnv 里三个绑定都是它） */
const switchDb = (kv) => authD1For(kv);
/** 模拟 Sloan 在 D1 控制台插一行「还没见过」的开关（firstSeen = 0），或摆一行已计时 / 已用的 */
function openSwitch(db, hash, firstSeen = 0, used = 0) {
  db.raw.prepare('INSERT INTO lock_reset_switch (hash, first_seen, used) VALUES (?, ?, ?)').run(hash, firstSeen, used);
}
const switchRows = (db) => db.raw.prepare('SELECT * FROM lock_reset_switch ORDER BY hash').all().map((r) => Object.assign({}, r));
/** 读过 / 写过开关表没有（看执行过的 SQL） */
const touchedSwitch = (db) => db.calls.some((sql) => /lock_reset_switch|recovery_switch/.test(sql));

function switchEnv(kv, hash) {
  const env = baseEnv(kv);
  if (hash !== undefined) openSwitch(switchDb(kv), hash);
  return env;
}

test('2.11 开关：过期（24h+）→ 关闭；同时还有一行没见过的 → 那一行开始计时、有效', async () => {
  const { checkLockResetSwitch } = SWITCH_MOD;
  const db = switchDb(makeKV());
  openSwitch(db, 'old', Date.now() - 25 * 3600 * 1000);
  const r = await checkLockResetSwitch(db);
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'expired');
  openSwitch(db, 'fresh');
  const r2 = await checkLockResetSwitch(db);
  assert.equal(r2.valid, true);
  assert.equal(r2.reason, 'first-seen');
  assert.equal(r2.hash, 'fresh');
  assert.ok(switchRows(db).find((x) => x.hash === 'fresh').first_seen > 0, '开始计时');
  /* 再查：计时中 */
  const r3 = await checkLockResetSwitch(db);
  assert.equal(r3.reason, 'within-window');
});

test('2.11 开关：D1 缺失/失败 → fail closed', async () => {
  const { checkLockResetSwitch, claimLockResetSwitch } = SWITCH_MOD;
  /* D1 未绑定 */
  const r1 = await checkLockResetSwitch(null);
  assert.equal(r1.valid, false);
  assert.equal(r1.reason, 'unavailable');
  /* D1 抛错（即使有可用的行） */
  const db = switchDb(makeKV());
  openSwitch(db, 'some');
  db.failOn = (sql) => /lock_reset_switch/.test(sql);
  const r2 = await checkLockResetSwitch(db);
  assert.equal(r2.valid, false);
  assert.equal(r2.reason, 'd1-error');
  assert.equal(await claimLockResetSwitch(db, 'some'), false, '标记已用失败 → 不签');
  const brokenDb = { prepare: () => { throw new Error('d1-down'); } };
  assert.equal((await checkLockResetSwitch(brokenDb)).valid, false);
});

test('2.11 开关：进站凭证错误时不读开关', async () => {
  const { onRequestPost } = await import(REPO + '/workers/space-core/src/api/lock-reset.js');
  const kv = configuredKV({ lock: true });
  const env = switchEnv(kv, 'secret');
  const db = switchDb(kv);
  db.calls.length = 0;
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', spaceKey: 'wrong-key',
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
  assert.equal(touchedSwitch(db), false, '进站凭证错误时不应读开关');
  assert.equal(switchRows(db)[0].first_seen, 0, '不开始计时');
});

test('2.11 开关：有效时单锁屏凭证仍被拒（进站凭证优先，不可跳过）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/space-core/src/api/lock-reset.js');
  const kv = configuredKV({ lock: true });
  const env = switchEnv(kv, 'switch-1');
  /* 有 lockProof 但无 spaceKey → 401（进站凭证不可跳过） */
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify',
    lockProof: { type: 'password', password: 'lock-pass-1' },
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
  assert.equal(switchRows(switchDb(kv))[0].used, 0, '开关没被用掉');
});

/* ============ 5. 假入口 ============ */

test('2.11 假入口（只剩 lock-reset）：锁屏已设置时 lock-reset 提交正确进站凭证 → 401 auth，与错误密钥响应逐字节相同', async () => {
  const { onRequestPost } = await import(REPO + '/workers/space-core/src/api/space-auth.js');
  const res1 = await onRequestPost({ request: postReq('https://test.example.com/api/space-auth', { key: 'test-root-key-12345', purpose: 'lock-reset' }), env: baseEnv(configuredKV({ lock: true })) });
  const res2 = await onRequestPost({ request: postReq('https://test.example.com/api/space-auth', { key: 'wrong-key', purpose: 'lock-reset' }), env: baseEnv(configuredKV({ lock: true })) });
  assert.equal(res1.status, 401);
  assert.equal(res2.status, 401);
  const b1 = await res1.text();
  const b2 = await res2.text();
  assert.equal(b1, b2);
  assert.equal(b1, JSON.stringify({ ok: false, error: 'auth' }));
});

test('2.11 假入口：缺 Origin → 403（先于假入口）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/space-core/src/api/space-auth.js');
  const kv = configuredKV({ lock: true });
  const env = baseEnv(kv);
  const req = new Request('https://test.example.com/api/space-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'test-root-key-12345' }),
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 403);
});

/* ============ 7. pepper ============ */


test('2.11 pepper：锁屏密码不再与账号密码比对（库里遗留同值的账号密码也照样能设）；AccountReauthTicket 进不了锁屏密码接口', async () => {
  const { onRequestPost: pwPost } = await import(REPO + '/workers/space-core/src/api/lock-password.js');
  const { signLockReauthTicket } = await import(REPO + '/workers/space-core/src/core/tickets.js');
  const kv = configuredKV({ lock: true, account: true }); /* 纪元在 D1，没有 → 0；遗留账号密码 = account-pass-1 */
  const env = baseEnv(kv);
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'password');
  const reauth = await signLockReauthTicket(TEST_PRIV_PEM, 'password', 0);
  const res = await pwPost({ request: postReq('https://test.example.com/api/lock-password',
    { action: 'change', password: 'account-pass-1' }, { Cookie: 'sgx-space-session=' + sessCv + '; sgx-space-reauth=' + reauth }), env });
  assert.equal(res.status, 200, '不再 403 same-as-account');
  /* 拿账号 reauth 票的 cookie 名去设锁屏密码 → 403 reauth（账号票网关一概不认；新库，纪元仍是 0） */
  const env2 = baseEnv(configuredKV({ lock: true }));
  const res2 = await pwPost({ request: postReq('https://test.example.com/api/lock-password',
    { action: 'set', password: 'another-pass-123' }, { Cookie: 'sgx-space-session=' + sessCv + '; sgx-account-reauth=' + reauth }), env: env2 });
  assert.equal(res2.status, 403);
  assert.equal((await res2.json()).error, 'reauth');
});

/* ============ 8. space-auth ============ */

test('2.11 space-auth：错误密钥 401 auth（引导模式，lock-reset）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/space-core/src/api/space-auth.js');
  const kv = makeKV(); /* lock 未配置 → 引导模式 */
  const env = baseEnv(kv);
  const req = postReq('https://test.example.com/api/space-auth', { key: 'wrong-key', purpose: 'lock-reset' });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { ok: false, error: 'auth' });
});

test('2.11 space-auth：缺 Origin 403 origin', async () => {
  const { onRequestPost } = await import(REPO + '/workers/space-core/src/api/space-auth.js');
  const kv = makeKV();
  const env = baseEnv(kv);
  const req = new Request('https://test.example.com/api/space-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'x' }),
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'origin');
});

test('2.11 space-auth：旧 /api/owner-auth 不再可用（文件不存在）', async () => {
  const fs = await import('node:fs');
  assert.equal(fs.existsSync(REPO + '/workers/space-core/src/api/owner-auth.js'), false);
});

/* ============ 9. 限速 ============ */

test('2.11 限速：进站凭证各路径共用计数（space-auth 失败计入 lockreset 限速）', async () => {
  const { checkSpaceLimit, recordSpaceFail } = await import(REPO + '/workers/space-core/src/core/space-limit.js');
  const { onRequestPost: spaceAuth } = await import(REPO + '/workers/space-core/src/api/space-auth.js');
  const { onRequestPost: lockReset } = await import(REPO + '/workers/space-core/src/api/lock-reset.js');
  const kv = configuredKV({ lock: true });
  const env = baseEnv(kv);
  const ip = '1.2.3.4';
  /* 单元：5 次失败后锁定（D1 attempt_limit，realm=root） */
  for (let i = 0; i < 5; i++) {
    await recordSpaceFail(env, ip);
  }
  const lim = await checkSpaceLimit(env, ip);
  assert.equal(lim.limited, true);
  /* 跨路径：space-auth（锁屏已设置时 lock-reset 假入口，计单 IP）失败 3 次 + lock-reset 失败 2 次 → 同一行计到锁定 */
  const ip2 = '1.2.3.5';
  const h = { 'CF-Connecting-IP': ip2 };
  for (let i = 0; i < 3; i++) {
    assert.equal((await spaceAuth({ request: postReq('https://test.example.com/api/space-auth', { key: 'wrong', purpose: 'lock-reset' }, h), env })).status, 401);
  }
  for (let i = 0; i < 2; i++) {
    assert.equal((await lockReset({ request: postReq('https://test.example.com/api/lock-reset', { action: 'verify', spaceKey: 'wrong' }, h), env })).status, 401);
  }
  const rows = switchDb(kv).raw.prepare("SELECT * FROM attempt_limit WHERE realm = 'lock' AND kind = 'spacekey' AND bucket = ?").all(ip2);
  assert.equal(rows.length, 1, '各路径共用一行');
  assert.ok(rows[0].locked_until > Date.now(), '合计 5 次 → 锁定');
  const res = await lockReset({ request: postReq('https://test.example.com/api/lock-reset', { action: 'verify', spaceKey: 'test-root-key-12345' }, h), env });
  assert.equal(res.status, 429, '锁定中 lock-reset 码对也 429');
});

/* ============ 10. 补充二：管理页加载触发开关计时 ============ */

test('2.11 补充二：/api/layer-status 已删（账号拆分 PR3：前端无调用方；开关计时由 touchLockResetSwitch 直接测）', async () => {
  const fs = await import('node:fs');
  assert.equal(fs.existsSync(REPO + '/workers/space-core/src/api/layer-status.js'), false);
  const { API_ROUTES } = await import(REPO + '/workers/space-core/src/router.js');
  assert.equal(API_ROUTES.has('/api/layer-status'), false);
  const { touchLockResetSwitch } = SWITCH_MOD;
  const kv = configuredKV({ lock: true });
  switchEnv(kv, 'timer-1');
  await touchLockResetSwitch(switchDb(kv));
  const rows = switchRows(switchDb(kv));
  assert.equal(rows.length, 1, '不插新行');
  assert.ok(rows[0].first_seen > 0, '开始计时');
  assert.equal(rows[0].used, 0);
});

/* ============ 11. 补充四：恢复开关提示仅出现在重置第二步 ============ */

test('2.11 补充四：进站凭证错误的 lockreset 响应不含 lock-reset-switch / lock_reset_switch / recovery_switch', async () => {
  const { onRequestPost } = await import(REPO + '/workers/space-core/src/api/lock-reset.js');
  const kv = configuredKV({ lock: true });
  const env = switchEnv(kv, 'some-secret');
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', spaceKey: 'wrong-key',
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
  const text = await res.text();
  assert.ok(!text.includes('lock-reset-switch') && !text.includes('lock_reset_switch') && !text.includes('recovery_switch') && !text.includes('some-secret'), '错误响应不应泄露开关');
});

test('2.11 补充四：lock-reset 假入口（space-auth，锁屏已设置）响应不含 lock-reset-switch / lock_reset_switch / recovery_switch', async () => {
  const { onRequestPost } = await import(REPO + '/workers/space-core/src/api/space-auth.js');
  const kv = configuredKV({ lock: true });
  const env = switchEnv(kv, 'some-secret');
  /* 无会话、锁屏已设置，lock-reset 提交错误密钥 → 假入口 401 */
  const req = postReq('https://test.example.com/api/space-auth', { key: 'wrong-key', purpose: 'lock-reset' });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
  const text = await res.text();
  assert.ok(!text.includes('lock-reset-switch') && !text.includes('lock_reset_switch') && !text.includes('recovery_switch') && !text.includes('some-secret'), '假入口响应不应泄露开关');
});

/* ============ L1：重置 = 恢复钥匙一把（SPACE-V3 §2.0 L2 / L3 / L8、Q1） ============ */

test('L1 重置（SPACE-V3 §2.0 L2 / L3）：恢复钥匙一把就签 reset 票（by=space），不要第二次验证、不读开关；有没有进站凭证都一样', async () => {
  const { onRequestPost } = await import(REPO + '/workers/space-core/src/api/lock-reset.js');
  const { verifyLockResetTicket } = await import(REPO + '/workers/space-core/src/core/tickets.js');
  for (const o of [{ lock: true, account: true }, { account: true }, {}]) {
    const kv = configuredKV(o);
    const env = switchEnv(kv, 'switch-1');
    const db = switchDb(kv);
    db.calls.length = 0;
    const res = await onRequestPost({ request: postReq('https://test.example.com/api/lock-reset', { action: 'verify', spaceKey: 'test-root-key-12345' }), env });
    assert.equal(res.status, 200, JSON.stringify(o));
    assert.deepEqual(await res.json(), { ok: true }, '不再返回 needLock / passkey / password');
    const sc = res.headers.get('Set-Cookie') || '';
    const m = sc.match(/sgx-space-reset=([^;]+)/);
    assert.ok(m, '签了 sgx-space-reset');
    const v = await verifyLockResetTicket(new Request('https://test.example.com/', { headers: { Cookie: 'sgx-space-reset=' + m[1] } }), env);
    assert.equal(v.ok, true);
    assert.equal(v.by, 'space');
    assert.ok(!/sgx-space-session=[^;]/.test(sc), '不签进站会话');
    assert.equal(touchedSwitch(db), false, '不读重置开关');
    assert.equal(switchRows(db)[0].used, 0, '开关没被用掉');
  }
});

test('L1 重置：恢复钥匙错 → 401 auth、不签票（带旧 lockProof 也一样）；challenge 不再有 → 400 action', async () => {
  const { onRequestPost } = await import(REPO + '/workers/space-core/src/api/lock-reset.js');
  const env = baseEnv(configuredKV({ lock: true }));
  const bad = await onRequestPost({ request: postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', spaceKey: 'wrong', lockProof: { type: 'password', password: 'lock-pass-1' } }), env });
  assert.equal(bad.status, 401);
  assert.deepEqual(await bad.json(), { ok: false, error: 'auth' });
  assert.equal(bad.headers.get('Set-Cookie'), null);
  const ch = await onRequestPost({ request: postReq('https://test.example.com/api/lock-reset', { action: 'challenge' }), env });
  assert.equal(ch.status, 400);
  assert.equal((await ch.json()).error, 'action');
});

test('L1 重置 finish（Q1）：要 reset 票；none 不推纪元，all 推纪元（所有设备回锁屏）；两种都清 reset cookie；signOut 只认 all / none', async () => {
  const { onRequestPost } = await import(REPO + '/workers/space-core/src/api/lock-reset.js');
  const { signLockResetTicket } = await import(REPO + '/workers/space-core/src/core/tickets.js');
  const kv = configuredKV({ lock: true });
  const env = baseEnv(kv);
  const epoch = () => Number(authD1For(kv).epoch('lock-epoch') || 0);
  const post = (body, cookie) => onRequestPost({ request: postReq('https://test.example.com/api/lock-reset', body, cookie ? { Cookie: cookie } : undefined), env });
  const noTicket = await post({ action: 'finish', signOut: 'all' });
  assert.equal(noTicket.status, 401);
  assert.equal((await noTicket.json()).error, 'reset');
  assert.equal(epoch(), 0, '没票不推');
  const ck = 'sgx-space-reset=' + (await signLockResetTicket(TEST_PRIV_PEM, 'space', 0));
  assert.equal((await post({ action: 'finish', signOut: 'others' }, ck)).status, 400);
  const none = await post({ action: 'finish', signOut: 'none' }, ck);
  assert.equal(none.status, 200);
  assert.deepEqual(await none.json(), { ok: true, signOut: 'none' });
  assert.equal(epoch(), 0, 'none 不推纪元');
  assert.match(none.headers.get('Set-Cookie') || '', /sgx-space-reset=/, '清 reset cookie');
  const all = await post({ action: 'finish', signOut: 'all' }, ck);
  assert.equal(all.status, 200);
  assert.deepEqual(await all.json(), { ok: true, signOut: 'all' });
  assert.equal(epoch(), 1, 'all 推纪元');
  assert.equal((await post({ action: 'finish', signOut: 'none' }, ck)).status, 401, '纪元推过以后旧票失效');
});

test('L1 重置 end：只清 reset cookie，不要票、幂等、不推纪元', async () => {
  const { onRequestPost } = await import(REPO + '/workers/space-core/src/api/lock-reset.js');
  const kv = configuredKV({ lock: true });
  const env = baseEnv(kv);
  for (let i = 0; i < 2; i++) {
    const res = await onRequestPost({ request: postReq('https://test.example.com/api/lock-reset', { action: 'end' }), env });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.match(res.headers.get('Set-Cookie') || '', /sgx-space-reset=/);
  }
  assert.equal(Number(authD1For(kv).epoch('lock-epoch') || 0), 0);
});

test('L1 重置前端（shell/space/reset.js）：无开关键名、无「管理员」、不再有 needLock / lockProof / needAccount / accountProof', async () => {
  const fs = await import('node:fs');
  assert.equal(fs.existsSync(REPO + 'space/web/assets/js/shell/lock.js'), false, '旧锁屏 lock.js 已删');
  assert.equal(fs.existsSync(REPO + 'space/web/assets/js/auth/reset-flow.js'), false, 'auth/reset-flow.js 已删');
  const src = fs.readFileSync(REPO + 'space/web/assets/js/shell/space/reset.js', 'utf8');
  assert.ok(!/lock-reset-switch|sgx-reset-switch-hint/.test(src));
  assert.ok(!src.includes('管理员')); // old-name guard
  assert.ok(!/needLock|lockProof|needAccount|accountProof/.test(src));
});
