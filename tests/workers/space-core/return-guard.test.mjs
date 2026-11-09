/**
 * ?return= 回跳校验（src/core/return.js safeReturn，首页 302 与 /api/lock-session-check 共用）：
 * 控制字符（Tab/CR/LF…）、反斜杠、协议相对、编码绕过（%09 / %0a / %0d / %5c / %2F / 双重编码）一律回首页，
 * 绝不离开本站；合法站内路径和 *.styrigx.com 白名单照常。
 * 运行：node --test tests/workers/space-core/return-guard.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as mw } from '../../../workers/space-core/src/gate.js';
import { safeReturn, resolveReturn } from '../../../workers/space-core/src/core/return.js';
import { onRequestGet as sessionCheck } from '../../../workers/space-core/src/api/lock-session-check.js';
import { testLockSession } from './_tickets.mjs';
import { genKeyPair, authD1For } from '../_harness.mjs';

const { priv: PRIV, pub: PUB } = await genKeyPair();
const KV = { async get() { return null; }, async put() {}, async delete() {} };
const ENV = { SGX_ENV: 'production', SGX_SITE: 'space', SGX_SPACE_PUBLIC: PUB, KV_LOCK_DOOR: KV, D1_SPACE: authD1For(KV) , D1_SPACE: authD1For(KV)};
const cookie = 'sgx-space-session=' + (await testLockSession(PRIV, 0, 'password'));

/* 原样拼在查询串里的 return 值（浏览器地址栏 / 攻击链接里的写法） */
const EVIL_RAW = [
  '/%09/evil.com', '/%09%09/evil.com', '%09//evil.com', '/%0a/evil.com', '/%0d/evil.com', '/%0d%0a/evil.com',
  '/%5c/evil.com', '/%5C%5Cevil.com', '%2F%2Fevil.com', '/%2F/evil.com', '/%252F/evil.com', '/%255c/evil.com',
  '/%2509/evil.com', '//evil.com', '/\\evil.com', '\\\\evil.com', '/%00/evil.com', '/%7f/evil.com',
  '/%1f/evil.com', 'https://evil.com/', 'https:/evil.com', 'http://styrigx.com/',
  'https://styrigx.com%09.evil.com/', 'https://styrigx.com:8443/', 'javascript:alert(1)', '/%',
];

/** 浏览器拿到 Location 后会怎么解析：必须仍在本站（或白名单子站） */
function landsOnSite(loc) {
  const u = new URL(loc.replace(/[\t\n\r]/g, ''), 'https://styrigx.com/');
  return u.hostname === 'styrigx.com' || u.hostname.endsWith('.styrigx.com');
}

test('safeReturn：复现用例全部判为不合法（null）', () => {
  for (const raw of EVIL_RAW) {
    const ret = new URLSearchParams('return=' + raw).get('return');
    assert.equal(safeReturn(ret), null, raw);
  }
});

test('safeReturn：合法站内路径与白名单子站照常，返回规范化值', () => {
  assert.equal(safeReturn('/display/'), '/display/');
  assert.equal(safeReturn('/browser/?x=1#a'), '/browser/?x=1#a');
  assert.equal(safeReturn('/zh/'), '/zh/');
  assert.equal(safeReturn('/a/../b/'), '/b/');
  assert.equal(safeReturn('/search/?q=a%2Fb'), '/search/?q=a%2Fb');
  /* 合并 PR3：子站在主域名 /blog/ /curio/ /daymark/ 下（同源，完整地址原样返回）；旧图志 atlas.styrigx.com 的 301 已删、域名下线，仍在回跳黑名单里 */
  assert.equal(safeReturn('https://styrigx.com/blog/post/x/'), 'https://styrigx.com/blog/post/x/');
  assert.equal(safeReturn('/curio/zh/?a=1'), '/curio/zh/?a=1');
  for (const h of ['blog.styrigx.com', 'daymark.styrigx.com', 'curio.styrigx.com', 'atlas.styrigx.com']) assert.equal(safeReturn('https://' + h + '/blog/post/x/'), null, h + ' 已下线');
  assert.equal(safeReturn('https://styrigx.com'), 'https://styrigx.com/');
  assert.equal(safeReturn('/lock/'), null, '/lock/ 解锁后无页面');
  assert.equal(safeReturn(''), null);
  assert.equal(safeReturn(null), null);
});

test('首页 302：复现用例一律 Location: /，浏览器解析后不离开本站', async () => {
  for (const raw of EVIL_RAW) {
    const res = await mw({
      request: new Request('https://styrigx.com/?lock=1&return=' + raw, { headers: { Cookie: cookie } }),
      next: async () => new Response('NEXT', { status: 200 }),
      env: ENV,
    });
    assert.equal(res.status, 302, raw);
    const loc = res.headers.get('Location');
    assert.equal(loc, '/', raw);
    assert.ok(landsOnSite(loc), raw);
  }
});

test('/api/lock-session-check：复现用例 next 一律 /', async () => {
  for (const raw of EVIL_RAW) {
    const res = await sessionCheck({
      request: new Request('https://styrigx.com/api/lock-session-check?return=' + raw, { headers: { Cookie: cookie } }),
      env: ENV,
    });
    assert.equal(res.status, 200, raw);
    const j = await res.json();
    assert.equal(j.next, '/', raw);
  }
});

test('resolveReturn(ret)：只做地址白名单，不看进门方式；门内页也原样回去（不再有升级验证）', () => {
  assert.equal(resolveReturn('/security/lock/'), '/security/lock/');
  assert.equal(resolveReturn('/zh/status/?x=1'), '/zh/status/?x=1');
  assert.equal(resolveReturn('https://styrigx.com/curio/a/'), 'https://styrigx.com/curio/a/');
  assert.equal(resolveReturn('/%09/evil.com'), '/');
  assert.equal(resolveReturn(''), '/');
});
