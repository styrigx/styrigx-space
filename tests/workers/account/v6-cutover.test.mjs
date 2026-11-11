/**
 * 割接（v6 cutover）：账号 Worker 这一侧——
 * - POST /api/account/proxy 认 v6 新会话（root 档）：su root 放行、不要旧 reauth 票；styrigx / 访客被拒；
 *   sudo 借来的 root 也放行（sudo 自动生效），审计记真正执行的人 + via sudo
 * - AccountVerifier.admit 带 action（子站接口 Worker 经网关转来）：按那个 action 的档判、回答带回 action；路由没列这个 action → 拒（不退回路由档）
 * - 公开读接口的 action private = 本站写组
 * - AccountVerifier.auditRoot：只认真 root 层（救援不算），只收 rm-bulk / import / export / share
 * 运行：node --test tests/workers/account/v6-cutover.test.mjs
 */
import './_cf-workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAccountD1 } from './_d1.mjs';
import { routeAccess as RA } from './_identity.mjs';

const SRC = new URL('../../../workers/account/src/', import.meta.url).pathname;
const { serviceFetch } = await import(SRC + 'rpc/account-service.js');
const { checkAdmit, checkAuditRoot, REMOTE_AUDIT_COMMANDS } = await import(SRC + 'rpc/account-verifier.js');
const { _resetSecretCache } = await import(SRC + 'secrets.js');
const { makePasswordRecord } = await import(SRC + 'core/password.js');
const stack = await import(SRC + 'core/identity-stack.js');

const ORIGIN = 'https://styrigx.com';
const PEP = 'pepper-account-test';
const PW = { root: 'root-pass-01', styrigx: 'sty-pass-01', alice: 'alice-pass-01' };

function fakeProxy() {
  const calls = [];
  const rec = (name, ret) => async (...args) => { calls.push([name, ...args]); return ret; };
  return { calls, status: rec('status', { ok: true, sources: [] }), showToken: rec('showToken', { ok: true, token: 'S'.repeat(43) }), rotateToken: rec('rotateToken', { ok: true }),
    setKey: rec('setKey', { ok: true }), addAirport: rec('addAirport', { ok: true }), upload: rec('upload', { ok: true }), setEnabled: rec('setEnabled', { ok: true }),
    remove: rec('remove', { ok: true }), rename: rec('rename', { ok: true }) };
}

async function setup() {
  _resetSecretCache();
  const env = { SGX_ENV: 'production', SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: ORIGIN, SGX_ACCOUNT_PASSWORD_PEPPER: PEP,
    D1_ACCOUNT: makeAccountD1(), PROXY: fakeProxy() };
  const raw = env.D1_ACCOUNT.raw;
  const addUser = async (uid, name, groups) => {
    raw.prepare("INSERT INTO account_users (uid, name, avatar, expires_at, epoch, disabled, created_at) VALUES (?, ?, '', 0, 0, 0, 1)").run(uid, name);
    for (const g of groups) raw.prepare('INSERT INTO account_user_groups (uid, grp, added_at) VALUES (?, ?, 1)').run(uid, g);
    raw.prepare("INSERT INTO account_user_password (uid, record, pepper_id, must_change, expires_at) VALUES (?, ?, 'account', 0, 0)").run(uid, JSON.stringify(await makePasswordRecord(PW[name], PEP)));
  };
  await addUser(0, 'root', []);
  await addUser(1000, 'styrigx', ['wheel', 'sudoers', 'listen', 'ai', 'status', 'curio-write', 'daymark-write']);
  await addUser(1001, 'alice', ['listen', 'sudoers']);
  return env;
}
let ipN = 0;
async function call(env, method, path, o = {}) {
  const headers = { Origin: ORIGIN, 'CF-Connecting-IP': o.ip || '198.51.100.' + (++ipN % 250) };
  if (o.cookie) headers.Cookie = 'sgx-session=' + o.cookie;
  const init = { method, headers };
  if (o.body !== undefined) { init.body = JSON.stringify(o.body); headers['Content-Type'] = 'application/json'; }
  const res = await serviceFetch(new Request(ORIGIN + path, init), env, { waitUntil() {} });
  let json = null;
  try { json = JSON.parse(await res.clone().text()); } catch (e) {}
  return { status: res.status, json, cookies: res.headers.getSetCookie() };
}
const tokenOf = (r) => { const c = r.cookies.find((x) => x.startsWith('sgx-session=')); return c ? c.split(';')[0].slice('sgx-session='.length) : ''; };
const id = (env, body, cookie) => call(env, 'POST', '/api/identity', { body, cookie });
async function login(env, user) {
  const r = await id(env, { action: 'su', user, password: PW[user] });
  assert.equal(r.status, 200, 'su ' + user + ' ' + JSON.stringify(r.json));
  return tokenOf(r);
}
async function rootToken(env) {
  const t = await login(env, 'styrigx');
  const r = await id(env, { action: 'su', user: 'root', password: PW.root }, t);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return t;
}
const rows = (env, sql, ...p) => env.D1_ACCOUNT.raw.prepare(sql).all(...p).map((r) => ({ ...r }));

test('proxy（root 档）：su root 后 status / show / rm 直接到 ProxyAdmin（不要 reauth 票），除 status 外审计 sub <action> [源名]（不记令牌 / 链接）；styrigx 401', async () => {
  const env = await setup();
  const sty = await login(env, 'styrigx');
  assert.equal((await call(env, 'POST', '/api/account/proxy', { cookie: sty, body: { action: 'status' } })).status, 401);
  assert.equal(env.PROXY.calls.length, 0);
  const rt = await rootToken(env);
  assert.equal((await call(env, 'POST', '/api/account/proxy', { cookie: rt, body: { action: 'status' } })).status, 200);
  const show = await call(env, 'POST', '/api/account/proxy', { cookie: rt, body: { action: 'show' } });
  assert.equal(show.status, 200);
  assert.equal(show.json.base, 'https://proxy-rules.styrigx.com/s/');
  assert.equal((await call(env, 'POST', '/api/account/proxy', { cookie: rt, body: { action: 'add', name: 'jc', url: 'https://sub.example.com/x?token=SECRET' } })).status, 200);
  assert.equal((await call(env, 'POST', '/api/account/proxy', { cookie: rt, body: { action: 'rm', name: 'jc' } })).status, 200);
  assert.deepEqual(env.PROXY.calls.map((c) => c[0]), ['status', 'showToken', 'addAirport', 'remove']);
  const au = rows(env, "SELECT uid, command FROM account_user_audit WHERE command LIKE 'sub %' ORDER BY ts").map((a) => a.command);
  assert.deepEqual(au, ['sub show', 'sub add jc', 'sub rm jc']);
  for (const c of au) assert.ok(!c.includes('SECRET') && !c.includes('S'.repeat(10)));
});

test('sudo 借 root 执行 proxy（割接后 sudo 自动生效）：每次验自己的凭据；审计记真正执行的人 + via sudo', async () => {
  const env = await setup();
  const at = await login(env, 'alice');
  assert.equal((await call(env, 'POST', '/api/account/proxy', { cookie: at, body: { action: 'status' } })).status, 401, 'alice 直接调被拒');
  const p = await id(env, { action: 'sudo', password: PW.alice, command: { method: 'POST', path: '/api/account/proxy', body: { action: 'on', name: 'jc' } } }, at);
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const au = rows(env, "SELECT uid, command FROM account_user_audit WHERE command LIKE 'sub %' ORDER BY ts");
  assert.deepEqual(au.map((a) => [a.uid, a.command]), [[1001, 'sub on jc via sudo']]);
});

test('AccountVerifier.admit 带 action：按 action 的档、回答带回 action；路由没列这个 action / 写法不对 → 拒（不退回路由档）；不带 action 时 action 为空', async () => {
  const env = await setup();
  const sty = 'sgx-session=' + (await login(env, 'styrigx'));
  const ali = 'sgx-session=' + (await login(env, 'alice'));
  const rt = 'sgx-session=' + (await rootToken(env));
  const a = (ck, m, p, act) => checkAdmit(env, ck, m, p, act === undefined ? undefined : { action: act });
  /* album.del = root */
  let r = await a(sty, 'POST', '/curio/api/music', 'album.del');
  assert.equal(r.allowed, false); assert.equal(r.reason, 'need-root'); assert.equal(r.action, 'album.del'); assert.equal(r.uid, 1000);
  r = await a(rt, 'POST', '/curio/api/music', 'album.del');
  assert.equal(r.allowed, true); assert.equal(r.root, true); assert.equal(r.action, 'album.del');
  assert.equal((await a(sty, 'POST', '/curio/api/music', 'album.add')).allowed, true);
  assert.equal((await a(ali, 'POST', '/curio/api/music', 'album.add')).allowed, false);
  /* 私密行：action private = 写组 */
  assert.equal((await a(sty, 'GET', '/curio/api/items', 'private')).allowed, true);
  assert.equal((await a(ali, 'GET', '/curio/api/items', 'private')).allowed, false);
  assert.equal((await a('', 'GET', '/curio/api/items', 'private')).allowed, false, '访客');
  assert.equal((await a(sty, 'GET', '/daymark/api/quotes', 'private')).allowed, true);
  assert.equal((await a(rt, 'GET', '/daymark/api/quotes', 'private')).allowed, true);
  /* 没列的 action 不退回路由档（GET /api/status 没有 actions；GET items 没有 x） */
  r = await a(sty, 'GET', '/api/status', 'private');
  assert.equal(r.allowed, false); assert.equal(r.reason, 'action');
  assert.equal((await a(sty, 'GET', '/curio/api/items', 'x')).reason, 'action');
  assert.equal((await a(sty, 'GET', '/curio/api/items', 'BAD ACTION')).reason, 'action');
  /* 路由档（网关 / 子站守卫的问法） */
  r = await a(sty, 'POST', '/curio/api/links');
  assert.equal(r.allowed, true); assert.equal(r.action, '');
  assert.equal((await a(sty, 'GET', '/curio/api/export')).allowed, false, '导出 = root');
  assert.equal((await a(rt, 'GET', '/curio/api/export')).allowed, true);
  assert.equal((await a(sty, 'DELETE', '/daymark/api/collections')).allowed, false, '删整个专题 = root');
  assert.equal((await a(sty, 'DELETE', '/daymark/api/quotes')).allowed, true, '删一句 = 写组');
  assert.equal((await a(rt, 'POST', '/api/share')).reason, 'not-listed', '分享短链 v6 P4 删除：表里没有这条');
  assert.equal((await a(sty, 'GET', '/api/space-audit')).allowed, false);
  assert.equal((await a(rt, 'GET', '/api/space-audit')).allowed, true);
  assert.equal((await a(ali, 'POST', '/curio/api/music-play')).allowed, true, 'listen');
  assert.equal(r.sessionId, undefined, '会话行 id 不出账号 Worker');
});

test('路由表：action private 挂在奇趣 / 日刻公开 GET 上（档 = 本站写组）和 POST /api/ai 上（2c：= owner）', () => {
  const withPrivate = RA.ROUTE_ACCESS.filter((r) => r.actions && Object.prototype.hasOwnProperty.call(r.actions, 'private'));
  assert.deepEqual(withPrivate.map((r) => r.method + ' ' + r.path).sort(), [
    'GET /curio/api/icon', 'GET /curio/api/items', 'GET /curio/api/links', 'GET /curio/api/movies', 'GET /curio/api/music', 'GET /curio/api/photo',
    'GET /daymark/api/collections', 'GET /daymark/api/quotes', 'POST /api/ai',
  ]);
  for (const r of withPrivate) {
    assert.deepEqual(Object.keys(r.actions), ['private'], r.path);
    if (r.path === '/api/ai') {
      /* AI 私密召回跨站（奇趣 / 日刻 / 博客），对应旧「账号会话」= 站长本人：owner；进接口本身仍是 ai 组 */
      assert.equal(r.level, 'ai');
      assert.equal(r.actions.private, 'owner');
      assert.equal(RA.rescueOf('POST', '/api/ai', { action: 'private' }), false, '救援不可用');
      continue;
    }
    assert.equal(r.level, 'public', r.path);
    assert.equal(r.actions.private, r.worker === 'curio-core' ? 'curio-write' : 'daymark-write', r.path);
  }
});

test('2c：POST /api/ai 的 action private 经 admit + permits 判——styrigx（站长）、root 放行；alice、临时用户、救援、访客拒；回答带回 action', async () => {
  const env = await setup();
  const sty = 'sgx-session=' + (await login(env, 'styrigx'));
  const ali = 'sgx-session=' + (await login(env, 'alice'));
  const rt = 'sgx-session=' + (await rootToken(env));
  const a = (ck) => checkAdmit(env, ck, 'POST', '/api/ai', { action: 'private' });
  let r = await a(sty);
  assert.equal(r.allowed, true); assert.equal(r.action, 'private'); assert.equal(r.uid, 1000);
  r = await a(rt);
  assert.equal(r.allowed, true); assert.equal(r.root, true);
  r = await a(ali);
  assert.equal(r.allowed, false); assert.equal(r.reason, 'need-owner'); assert.equal(r.action, 'private');
  assert.equal((await a('')).allowed, false, '访客');
  /* GET /api/ai 没列 action：不退回路由档 */
  assert.equal((await checkAdmit(env, sty, 'GET', '/api/ai', { action: 'private' })).reason, 'action');
});

test('AccountVerifier.auditRoot：真 root 层才写；救援 / styrigx / 访客不写；命令字只收 rm-bulk / import / export / share', async () => {
  const env = await setup();
  const rt = 'sgx-session=' + (await rootToken(env));
  const sty = 'sgx-session=' + (await login(env, 'styrigx'));
  assert.deepEqual([...REMOTE_AUDIT_COMMANDS], ['rm-bulk', 'import', 'export']);
  assert.equal(await checkAuditRoot(env, rt, 'rm-bulk daymark collection abc', '203.0.113.77'), true);
  assert.equal(await checkAuditRoot(env, rt, 'useradd x', '203.0.113.77'), false, '身份命令只在本 Worker 记');
  assert.equal(await checkAuditRoot(env, sty, 'rm-bulk x', '1.2.3.4'), false);
  assert.equal(await checkAuditRoot(env, '', 'rm-bulk x', '1.2.3.4'), false);
  const s = await stack.issueRescueSession(env, { epoch: rows(env, 'SELECT epoch FROM account_users WHERE uid = 0')[0].epoch });
  assert.equal(await checkAuditRoot(env, 'sgx-session=' + s.token, 'rm-bulk x', '1.2.3.4'), false, '救援不算');
  const au = rows(env, "SELECT uid, command, ip_prefix FROM account_user_audit WHERE command LIKE 'rm-bulk%'");
  assert.deepEqual(au, [{ uid: 0, command: 'rm-bulk daymark collection abc', ip_prefix: '203.0.113.x' }]);
});
