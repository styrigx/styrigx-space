/**
 * 账号拆分 PR2b：账号根密钥 SGX_ACCOUNT_ROOT_KEY（POST /api/account root-reauth / root-reset）与审计（audit-list、安全事件）。
 * 从网关 root-auth / root-check / root-limit / root-audit 的测试复制改写（账号那两条真路径）：
 * - 只认 SGX_ACCOUNT_ROOT_KEY（锁屏根密钥的值不认）；root-reset 不签会话；root-reauth 要账号会话
 * - 限速 attempt_limit realm='account' kind='rootkey'：单 IP 5 次锁 15 分钟（429 cooldown）、全局只减速、成功清计数
 * - 审计 audit realm='account' path = root-reauth / root-reset（7 天）；成功写不进审计不签票（503）
 * - 错误码：401 auth / 401 account / 429 cooldown / 500 config / 503 config / 503 server
 * - 共享 root-check 读 realm.secret：账号侧在调用处转接，共享模块不改
 *
 * 运行：node --test tests/workers/account/account-root.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  keys, makeEnv, post, get, accSession, full, pickCookie, setCookies, one, all, raw, epochOf, seedPassword,
  root, realm, IP, ROOT_KEY, TEST_DEVICE_ID,
} from './_identity.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;

before(keys);

function failing(db, pred) {
  return {
    ...db,
    prepare(sql) {
      const st = db.prepare(sql);
      if (!pred(sql)) return st;
      const boom = { bind: () => boom, first: async () => { throw new Error('D1 down'); }, all: async () => { throw new Error('D1 down'); }, run: async () => { throw new Error('D1 down'); } };
      return boom;
    },
  };
}
const audits = (env) => all(env, "SELECT realm, path, ok, ip_prefix, ts, expires_at FROM audit ORDER BY ts, id");
const limitRow = (env, bucket = IP) => one(env, "SELECT count, locked_until FROM attempt_limit WHERE realm = 'account' AND kind = 'rootkey' AND bucket = ?", bucket);

test('root-reset：正确的账号根密钥 → AccountResetTicket(by=root)，3 分钟、主站 Strict；不签账号会话、不推纪元；审计 realm=account path=root-reset ok=1（7 天）', async () => {
  const env = makeEnv();
  const r = await post(env, { action: 'root-reset', key: ROOT_KEY });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(pickCookie(r, 'sgx-account-session'), null);
  const c = setCookies(r);
  assert.equal(c.length, 1);
  assert.match(c[0], /^sgx-account-reset=root\.0\.\d+\.\d+\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=180$/);
  assert.equal(epochOf(env), 0);
  const a = audits(env);
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].realm, a[0].path, a[0].ok, a[0].ip_prefix], ['account', 'root-reset', 1, '10.9.9.x']);
  assert.equal(a[0].expires_at - a[0].ts, 7 * 24 * 3600 * 1000);
});

test('root-reset 拿到的票能设第一把凭证（账号未配置时唯一入口），之后正常登录', async () => {
  const env = makeEnv();
  const r = await post(env, { action: 'root-reset', key: ROOT_KEY });
  const t = pickCookie(r, 'sgx-account-reset');
  const pc = await post(env, { action: 'password-change', password: 'first-pass-123' }, { 'sgx-account-reset': t });
  assert.deepEqual(await pc.json(), { ok: true, changed: false });
  assert.equal((await post(env, { action: 'login-password', password: 'first-pass-123' })).status, 200);
});

test('root-reset：已有账号会话也不动它（不重签、不清除）', async () => {
  const env = makeEnv();
  const s = await accSession();
  const r = await post(env, { action: 'root-reset', key: ROOT_KEY }, { 'sgx-account-session': s });
  assert.equal(r.status, 200);
  assert.equal(pickCookie(r, 'sgx-account-session'), null);
  assert.equal((await (await get(env, { 'sgx-account-session': s })).json()).session.by, 'password');
});

test('root-reauth：没有账号会话 → 401 account（不比对、不计数、不写审计）', async () => {
  const env = makeEnv();
  const r = await post(env, { action: 'root-reauth', key: ROOT_KEY });
  assert.equal(r.status, 401);
  const j = await r.json();
  assert.equal(j.error, 'account');
  assert.equal(j.reason, 'no-cookie');
  assert.equal(audits(env).length, 0);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM attempt_limit').n, 0);
});

test('root-reauth：有账号会话 → AccountReauthTicket(by=root)；凭它能改账号凭证；审计 path=root-reauth', async () => {
  const env = makeEnv();
  await seedPassword(env, 'old-account-password-1');
  const s = await accSession('passkey');
  const r = await post(env, { action: 'root-reauth', key: ROOT_KEY }, { 'sgx-account-session': s });
  assert.equal(r.status, 200);
  const t = pickCookie(r, 'sgx-account-reauth');
  assert.ok(t.startsWith('root.0.'));
  assert.equal(pickCookie(r, 'sgx-account-session'), null, '不签会话');
  const pc = await post(env, { action: 'password-change', password: 'brand-new-pass-1' }, { 'sgx-account-session': s, 'sgx-account-reauth': t });
  assert.deepEqual(await pc.json(), { ok: true, changed: true });
  assert.deepEqual(audits(env).map((a) => a.path), ['root-reauth', 'password-change']);
});

test('错误的根密钥 → 401 auth（与网关真失败同形）；计入 realm=account kind=rootkey（单 IP + 全局）；审计 ok=0；返回前对齐到 200 毫秒', async () => {
  const env = makeEnv();
  const t0 = Date.now();
  const r = await post(env, { action: 'root-reset', key: 'wrong-key' });
  assert.ok(Date.now() - t0 >= root.MIN_DELAY_MS - 5, '对齐耗时');
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { ok: false, error: 'auth' });
  assert.equal(r.headers.get('Set-Cookie'), null);
  assert.equal(limitRow(env).count, 1);
  assert.equal(one(env, "SELECT count FROM attempt_limit WHERE realm = 'account' AND kind = 'rootkey' AND bucket = '*'").count, 1);
  assert.deepEqual(audits(env).map((a) => [a.path, a.ok]), [['root-reset', 0]]);
});

test('缺 key / 空串 / 只有空白 → 401 auth（也计数）；两边去空白后比对：带空格换行的正确根密钥照样通过', async () => {
  const env = makeEnv();
  for (const body of [{}, { key: '' }, { key: '  \n\t ' }, { key: 123 }]) {
    assert.equal((await post(env, { action: 'root-reset', ...body })).status, 401);
  }
  assert.equal(limitRow(env).count, 4);
  const spaced = ROOT_KEY.slice(0, 8) + ' \n ' + ROOT_KEY.slice(8);
  assert.equal((await post(env, { action: 'root-reset', key: spaced })).status, 200);
});

test('只认 SGX_ACCOUNT_ROOT_KEY：锁屏根密钥（SGX_ROOT_KEY / SGX_ADMIN_KEY）的值不认', async () => {
  const env = makeEnv({ SGX_ROOT_KEY: 'lock-root-key-zzz', SGX_ADMIN_KEY: 'lock-admin-key-zzz' });
  for (const key of ['lock-root-key-zzz', 'lock-admin-key-zzz']) {
    const r = await post(env, { action: 'root-reset', key });
    assert.equal(r.status, 401, key);
  }
  assert.equal((await post(env, { action: 'root-reset', key: ROOT_KEY })).status, 200);
});

test('单 IP 连错 5 次 → 锁 15 分钟：锁定中正确根密钥也 429 cooldown（不比对、照写审计）；到期后放行；成功清掉本 IP 计数', async () => {
  const env = makeEnv();
  for (let i = 0; i < 5; i++) assert.equal((await post(env, { action: 'root-reset', key: 'bad' })).status, 401);
  const row = limitRow(env);
  assert.ok(row.locked_until > Date.now() + 14 * 60 * 1000 && row.locked_until <= Date.now() + 15 * 60 * 1000);
  const locked = await post(env, { action: 'root-reset', key: ROOT_KEY });
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).error, 'cooldown');
  assert.equal(locked.headers.get('Set-Cookie'), null);
  assert.equal(audits(env).length, 6, '429 也写一行审计');
  raw(env).prepare("UPDATE attempt_limit SET locked_until = ? WHERE realm = 'account' AND kind = 'rootkey' AND bucket = ?").run(Date.now() - 1, IP);
  assert.equal((await post(env, { action: 'root-reset', key: ROOT_KEY })).status, 200);
  assert.equal(limitRow(env), null, '成功清掉本 IP 计数');
  assert.ok(one(env, "SELECT count FROM attempt_limit WHERE bucket = '*'").count >= 5, '全局窗口不清');
});

test('限速按 X-Styrigx-Client-Address 分桶（IPv6 同一 /64 共用）；别的 IP 不受影响；锁屏的 rootkey 行不在这个库', async () => {
  const env = makeEnv();
  for (let i = 0; i < 5; i++) await post(env, { action: 'root-reset', key: 'bad' }, {}, { identity: { ip: '2001:db8:1:2::' + (i + 1) } });
  const r = await post(env, { action: 'root-reset', key: ROOT_KEY }, {}, { identity: { ip: '2001:db8:1:2::99' } });
  assert.equal(r.status, 429);
  const other = await post(env, { action: 'root-reset', key: ROOT_KEY }, {}, { identity: { ip: '198.51.100.1' } });
  assert.equal(other.status, 200);
  assert.deepEqual(all(env, "SELECT DISTINCT realm FROM attempt_limit").map((x) => x.realm), ['account']);
});

test('全局只减速不封锁：每小时真比对失败满 20 次后 checkRootLimit 给出 3 秒减速，不 limited', async () => {
  const { rootLimiter } = await import('../../../workers/account/src/lib/root-limit.js');
  const env = makeEnv();
  const lim = rootLimiter(root.ROOT_REALM);
  for (let i = 0; i < 20; i++) await lim.recordRootFail(env, '192.0.2.' + i);
  assert.deepEqual(await lim.checkRootLimit(env, '203.0.113.5'), { limited: false, delayMs: 3000 });
  assert.equal(one(env, "SELECT count FROM attempt_limit WHERE realm = 'account' AND bucket = '*'").count, 20);
});

test('配置：缺 SGX_ACCOUNT_ROOT_KEY → 500 config；缺账号票钥匙 → 503 config（先于比对，不计数、不写审计）', async () => {
  const e1 = makeEnv({ SGX_ACCOUNT_ROOT_KEY: '' });
  const r1 = await post(e1, { action: 'root-reset', key: ROOT_KEY });
  assert.equal(r1.status, 500);
  assert.equal((await r1.json()).error, 'config');
  const e2 = makeEnv({ SGX_ACCOUNT_PRIVATE: '' });
  const r2 = await post(e2, { action: 'root-reauth', key: ROOT_KEY }, { 'sgx-account-session': await accSession() });
  assert.equal(r2.status, 503);
  assert.equal((await r2.json()).error, 'config');
  for (const e of [e1, e2]) {
    assert.equal(audits(e).length, 0);
    assert.equal(one(e, 'SELECT COUNT(*) AS n FROM attempt_limit').n, 0);
  }
});

test('限速 D1 读出错 → 503 server（不比对）；失败计数写不进去 → 503 server（fail closed）', async () => {
  const env = makeEnv();
  const db = env.D1_ACCOUNT_AUTH;
  env.D1_ACCOUNT_AUTH = failing(db, (q) => /^SELECT .* FROM attempt_limit/.test(q));
  const r = await post(env, { action: 'root-reset', key: ROOT_KEY });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'server');
  assert.equal(r.headers.get('Set-Cookie'), null);
  env.D1_ACCOUNT_AUTH = failing(db, (q) => /^INSERT INTO attempt_limit/.test(q));
  const r2 = await post(env, { action: 'root-reset', key: 'bad' });
  assert.equal(r2.status, 503);
});

test('成功但审计写不进去 → 503 server，不签票（fail closed）', async () => {
  const env = makeEnv();
  env.D1_ACCOUNT_AUTH = failing(env.D1_ACCOUNT_AUTH, (q) => /^INSERT INTO audit/.test(q));
  const r = await post(env, { action: 'root-reset', key: ROOT_KEY });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'server');
  assert.equal(r.headers.get('Set-Cookie'), null);
});

test('身份：root-reauth / root-reset / audit-list 都要 admin（访客 / 无身份 401 session，不计数、不写审计）', async () => {
  const env = makeEnv();
  for (const action of ['root-reset', 'root-reauth', 'audit-list']) {
    for (const identity of [null, { role: 'visitor', by: 'tempkey' }]) {
      const r = await post(env, { action, key: ROOT_KEY }, { 'sgx-account-session': await accSession() }, { identity });
      assert.equal(r.status, 401);
      assert.equal((await r.json()).error, 'session');
    }
  }
  assert.equal(audits(env).length, 0);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM attempt_limit').n, 0);
});

test('audit-list：{ items:[{ ts, ipPrefix, ok, event }] }，新的在前、最多 50 条；只给这四项（decoy / via 不出接口）；不要账号会话', async () => {
  const env = makeEnv();
  const now = Date.now();
  const ins = raw(env).prepare('INSERT INTO audit (realm, id, ts, ip_prefix, ok, decoy, via, path, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 60; i++) ins.run('account', 'a' + i, now - 1000 * i, '1.2.3.x', i % 2, 1, 'switch', i % 3 ? 'root-reauth' : 'device-revoke', now + 3600000);
  const r = await post(env, { action: 'audit-list' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.items.length, 50);
  assert.deepEqual(j.items[0], { ts: now, ipPrefix: '1.2.3.x', ok: false, event: 'device-revoke' });
  assert.deepEqual(Object.keys(j.items[1]), ['ts', 'ipPrefix', 'ok', 'event']);
  assert.ok(j.items.every((x, i) => i === 0 || j.items[i - 1].ts >= x.ts));
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
});

test('audit-list：过期行不返回；别的 realm 的行不返回；D1 出错 → 503 server', async () => {
  const env = makeEnv();
  const now = Date.now();
  const ins = raw(env).prepare('INSERT INTO audit (realm, id, ts, ip_prefix, ok, decoy, via, path, expires_at) VALUES (?, ?, ?, ?, ?, 0, \'\', ?, ?)');
  ins.run('account', 'live', now, '1.1.1.x', 1, 'root-reset', now + 1000);
  ins.run('account', 'old', now - 8 * 86400000, '1.1.1.x', 1, 'root-reset', now - 1);
  ins.run('lock', 'lk', now, '1.1.1.x', 1, 'lock-reset', now + 1000);
  ins.run('root', 'rt', now, '1.1.1.x', 1, 'account-reset', now + 1000);
  const j = await (await post(env, { action: 'audit-list' })).json();
  assert.deepEqual(j.items.map((x) => x.event), ['root-reset']);
  env.D1_ACCOUNT_AUTH = failing(env.D1_ACCOUNT_AUTH, (q) => /FROM audit/.test(q));
  const r = await post(env, { action: 'audit-list' });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'server');
});

test('audit-list 合在一张表：根密钥使用（7 天）+ 安全事件（30 天）按时间倒序', async () => {
  const env = makeEnv();
  await post(env, { action: 'root-reset', key: 'bad' });
  await post(env, { action: 'root-reset', key: ROOT_KEY });
  await new Promise((r) => setTimeout(r, 2));
  await post(env, { action: 'device-revoke-all' }, await full());
  const j = await (await post(env, { action: 'audit-list' })).json();
  assert.deepEqual(j.items.map((x) => [x.event, x.ok]), [['device-revoke-all', true], ['root-reset', true], ['root-reset', false]]);
  const ttl = all(env, 'SELECT path, expires_at - ts AS ttl FROM audit ORDER BY ts DESC');
  assert.equal(ttl[0].ttl, 30 * 86400000);
  assert.equal(ttl[1].ttl, 7 * 86400000);
});

test('writeSecurityEvent：只认 SECURITY_EVENTS 里的事件名（7 个，方案 6.2）；D1 没绑 / 出错 → false，不抛', async () => {
  assert.deepEqual([...root.SECURITY_EVENTS], ['password-change', 'passkey-register', 'passkey-delete', 'passkey-rename', 'device-revoke', 'device-revoke-all', 'login-password-cooldown']);
  const env = makeEnv();
  assert.equal(await root.writeSecurityEvent(env, IP, 'root-reset'), false, 'root-* 只能经根密钥路径写');
  assert.equal(await root.writeSecurityEvent(env, IP, 'passkey-rename'), true);
  assert.equal(await root.writeSecurityEvent(makeEnv({ D1_ACCOUNT_AUTH: undefined }), IP, 'passkey-rename'), false);
  assert.equal(audits(env).length, 1);
});

test('根域：ROOT_REALM.rootKey = REALM_ACCOUNT.rootKey = SGX_ACCOUNT_ROOT_KEY，其余字段 = 账号库域；lib/root-check 读 realm.rootKey（方案 6.2）', async () => {
  assert.equal(root.ROOT_REALM.rootKey, 'SGX_ACCOUNT_ROOT_KEY');
  assert.equal('secret' in root.ROOT_REALM, false);
  assert.equal(realm.REALM_ACCOUNT.rootKey, 'SGX_ACCOUNT_ROOT_KEY');
  assert.equal(root.ROOT_REALM.id, 'account');
  assert.equal(root.ROOT_REALM.d1Binding, 'D1_ACCOUNT_AUTH');
  assert.ok(Array.isArray(root.ROOT_REALM.schema));
  assert.deepEqual(Object.keys(root.ROOT_ACTIONS), ['root-reauth', 'root-reset']);
  const shared = readFileSync(REPO + 'workers/account/src/lib/root-check.js', 'utf8');
  assert.match(shared, /env\[realm\.rootKey\]/);
  assert.doesNotMatch(shared, /realm\.secret/);
});
