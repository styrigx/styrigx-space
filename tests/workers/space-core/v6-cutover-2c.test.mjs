/**
 * 2c（v6 割接后续）：AI 回答的私密范围按 v6 身份——网关这一侧（workers/space-core/src/api/ai.js aiConclusionHeaders）。
 * - 先问账号 Worker POST /api/ai 的 action private（ROUTE_ACCESS = webmaster，经 permits()）：styrigx（站长）/ root → 只写 X-Styrigx-Account-Session: 1
 * - v6 不够（bob：ai 组但不是站长）/ 没有 v6 会话 → 不写 = 只给公开内容（v6 P4 起旧账号会话回退删除，定稿 v5.2 §十三）
 * - GET /api/ai（模型列表的 canChoose）问同一条，与 POST 一致
 * - 浏览器伪造的结论头不会带过去
 * 放行判断用 ../_v6admit.mjs（真的 ROUTE_ACCESS + permits）。
 * 运行：node --test tests/workers/space-core/v6-cutover-2c.test.mjs
 */
import '../account/_cf-workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitFor } from '../_v6admit.mjs';
import { withAuthD1 } from '../_harness.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const AI = await import(REPO + 'workers/space-core/src/api/ai.js');
const IA = await import(REPO + 'workers/space-core/src/core/identity-admit.js');
const RA = await import(REPO + 'workers/account/src/core/route-access.js');

const SESSION = 'X-Styrigx-Account-Session';
/** @param {{ throws?: boolean }} [o] */
function setup(o = {}) {
  const rec = { admits: [], sent: [] };
  const env = withAuthD1({
    ACCOUNT_VERIFIER: {
      async admit(c, m, p, opts) { rec.admits.push([m, p, opts && opts.action]); if (o.throws) throw new Error('down'); return admitFor(c, m, p, opts); },
    },
    AI_SERVICE: {
      async fetch(req) {
        const h = {};
        req.headers.forEach((v, k) => { if (k.startsWith('x-styrigx-')) h[k] = v; });
        rec.sent.push({ path: new URL(req.url).pathname, h });
        if (new URL(req.url).pathname === '/models') return new Response(JSON.stringify({ ok: true, models: [], canChoose: req.headers.get(SESSION) === '1' }), { headers: { 'Content-Type': 'application/json' } });
        return new Response('data: {}\n\n', { headers: { 'Content-Type': 'text/event-stream', 'X-Styrigx-AI-Scope': req.headers.get(SESSION) === '1' ? 'private' : 'public' } });
      },
    },
  });
  return { env, rec };
}

test('AI_PRIVATE：就是账号路由表里 POST /api/ai 的 action private（= webmaster），不是救援可用', () => {
  assert.deepEqual({ ...IA.AI_PRIVATE }, { method: 'POST', path: '/api/ai', action: 'private' });
  assert.equal(RA.levelOf('POST', '/api/ai', { action: 'private' }), 'webmaster');
  assert.equal(RA.levelOf('POST', '/api/ai'), 'ai', '进接口本身仍是 ai 组');
  assert.equal(RA.rescueOf('POST', '/api/ai', { action: 'private' }), false);
});

test('aiConclusionHeaders：v6 styrigx / root → 只写 Session: 1；bob（ai 组非站长）、alice、临时用户、救援、过期 → 不写', async () => {
  for (const who of ['styrigx', 'root']) {
    const { env, rec } = setup();
    const req = new Request('https://styrigx.com/api/ai', { method: 'POST', headers: { Cookie: 'sgx-session=' + who } });
    const h = await AI.aiConclusionHeaders(req, env, new Headers());
    assert.equal(h.get(SESSION), '1', who);
    assert.equal(h.get('X-Styrigx-Account-Device'), null, who + '：v6 不写旧设备头');
    assert.deepEqual(rec.admits, [['POST', '/api/ai', 'private']], who);
  }
  for (const who of ['bob', 'alice', 'temp', 'rescue', 'expired']) {
    const { env, rec } = setup();
    const req = new Request('https://styrigx.com/api/ai', { method: 'POST', headers: { Cookie: 'sgx-session=' + who } });
    const h = await AI.aiConclusionHeaders(req, env, new Headers());
    assert.equal(h.get(SESSION), null, who);
    assert.deepEqual(rec.admits, [['POST', '/api/ai', 'private']], who);
  }
});

test('aiConclusionHeaders（v6 P4）：旧账号会话 cookie 不再给私密；没 sgx-session 不问 v6；访客只给公开', async () => {
  let { env, rec } = setup();
  let h = await AI.aiConclusionHeaders(new Request('https://styrigx.com/api/ai', { method: 'POST', headers: { Cookie: 'sgx-account-session=ok' } }), env, new Headers());
  assert.equal(h.get(SESSION), null, '旧账号会话删除');
  assert.equal(h.get('X-Styrigx-Account-Device'), null);
  assert.equal(rec.admits.length, 0, '没 sgx-session 不问 v6');
  ({ env, rec } = setup());
  h = await AI.aiConclusionHeaders(new Request('https://styrigx.com/api/ai', { method: 'POST' }), env, new Headers());
  assert.equal(h.get(SESSION), null, '访客只给公开');
});

test('aiConclusionHeaders：v6 RPC 出错 → 不算（fail closed）；伪造的结论头被剥掉', async () => {
  const { env } = setup({ throws: true });
  const h = await AI.aiConclusionHeaders(new Request('https://styrigx.com/api/ai', { method: 'POST', headers: { Cookie: 'sgx-session=styrigx' } }), env, new Headers({ [SESSION]: '1', 'X-Styrigx-Account-Scopes': 'x.y' }));
  assert.equal(h.get(SESSION), null);
  assert.equal(h.get('X-Styrigx-Account-Scopes'), null);
});

test('POST /api/ai：纯 v6 styrigx → 转给 styrigx-ai 带 Session: 1（scope private）；bob → 不带（scope public）', async () => {
  for (const [who, scope] of [['styrigx', 'private'], ['root', 'private'], ['bob', 'public']]) {
    const { env, rec } = setup();
    const req = new Request('https://styrigx.com/api/ai', {
      method: 'POST', headers: { Cookie: 'sgx-session=' + who, Origin: 'https://styrigx.com', 'Content-Type': 'application/json' }, body: '{"q":"hi"}',
    });
    const res = await AI.onRequestPost({ request: req, env, data: { v6: IA.normalizeAdmit(admitFor('sgx-session=' + who, 'POST', '/api/ai')) } });
    assert.equal(res.status, 200, who);
    assert.equal(res.headers.get('X-Styrigx-AI-Scope'), scope, who);
    assert.equal(rec.sent[0].path, '/ask');
    assert.equal(rec.sent[0].h['x-styrigx-account-session'], scope === 'private' ? '1' : undefined, who);
  }
});

test('GET /api/ai：canChoose 跟同一个结论（问 POST /api/ai 的 private）——styrigx true、bob false', async () => {
  for (const [who, can] of [['styrigx', true], ['bob', false]]) {
    const { env, rec } = setup();
    const req = new Request('https://styrigx.com/api/ai', { headers: { Cookie: 'sgx-session=' + who } });
    const res = await AI.onRequestGet({ request: req, env, data: { v6: IA.normalizeAdmit(admitFor('sgx-session=' + who, 'GET', '/api/ai')) } });
    assert.equal(res.status, 200, who);
    assert.equal((await res.json()).canChoose, can, who);
    assert.deepEqual(rec.admits, [['POST', '/api/ai', 'private']], who + '：只问 private 这一次（路由档用关口的结论）');
  }
});
