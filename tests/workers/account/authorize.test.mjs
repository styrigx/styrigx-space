/**
 * 账号授权（workers/account/src/core/scopes.js、core/authorize.js）：
 * - 作用域表与方案 4.2 一致：5 项，id、所属应用、中英名；id 格式 <应用>.<动作>、只用 [a-z.]；冻结
 * - knownScopes：只留已知作用域、去重、按字母排序
 * - grantedScopes（读 account_grant）：已授权 ∩ 作用域表；0 行 → []（没有种子 / 骨架行为了）；账号会话无效 → []；取消后下一次立即不含；不写库
 * - authorize：账号会话有效 / 过期 / 设备已退出 / 纪元变了 / 没 cookie / 格式错 / 别的钥匙签 / 账号库出错 的结论；
 *   reauth 只在 opts.reauth === true 时读 sgx-account-reauth，且要挂在同一台设备的 session 上；只读不签（不写 cookie、不推纪元）
 *
 * 运行：node --test tests/workers/account/authorize.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { K, keys, makeEnv, accSession, reauthTicket as reauth, setEpoch, epochOf, TEST_DEVICE_ID, devices } from './_fixtures.mjs';
import { makeAccountD1 } from './_d1.mjs';

const CORE = '../../../workers/account/src/core/';
const scopes = await import(CORE + 'scopes.js');
const authz = await import(CORE + 'authorize.js');
const grant = await import(CORE + 'grants.js');

before(keys);

const URL_ = 'https://internal.invalid/';
/** @param {Record<string,string>} ck */
const reqWith = (ck) => {
  const c = Object.entries(ck).filter(([, v]) => v).map(([k, v]) => k + '=' + v).join('; ');
  return new Request(URL_, { headers: c ? { Cookie: c } : {} });
};
const ALL = ['avatar.write', 'curio.write', 'daymark.write', 'prefs.sync', 'profile.write', 'wellbeing.write'];
const NO = (reason) => ({ ok: false, reason, deviceId: '', scopes: [], reauth: false });
/** 账号库执行过的读纪元语句条数 @param {any} env */
const epochReads = (env) => env.D1_ACCOUNT.statements.filter((s) => /^\s*SELECT\b[\s\S]*\bFROM\s+account_epoch\b/i.test(s)).length;

/* ---------------- 作用域表 ---------------- */

test('作用域表：方案 4.2 的 5 项 + 个人资料（2026-11-07）（id、所属应用、英文名——中文在主站字符串表 js.account.app_<应用>），顺序固定', () => {
  assert.deepEqual(scopes.SCOPES.map((s) => ({ id: s.id, app: s.app, name: s.name })), [
    { id: 'curio.write', app: 'curio', name: 'Curio' },
    { id: 'daymark.write', app: 'daymark', name: 'Daymark' },
    { id: 'prefs.sync', app: 'prefs', name: 'Settings sync' },
    { id: 'wellbeing.write', app: 'wellbeing', name: 'Digital wellbeing' },
    { id: 'avatar.write', app: 'avatar', name: 'Avatar' },
    { id: 'profile.write', app: 'profile', name: 'Profile' },
  ]);
});

test('作用域表：只有奇趣有另要账号复验的敏感操作（批量导入）', () => {
  const m = Object.fromEntries(scopes.SCOPES.map((s) => [s.id, [...s.sensitive]]));
  assert.deepEqual(m, {
    'curio.write': ['POST /curio/api/import'],
    'daymark.write': [],
    'prefs.sync': [],
    'wellbeing.write': [],
    'avatar.write': [],
    'profile.write': [],
  });
});

test('作用域 id：<应用>.<动作>、全小写、只用 [a-z.]，前缀就是所属应用；应用不重复', () => {
  for (const s of scopes.SCOPES) {
    assert.match(s.id, scopes.SCOPE_ID_RE, s.id);
    assert.match(s.id, /^[a-z.]+$/);
    assert.equal(s.id.split('.')[0], s.app, s.id);
  }
  assert.equal(new Set(scopes.SCOPES.map((s) => s.app)).size, scopes.SCOPES.length);
  for (const bad of ['Curio.write', 'curio', 'curio.write.x', 'curio-write', 'curio.', '.write', 'curio.wr1te', '']) {
    assert.doesNotMatch(bad, scopes.SCOPE_ID_RE, bad);
  }
});

test('作用域表冻结（表、每一项、名字、敏感操作列表）；SCOPE_IDS 按字母排序', () => {
  assert.ok(Object.isFrozen(scopes.SCOPES));
  for (const s of scopes.SCOPES) {
    assert.ok(Object.isFrozen(s));
    assert.ok(Object.isFrozen(s.name));
    assert.ok(Object.isFrozen(s.sensitive));
  }
  assert.ok(Object.isFrozen(scopes.SCOPE_IDS));
  assert.deepEqual([...scopes.SCOPE_IDS], ALL);
});

test('isScopeId / knownScopes：只认作用域表里的；去重、排序；非数组 → []', () => {
  assert.equal(scopes.isScopeId('curio.write'), true);
  for (const x of ['curio.read', 'CURIO.WRITE', ' curio.write', null, undefined, 1, {}]) assert.equal(scopes.isScopeId(x), false, String(x));
  assert.deepEqual(scopes.knownScopes(['prefs.sync', 'curio.write', 'x.y', 'curio.write', 3, 'avatar.write']), ['avatar.write', 'curio.write', 'prefs.sync']);
  assert.deepEqual(scopes.knownScopes('curio.write'), []);
  assert.deepEqual(scopes.knownScopes(null), []);
});

/* ---------------- grantedScopes（P3-1：读授权记录） ---------------- */

/** 直接往库里写一行授权（绕过 app-grant.js，测读路径） @param {any} env @param {string} app @param {string[]} sc */
const putRow = (env, app, sc) => env.D1_ACCOUNT.raw.prepare('INSERT OR REPLACE INTO account_grant (app, record, granted_at) VALUES (?, ?, ?)')
  .run(app, JSON.stringify({ v: 1, scopes: sc, deviceId: TEST_DEVICE_ID, by: 'passkey' }), 1);
const SESS = { ok: true, deviceId: TEST_DEVICE_ID, by: 'passkey' };

test('grantedScopes：已授权 ∩ 作用域表（空库经 0005 = 全部，每次新数组）；0 行 → []；无效 / 缺 → []', async () => {
  const env = makeEnv();
  const a = await authz.grantedScopes(env, SESS);
  assert.deepEqual(a, ALL);
  a.push('x.y');
  assert.deepEqual(await authz.grantedScopes(env, SESS), ALL, '改返回值不影响下一次');
  assert.deepEqual(await authz.grantedScopes(env, { ok: false }), []);
  assert.deepEqual(await authz.grantedScopes(env, null), []);
  assert.deepEqual(await authz.grantedScopes(env, { ok: 'true' }), []);
  env.D1_ACCOUNT.raw.exec('DELETE FROM account_grant');
  assert.deepEqual(await authz.grantedScopes(env, SESS), [], '0 行 = 没授权（不再有骨架行为）');
  putRow(env, 'curio', ['curio.write']);
  putRow(env, 'prefs', ['prefs.sync']);
  assert.deepEqual(await authz.grantedScopes(env, SESS), ['curio.write', 'prefs.sync']);
  putRow(env, 'avatar', ['avatar.write', 'curio.read', 'daymark.write']);
  assert.deepEqual(await authz.grantedScopes(env, SESS), ['avatar.write', 'curio.write', 'prefs.sync'], '不属于本应用 / 不在表里的不算');
  env.D1_ACCOUNT.raw.prepare("INSERT INTO account_grant (app, record, granted_at) VALUES ('book', ?, 1)").run(JSON.stringify({ v: 1, scopes: ['book.write'] }));
  assert.deepEqual(await authz.grantedScopes(env, SESS), ['avatar.write', 'curio.write', 'prefs.sync']);
  env.D1_ACCOUNT.raw.prepare("INSERT OR REPLACE INTO account_grant (app, record, granted_at) VALUES ('prefs', 'not json', 1)").run();
  assert.deepEqual(await authz.grantedScopes(env, SESS), ['avatar.write', 'curio.write']);
});

test('grantedScopes：取消后下一次立即不含该作用域，重新授权后恢复', async () => {
  const env = makeEnv();
  await grant.revokeGrant(env, 'curio');
  assert.deepEqual(await authz.grantedScopes(env, SESS), ALL.filter((s) => s !== 'curio.write'));
  await grant.addGrant(env, 'curio', SESS);
  assert.deepEqual(await authz.grantedScopes(env, SESS), ALL);
});

test('grantedScopes：读授权记录出错 → 抛（authorize 接住 fail closed）；空库（迁移没跑）兜底建表后 0 行 → []', async () => {
  const down = makeEnv({ D1_ACCOUNT: { prepare() { throw new Error('down'); }, batch() { throw new Error('down'); } } });
  await assert.rejects(() => authz.grantedScopes(down, SESS), /down/);
  const fresh = makeEnv({ D1_ACCOUNT: makeAccountD1({ migrations: false }) });
  assert.deepEqual(await authz.grantedScopes(fresh, SESS), []);
});

test('authorize：奇趣已取消 → ok 但 scopes 不含 curio.write；授权表坏了 → error', async () => {
  const env = makeEnv();
  await grant.revokeGrant(env, 'curio');
  const r = await authz.authorize(env, reqWith({ 'sgx-account-session': await accSession() }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.scopes, ALL.filter((s) => s !== 'curio.write'));
  env.D1_ACCOUNT.raw.exec('DROP TABLE account_grant; CREATE VIEW account_grant AS SELECT 1 AS broken');
  assert.deepEqual(await authz.authorize(env, reqWith({ 'sgx-account-session': await accSession() })), NO('error'));
});

/* ---------------- authorize ---------------- */

test('authorize：账号会话有效 → ok、deviceId 取自票、全部作用域、没要复验 reauth=false', async () => {
  const env = makeEnv();
  const r = await authz.authorize(env, reqWith({ 'sgx-account-session': await accSession() }));
  assert.deepEqual(r, { ok: true, reason: 'ok', deviceId: TEST_DEVICE_ID, scopes: ALL, reauth: false });
});

test('authorize：deviceId 跟着票走（另一台设备的票回另一台的 id）', async () => {
  const env = makeEnv();
  const r = await authz.authorize(env, reqWith({ 'sgx-account-session': await accSession('passkey', 0, Date.now(), { deviceId: 'otherdevice_0002' }) }));
  assert.equal(r.ok, true);
  assert.equal(r.deviceId, 'otherdevice_0002');
});

test('authorize：账号会话过期 → expired', async () => {
  const env = makeEnv();
  const past = Date.now() - 500 * 86400000;
  const r = await authz.authorize(env, reqWith({ 'sgx-account-session': await accSession('password', 0, past, { now: past }) }));
  assert.deepEqual(r, NO('expired'));
});

test('authorize：设备已退出 → revoked', async () => {
  const env = makeEnv();
  const ck = await accSession();
  assert.equal((await authz.authorize(env, reqWith({ 'sgx-account-session': ck }))).ok, true, '先补记了设备');
  await devices.revokeDevice(env, TEST_DEVICE_ID);
  assert.deepEqual(await authz.authorize(env, reqWith({ 'sgx-account-session': ck })), NO('revoked'));
});

test('authorize：纪元变了 → epoch-changed（同一张票，账号库纪元推进后失效）', async () => {
  const env = makeEnv();
  const ck = await accSession('password', 0);
  setEpoch(env, 1);
  assert.deepEqual(await authz.authorize(env, reqWith({ 'sgx-account-session': ck })), NO('epoch-changed'));
});

test('authorize：没 cookie / 格式错 / 别的钥匙签 / 缺公钥 / 账号库出错 → 各自原因代号，不抛', async () => {
  const env = makeEnv();
  assert.deepEqual(await authz.authorize(env, reqWith({})), NO('no-cookie'));
  assert.deepEqual(await authz.authorize(env, reqWith({ 'sgx-space-session': 'x' })), NO('no-cookie'), '进站会话不算');
  assert.deepEqual(await authz.authorize(env, reqWith({ 'sgx-account-session': 'garbage' })), NO('bad-format'));
  assert.deepEqual(await authz.authorize(env, reqWith({ 'sgx-account-session': await accSession('password', 0, Date.now(), { priv: K.OTHER.priv }) })), NO('bad-sig'));
  assert.deepEqual(await authz.authorize(makeEnv({ SGX_ACCOUNT_PUBLIC: '' }), reqWith({ 'sgx-account-session': await accSession() })), NO('no-pubkey'));
  const down = makeEnv({ D1_ACCOUNT: { prepare() { throw new Error('down'); }, batch() { throw new Error('down'); } } });
  assert.deepEqual(await authz.authorize(down, reqWith({ 'sgx-account-session': await accSession() })), NO('d1-error'));
});

test('authorize：处理中抛错（读请求头就抛）→ { ok:false, reason:error }，不往外抛', async () => {
  const bad = { headers: { get() { throw new TypeError('boom'); } } };
  const r = await authz.authorize(makeEnv(), /** @type {any} */ (bad));
  assert.deepEqual(r, NO('error'));
});

test('authorize：reauth 只在 opts.reauth === true 时读票——有效复验票 + 没要 → reauth=false 且不多读一次纪元', async () => {
  const env = makeEnv();
  const ck = { 'sgx-account-session': await accSession(), 'sgx-account-reauth': await reauth() };
  await authz.authorize(env, reqWith(ck)); /* 预热：第一次读纪元会补种 epoch 行、补记设备 */
  const before0 = epochReads(env);
  const plain = await authz.authorize(env, reqWith(ck));
  const plainReads = epochReads(env) - before0;
  assert.equal(plain.ok, true);
  assert.equal(plain.reauth, false);
  for (const o of [undefined, {}, { reauth: false }, { reauth: 'true' }, { reauth: 1 }, null]) {
    const r = await authz.authorize(env, reqWith(ck), /** @type {any} */ (o));
    assert.equal(r.reauth, false, JSON.stringify(o));
  }
  const b1 = epochReads(env);
  const asked = await authz.authorize(env, reqWith(ck), { reauth: true });
  assert.deepEqual(asked, { ok: true, reason: 'ok', deviceId: TEST_DEVICE_ID, scopes: ALL, reauth: true });
  assert.equal(epochReads(env) - b1, plainReads + 1, '要复验时多读一张票（多一次纪元读）');
});

test('authorize：要复验但没票 / 票是别的钥匙签的 / 票的纪元旧了 → ok 仍为 true，reauth=false', async () => {
  const env = makeEnv();
  const sess = await accSession('password', 0);
  assert.equal((await authz.authorize(env, reqWith({ 'sgx-account-session': sess }), { reauth: true })).reauth, false);
  const forged = await reauth('password', 0, { priv: K.OTHER.priv });
  let r = await authz.authorize(env, reqWith({ 'sgx-account-session': sess, 'sgx-account-reauth': forged }), { reauth: true });
  assert.equal(r.ok, true);
  assert.equal(r.reauth, false);
  setEpoch(env, 2);
  const sess2 = await accSession('password', 2);
  r = await authz.authorize(env, reqWith({ 'sgx-account-session': sess2, 'sgx-account-reauth': await reauth('password', 1) }), { reauth: true });
  assert.equal(r.ok, true);
  assert.equal(r.reauth, false);
});

test('authorize：没账号会话时不读复验票（有效复验票也不算）', async () => {
  const env = makeEnv();
  const r = await authz.authorize(env, reqWith({ 'sgx-account-reauth': await reauth() }), { reauth: true });
  assert.deepEqual(r, NO('no-cookie'));
});

test('authorize：只读不签——不推纪元、不写授权相关的表；只有设备补记 / lastSeen（既有节流）', async () => {
  const env = makeEnv();
  const ck = { 'sgx-account-session': await accSession(), 'sgx-account-reauth': await reauth() };
  await authz.authorize(env, reqWith(ck), { reauth: true });
  await authz.authorize(env, reqWith(ck), { reauth: true });
  assert.equal(epochOf(env), 0);
  /* 读纪元时补种 epoch 行（INSERT OR IGNORE … 0，readEpoch 既有行为）不算推进 */
  const writes = env.D1_ACCOUNT.statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(s) && !/^\s*INSERT OR IGNORE INTO account_epoch\b/i.test(s));
  for (const s of writes) assert.match(s, /\baccount_device\b/i, '只有设备记录会写：' + s);
  assert.ok(!writes.some((s) => /\baccount_grant\b/i.test(s)), '授权查询不写授权记录');
});
