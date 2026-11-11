/**
 * 割接（v6 cutover）：网关这一侧（v6 P4 起 /api/share 随分享短链删除，旧进站会话删除，对应用例一并删除）——
 * - GET /api/space-audit（root）：v6 root 200；styrigx 403 forbidden（2b）
 * - SpaceVerifier.admit / auditRoot：原样转给账号 Worker（判断不在网关），带 action；没 sgx-session 不问；出错 → allowed:false
 * - normalizeAdmit：要 uid、问了 action 要带回同一个 action
 * 放行判断用 ../_v6admit.mjs（真的 ROUTE_ACCESS + permits）。
 * 运行：node --test tests/workers/space-core/v6-cutover.test.mjs
 */
import '../account/_cf-workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAuthD1 } from '../_harness.mjs';
import { admitFor, whoOf } from '../_v6admit.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const worker = (await import(REPO + 'workers/space-core/src/app.js')).default;
const IA = await import(REPO + 'workers/space-core/src/core/identity-admit.js');
const { SpaceVerifier } = await import(REPO + 'workers/space-core/src/rpc/space-verifier.js');
const SA = await import(REPO + 'workers/space-core/src/api/space-audit.js');

const ctx = { waitUntil() {} };

function verifier(rec) {
  return {
    async admit(...args) { const [c, m, p, opts] = args; rec.calls.push(args); if (rec.throws) throw new Error('down'); return admitFor(c, m, p, opts); },
    async auditRoot(c, cmd, ip) { const id = whoOf(c); const ok = !!id && id.uid === 0 && !id.rescue; rec.audits.push([cmd, ip, ok]); return ok; },
  };
}
function setup() {
  const rec = { calls: [], audits: [], throws: false };
  const env = { D1_SPACE: makeAuthD1(), SGX_ENV: 'production', SGX_SITE: 'space', ACCOUNT_VERIFIER: verifier(rec) };
  return { env, rec };
}
test('v6 P4：/api/share 随分享短链删除——不在网关路由表，root 打过来也 404，不进身份审计', async () => {
  const { env, rec } = setup();
  const res = await worker.fetch(new Request('https://styrigx.com/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://styrigx.com', Cookie: 'sgx-session=root' }, body: '{"action":"list"}' }), env, ctx);
  assert.ok(res.status === 404 || res.status === 403 || res.status === 401, String(res.status));
  assert.equal(rec.audits.length, 0);
});

test('GET /api/space-audit（root）：v6 root 200；styrigx 403 forbidden（2b）；访客 401', async () => {
  const { env } = setup();
  const get = (cookie) => SA.onRequestGet({ request: new Request('https://styrigx.com/api/space-audit', { headers: cookie ? { Cookie: cookie } : {} }), env });
  const ok = await get('sgx-session=root');
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).items, []);
  assert.equal((await get('sgx-session=styrigx')).status, 403);
  /* 网关这一道门：styrigx 同样 403（不到接口） */
  const gs = await worker.fetch(new Request('https://styrigx.com/api/space-audit', { headers: { Cookie: 'sgx-session=styrigx' } }), env, ctx);
  assert.equal(gs.status, 403);
  assert.equal((await gs.json()).error, 'forbidden');
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
