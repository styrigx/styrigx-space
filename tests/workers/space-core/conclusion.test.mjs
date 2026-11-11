/**
 * 网关结论头（workers/space-core/src/core/conclusion.js；方案 2.3、4.3，P2-1）。v6 P4（定稿 v5.2 §十三）起进站会话与旧账号会话删除；
 * 旧 RPC 结论 conclusionFor / SpaceVerifier.conclusion() 随应用授权删除（定稿 v5.3 §十二）：
 * - 结论头只剩 X-Styrigx-Account-Session（writeV6PrivateConclusion 先剥再写 1；stripAccountConclusion 只剥 x-styrigx-account-*）
 * - 浏览器带来的 X-Styrigx-Account-* 在网关第一步被剥掉，不会转到账号 Worker
 * - 规则 16：网关源码里没有账号票名
 *
 * 运行：node --test tests/workers/space-core/conclusion.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authD1For, makeKV } from '../_harness.mjs';

const GW = '../../../workers/space-core/src/';
const mod = await import(GW + 'core/conclusion.js');
const { ACCOUNT_CONCLUSION_HEADERS, ACCOUNT_CONCLUSION_PREFIX, stripAccountConclusion, writeV6PrivateConclusion } = mod;
const layers = await import('../../../space/scripts/check-layers.mjs');

test('导出：结论头常量、前缀、stripAccountConclusion / writeV6PrivateConclusion（v6 P4 起旧账号结论的白名单函数删除，conclusionFor 随应用授权删除）', () => {
  assert.deepEqual(Object.keys(mod).sort(), [
    'ACCOUNT_CONCLUSION_HEADERS', 'ACCOUNT_CONCLUSION_PREFIX', 'stripAccountConclusion', 'writeV6PrivateConclusion',
  ]);
});

test('结论头名逐字固定，冻结，以 x-styrigx-account- 开头（app.js 第一步的剥头也覆盖它）', () => {
  assert.deepEqual({ ...ACCOUNT_CONCLUSION_HEADERS }, { session: 'X-Styrigx-Account-Session' });
  assert.ok(Object.isFrozen(ACCOUNT_CONCLUSION_HEADERS));
  assert.equal(ACCOUNT_CONCLUSION_PREFIX, 'x-styrigx-account-');
});

test('writeV6PrivateConclusion：先剥掉已有的 x-styrigx-account-*，只写 Session: 1', () => {
  const h = writeV6PrivateConclusion(new Headers({ 'X-Styrigx-Account-Scopes': 'curio.write', 'X-Styrigx-Account-Device': 'd', 'Content-Type': 'application/json' }));
  assert.deepEqual([...h.keys()].sort(), ['content-type', 'x-styrigx-account-session']);
  assert.equal(h.get('X-Styrigx-Account-Session'), '1');
});

test('stripAccountConclusion：只剥 x-styrigx-account-*，别的 x-styrigx-* 和普通头不动；null 原样', () => {
  const h = stripAccountConclusion(new Headers({ 'X-Styrigx-Account-Session': '1', 'x-styrigx-account-device': 'd', 'X-Styrigx-Space-Level': 'password', Cookie: 'a=1' }));
  assert.deepEqual([...h.keys()].sort(), ['cookie', 'x-styrigx-space-level']);
  assert.equal(stripAccountConclusion(null), null);
});

test('浏览器带来的 X-Styrigx-Account-*：网关第一步就剥掉，转到账号 Worker 的请求里一个都没有', async () => {
  const worker = (await import(GW + 'app.js')).default;
  const seen = [];
  const ACCOUNT = { async fetch(req) { seen.push(Object.fromEntries([...req.headers])); return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }); } };
  const e = { SGX_ENV: 'production', SGX_SITE: 'space', D1_SPACE: authD1For(makeKV()), ACCOUNT };
  const forged = {
    'X-Styrigx-Account-Session': '1',
    'X-Styrigx-Account-Device': 'forgeddevice01',
    'X-Styrigx-Account-Scopes': 'curio.write daymark.write',
    'x-styrigx-account-reauth': '1',
  };
  const res = await worker.fetch(new Request('https://styrigx.com/api/profile', { headers: forged }), e, { waitUntil() {} });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  for (const k of Object.keys(seen[0])) assert.ok(!k.startsWith('x-styrigx-account-'), k);
});

test('规则 16：结论相关的网关源码没有账号鉴权标识', () => {
  for (const f of ['core/conclusion.js', 'rpc/space-verifier.js']) {
    const src = readFileSync(new URL(GW + f, import.meta.url), 'utf8');
    assert.deepEqual(layers.checkGatewayAccountAuth('workers/space-core/src/' + f, src), [], f);
  }
});
