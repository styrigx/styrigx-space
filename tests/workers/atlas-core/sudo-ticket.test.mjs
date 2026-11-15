// D-3 a′「先验后发票」（偏离稿 v3.12 第 9 节）：atlas-core 与 space-core 这一侧。
// - 带 X-Sgx-Sudo 的请求只按票判：经 SPACE.sudoAdmit 核销（每个请求只一次），对得上 → root（sudo），对不上 → 403（有会话）/ 401（没会话），
//   不退回会话本身的档
// - POST /curio/api/music：票绑 body 里的 op（先卡大小再解析）；别的 action 拿不到票的结论
// - 本 Worker、space-core 都不把票打进日志
// - space-core SpaceVerifier.sudoAdmit 原样转账号 Worker，只认 allowed + root + sudo + uid 0 + 同一个 action
// 运行：node --test tests/workers/atlas-core/sudo-ticket.test.mjs
import '../account/_cf-workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CA = await import(REPO + '/workers/atlas-core/src/curio/api/_auth.js');
const DA = await import(REPO + '/workers/atlas-core/src/daymark/api/_auth.js');
const IA = await import(REPO + '/workers/space-core/src/core/identity-admit.js');
const { SpaceVerifier } = await import(REPO + '/workers/space-core/src/rpc/space-verifier.js');

const TICKET = 'T'.repeat(40) + 'abc';
const COOKIE = 'sgx-session=' + 'A'.repeat(43);

/** 假 SPACE：记下调用，按 ok 回结论 */
function space(ok, o = {}) {
  const calls = [];
  return {
    calls,
    async admit() { calls.push(['admit']); return { allowed: true, uid: 1000, root: false, rescue: false, action: '' }; },
    async sudoAdmit(cookie, ticket, method, p, opts) {
      calls.push(['sudoAdmit', ticket, method, p, opts && opts.action ? opts.action : '']);
      if (o.throws) throw new Error('boom ' + ticket);
      return ok ? { allowed: true, uid: 0, root: true, sudo: true, sudoBy: 1000, action: opts && opts.action ? opts.action : '' } : { allowed: false, uid: 1000, root: false, sudo: false, action: '' };
    },
  };
}
function ctx(method, p, env, o = {}) {
  const headers = Object.assign({ Cookie: o.cookie === undefined ? COOKIE : o.cookie }, o.sudo === false ? {} : { 'X-Sgx-Sudo': o.ticket || TICKET });
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  return { request: new Request('https://styrigx.com' + p, { method, headers, body: o.body }), env, data: {} };
}

test('导出：票对得上 → root（sudo），整个请求只核销一次；不问会话本身的档', async () => {
  const S = space(true);
  const c = ctx('GET', '/curio/api/export', { SPACE: S });
  assert.equal((await CA.requireAccount(c)).response, null);
  const v = await CA.v6Of(c);
  assert.equal(v.root, true);
  assert.equal(v.sudo, true);
  assert.equal((await CA.v6Of(c, 'private')).allowed, true);
  assert.deepEqual(S.calls, [['sudoAdmit', TICKET, 'GET', '/curio/api/export', '']]);
  assert.equal(await CA.auditRootOp(c, 'export curio bookmarks'), false, '发票时已审计，不再走 auditRoot');
});

test('票对不上 → 403（有会话）/ 401（没会话）；不退回会话本身的档', async () => {
  const S = space(false);
  const c = ctx('POST', '/curio/api/import', { SPACE: S });
  assert.equal((await CA.requireScope(c)).response.status, 403);
  assert.ok(!S.calls.some((x) => x[0] === 'admit'), '带票的请求不问 admit');
  const n = ctx('POST', '/curio/api/import', { SPACE: space(true) }, { cookie: '' });
  assert.equal((await CA.requireScope(n)).response.status, 401);
  const bad = ctx('POST', '/curio/api/import', { SPACE: space(true) }, { ticket: 'short' });
  assert.equal((await CA.requireScope(bad)).response.status, 403, '票格式不对不转发');
});

test('音乐：票绑 body 里的 op（album.del）；别的 action 拿不到票的结论；超大 body 不解析', async () => {
  const S = space(true);
  const c = ctx('POST', '/curio/api/music', { SPACE: S }, { body: JSON.stringify({ op: 'album.del', id: 3 }) });
  assert.equal((await CA.requireMusic(c)), null);
  assert.equal((await CA.v6Of(c, 'album.del')).allowed, true);
  assert.equal((await CA.v6Of(c, 'album.add')).allowed, false);
  assert.deepEqual(S.calls, [['sudoAdmit', TICKET, 'POST', '/curio/api/music', 'album.del']]);
  assert.equal((await c.request.json()).op, 'album.del', '处理函数照样能读 body');
  const big = ctx('POST', '/curio/api/music', { SPACE: space(true) }, { body: JSON.stringify({ op: 'album.del', pad: 'x'.repeat(70000) }) });
  assert.equal((await CA.requireMusic(big)).status, 403);
});

test('日刻删专题：票不绑 action', async () => {
  const S = space(true);
  const c = ctx('DELETE', '/daymark/api/collections?id=2', { SPACE: S });
  assert.equal((await DA.requireScope(c)).response, null);
  assert.deepEqual(S.calls, [['sudoAdmit', TICKET, 'DELETE', '/daymark/api/collections', '']]);
});

test('出错时不把票打进日志（atlas-core）', async () => {
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  try {
    const c = ctx('GET', '/curio/api/export', { SPACE: space(true, { throws: true }) });
    assert.equal((await CA.requireAccount(c)).response.status, 403);
  } finally { console.error = orig; }
  assert.ok(logs.length > 0);
  assert.ok(logs.every((l) => !l.includes(TICKET)));
});

test('space-core：SpaceVerifier.sudoAdmit 原样转账号 Worker，只认 root + sudo + uid 0 + 同一个 action；出错不打票', async () => {
  const seen = [];
  const acct = (r, throws) => ({ async sudoAdmit(...a) { seen.push(a); if (throws) throw new Error('x ' + a[1]); return r; } });
  const sv = (A) => Object.assign(Object.create(SpaceVerifier.prototype), { env: { ACCOUNT_VERIFIER: A } });
  const good = { allowed: true, uid: 0, root: true, sudo: true, sudoBy: 1000, action: 'album.del' };
  const r = await sv(acct(good)).sudoAdmit(COOKIE, TICKET, 'post', '/curio/api/music', { action: 'album.del' });
  assert.deepEqual({ a: r.allowed, root: r.root, sudo: r.sudo, by: r.sudoBy }, { a: true, root: true, sudo: true, by: 1000 });
  assert.deepEqual(seen[0].slice(1), [TICKET, 'POST', '/curio/api/music', { action: 'album.del' }]);
  assert.equal((await sv(acct(Object.assign({}, good, { action: '' }))).sudoAdmit(COOKIE, TICKET, 'POST', '/curio/api/music', { action: 'album.del' })).allowed, false, 'action 对不上');
  assert.equal((await sv(acct(Object.assign({}, good, { uid: 1000 }))).sudoAdmit(COOKIE, TICKET, 'GET', '/curio/api/export')).allowed, false, '不是 uid 0');
  assert.equal((await sv(acct(good)).sudoAdmit('', TICKET, 'GET', '/curio/api/export')).allowed, false, '没会话不转');
  assert.equal(await IA.askSudoAdmit({ ACCOUNT_VERIFIER: acct(good) }, COOKIE, 'bad', 'GET', '/curio/api/export'), null, '票格式不对不转');
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  try { assert.equal((await sv(acct(good, true)).sudoAdmit(COOKIE, TICKET, 'GET', '/curio/api/export')).allowed, false); } finally { console.error = orig; }
  assert.ok(logs.every((l) => !l.includes(TICKET)));
});
