/**
 * 割接（v6 cutover）：网关这一侧——
 * - /api/share（root）：旧进站会话不成立、v6 新会话够 root → 新建 / 列表 / 作废都放行（不要锁侧复验），新建 / 作废经 auditRoot 留痕；
 *   styrigx（不是 root）/ 访客 401；旧会话照旧
 * - GET /api/space-audit（root）：v6 root 200；styrigx 401
 * - SpaceVerifier.admit / auditRoot：原样转给账号 Worker（判断不在网关），带 action；没 sgx-session 不问；出错 → allowed:false
 * - normalizeAdmit：要 uid、问了 action 要带回同一个 action
 * 放行判断用 ../_v6admit.mjs（真的 ROUTE_ACCESS + permits）。
 * 运行：node --test tests/workers/space-core/v6-cutover.test.mjs
 */
import '../account/_cf-workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareD1 } from '../../fixtures/share-d1.mjs';
import { makeAuthD1, genKeyPair } from '../_harness.mjs';
import { testLockSession, testTicket } from './_tickets.mjs';
import { admitFor, whoOf } from '../_v6admit.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const worker = (await import(REPO + 'workers/space-core/src/app.js')).default;
const IA = await import(REPO + 'workers/space-core/src/core/identity-admit.js');
const { SpaceVerifier } = await import(REPO + 'workers/space-core/src/rpc/space-verifier.js');
const { _resetMem } = await import(REPO + 'workers/space-core/src/core/share-open.js');
const SA = await import(REPO + 'workers/space-core/src/api/space-audit.js');

const LOCK = await genKeyPair();
const ctx = { waitUntil() {} };

function verifier(rec) {
  return {
    async authorize() { return { ok: false, reason: 'no-cookie', deviceId: '', scopes: [], reauth: false }; },
    async admit(...args) { const [c, m, p, opts] = args; rec.calls.push(args); if (rec.throws) throw new Error('down'); return admitFor(c, m, p, opts); },
    async auditRoot(c, cmd, ip) { const id = whoOf(c); const ok = !!id && id.uid === 0 && !id.rescue; rec.audits.push([cmd, ip, ok]); return ok; },
  };
}
function setup() {
  const authDb = makeAuthD1();
  const db = shareD1();
  const rec = { calls: [], audits: [], throws: false };
  _resetMem();
  const env = {
    D1_SPACE: { prepare: (sql) => (/\bshare_(link|fail)\b/.test(sql) ? db : authDb).prepare(sql), batch: (s) => authDb.batch(s) },
    SGX_SPACE_PRIVATE: LOCK.priv, SGX_SPACE_PUBLIC: LOCK.pub, SGX_SPACE_RECOVERY_KEY: 'r', SGX_SPACE_PASSWORD_PEPPER: 'p',
    SGX_ENV: 'production', SGX_SITE: 'space', ACCOUNT_VERIFIER: verifier(rec),
    ANON_LIMITER: { async limit() { return { success: true }; } },
  };
  return { env, rec, db };
}
async function share(env, body, cookie) {
  const headers = { 'Content-Type': 'application/json', Origin: 'https://styrigx.com', 'CF-Connecting-IP': '203.0.113.20' };
  if (cookie) headers.Cookie = cookie;
  const res = await worker.fetch(new Request('https://styrigx.com/api/share', { method: 'POST', headers, body: JSON.stringify(body) }), env, ctx);
  return { s: res.status, j: await res.json() };
}

test('/api/share（root）：v6 root 新建 / 列表 / 作废放行（不要锁侧复验），新建 / 作废留痕 share；styrigx、访客、救援 401', async () => {
  const { env, rec } = setup();
  const c = await share(env, { action: 'create', hours: 1 }, 'sgx-session=root');
  assert.equal(c.s, 200, JSON.stringify(c.j));
  const l = await share(env, { action: 'list' }, 'sgx-session=root');
  assert.equal(l.s, 200);
  assert.equal(l.j.links.length, 1);
  assert.equal((await share(env, { action: 'revoke', id: c.j.link.id }, 'sgx-session=root')).s, 200);
  assert.equal((await share(env, { action: 'revoke', all: true }, 'sgx-session=root')).s, 200);
  assert.deepEqual(rec.audits.map((a) => [a[0], a[1], a[2]]), [['share create', '203.0.113.20', true], ['share revoke', '203.0.113.20', true], ['share revoke --all', '203.0.113.20', true]]);
  for (const ck of ['sgx-session=styrigx', 'sgx-session=rescue', 'sgx-session=expired', '']) {
    assert.equal((await share(env, { action: 'list' }, ck || undefined)).s, 401, ck || '访客');
  }
  assert.ok(rec.calls.every((x) => x[1] === 'POST' && x[2] === '/api/share' && x.length === 3), '按路由档问（/api/share 各 action 都是 root）');
});

test('/api/share：旧会话照旧（进门 + 锁侧复验；有旧会话时不问 v6、不进身份审计）', async () => {
  const { env, rec } = setup();
  const lock = 'sgx-space-session=' + (await testLockSession(LOCK.priv, 0, 'password'));
  assert.equal((await share(env, { action: 'list' }, lock)).s, 401, '旧：列表要锁侧复验');
  const full = lock + '; sgx-space-reauth=' + (await testTicket(LOCK.priv, 'LockReauthTicket', 'password', 0));
  assert.equal((await share(env, { action: 'list' }, full)).s, 200);
  assert.equal((await share(env, { action: 'create', hours: 1 }, lock)).s, 200);
  assert.equal(rec.calls.length, 0);
  assert.equal(rec.audits.length, 0);
});

test('GET /api/space-audit（root）：v6 root 200；styrigx / 访客 401（旧会话判定原样）', async () => {
  const { env } = setup();
  const get = (cookie) => SA.onRequestGet({ request: new Request('https://styrigx.com/api/space-audit', { headers: cookie ? { Cookie: cookie } : {} }), env });
  const ok = await get('sgx-session=root');
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).items, []);
  assert.equal((await get('sgx-session=styrigx')).status, 401);
  assert.equal((await get('')).status, 401);
  /* 网关这一道门也认 v6 root（经 gate admit），到接口 200 */
  const res = await worker.fetch(new Request('https://styrigx.com/api/space-audit', { headers: { Cookie: 'sgx-session=root' } }), env, ctx);
  assert.equal(res.status, 200);
});

test('SpaceVerifier.admit / auditRoot：原样转给账号 Worker（带 action）；没 sgx-session 不问；出错 → allowed:false；回答只留白名单字段', async () => {
  const { env, rec } = setup();
  const v = new SpaceVerifier({}, env);
  let r = await v.admit('a=1; sgx-session=styrigx', 'post', '/curio/api/music', { action: 'album.del' });
  assert.deepEqual(r, { allowed: false, reason: 'need-root', uid: 1000, root: false, rescue: false, action: 'album.del' });
  assert.deepEqual(rec.calls.at(-1), ['a=1; sgx-session=styrigx', 'POST', '/curio/api/music', { action: 'album.del' }]);
  r = await v.admit('sgx-session=root', 'GET', '/curio/api/export');
  assert.equal(r.allowed, true); assert.equal(r.root, true); assert.equal(r.action, '');
  assert.equal(rec.calls.at(-1).length, 3, '不带 action 时不传第 4 个参数（旧版本账号 Worker 兼容）');
  const n = rec.calls.length;
  assert.equal((await v.admit('sgx-space-session=x', 'GET', '/curio/api/export')).allowed, false);
  assert.equal((await v.admit('sgx-session=root', 'GET', '/curio/api/export', { action: 'BAD ACTION' })).allowed, false);
  assert.equal(rec.calls.length, n, '没 sgx-session / action 写法不对：不问');
  rec.throws = true;
  assert.equal((await v.admit('sgx-session=root', 'GET', '/curio/api/export')).allowed, false);
  rec.throws = false;
  assert.equal(await v.auditRoot('sgx-session=root', 'rm-bulk daymark collection x', '1.2.3.4'), true);
  assert.equal(await v.auditRoot('sgx-session=root', 'useradd evil', '1.2.3.4'), false, '命令字不在白名单：网关先挡');
  assert.equal(await v.auditRoot('sgx-session=styrigx', 'rm-bulk x', '1.2.3.4'), false);
  assert.deepEqual(rec.audits.map((a) => a[0]), ['rm-bulk daymark collection x', 'rm-bulk x']);
});

test('normalizeAdmit：allowed 要有 uid；问了 action 要带回同一个 action（旧版本不认 action 不能当结论）；root 不含救援', () => {
  assert.equal(IA.normalizeAdmit({ allowed: true, uid: 0, root: true }).root, true);
  assert.equal(IA.normalizeAdmit({ allowed: true, uid: 0, root: true, rescue: true }).root, false);
  assert.equal(IA.normalizeAdmit({ allowed: true, uid: null }).allowed, false);
  assert.equal(IA.normalizeAdmit({ allowed: true, uid: 1000 }, 'private').allowed, false);
  assert.equal(IA.normalizeAdmit({ allowed: true, uid: 1000, action: 'private' }, 'private').allowed, true);
  assert.equal(IA.normalizeAdmit({ allowed: true, uid: 1000, action: 'x' }).allowed, false, '没问 action 却回了 action');
  assert.equal(IA.normalizeAdmit(null).signedIn, false);
  assert.equal(IA.normalizeAdmit({ allowed: false, uid: 1001 }).signedIn, true);
});
