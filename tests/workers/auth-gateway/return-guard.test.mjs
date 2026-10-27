/**
 * ?return= 回跳校验（_kernel/return.js safeReturn，首页 302 与 /api/lock-session-check 共用）：
 * 控制字符（Tab/CR/LF…）、反斜杠、协议相对、编码绕过（%09 / %0a / %0d / %5c / %2F / 双重编码）一律回首页，
 * 绝不离开本站；合法站内路径和 *.styrigx.com 白名单照常。
 * 运行：node --test tests/workers/auth-gateway/return-guard.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as mw } from '../../../workers/auth-gateway/functions/_middleware.js';
import { safeReturn, resolveReturn } from '../../../workers/auth-gateway/functions/_kernel/return.js';
import { onRequestGet as sessionCheck } from '../../../workers/auth-gateway/functions/api/lock-session-check.js';
import { testLockSession } from './_tickets.mjs';
import { genKeyPair, authD1For } from '../_harness.mjs';

const { priv: PRIV, pub: PUB } = await genKeyPair();
const KV = { async get() { return null; }, async put() {}, async delete() {} };
const ENV = { SGX_ENV: 'production', SGX_SITE: 'space', SGX_LOCK_PUBLIC: PUB, KV_LOCK_DOOR: KV, D1_LOCK_AUTH: authD1For(KV), D1_ACCOUNT_AUTH: authD1For(KV) , D1_ROOT_AUTH: authD1For(KV)};
const cookie = 'sgx-lock-session=' + (await testLockSession(PRIV, 0, 'admin'));

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
  assert.equal(safeReturn('/settings/'), '/settings/');
  assert.equal(safeReturn('/browser/?x=1#a'), '/browser/?x=1#a');
  assert.equal(safeReturn('/en/'), '/en/');
  assert.equal(safeReturn('/a/../b/'), '/b/');
  assert.equal(safeReturn('/search/?q=a%2Fb'), '/search/?q=a%2Fb');
  assert.equal(safeReturn('https://blog.styrigx.com/post/x/'), 'https://blog.styrigx.com/post/x/');
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

test('resolveReturn：管理员专属页 / 访客升级逻辑不变', () => {
  assert.deepEqual(resolveReturn('/settings/security/lock/', 'admin'), { location: '/settings/security/', upgrade: false });
  assert.deepEqual(resolveReturn('/settings/security/lock/', 'visitor'), { location: '/settings/security/lock/', upgrade: true });
  assert.deepEqual(resolveReturn('/%09/evil.com', 'admin'), { location: '/', upgrade: false });
});
