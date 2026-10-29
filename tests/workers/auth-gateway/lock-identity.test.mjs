/**
 * workers/shared/lock-identity.js：内部请求头名常量（账号拆分 PR1，只有常量）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mod from '../../../workers/shared/lock-identity.js';
import { LOCK_IDENTITY_HEADERS, CLIENT_CONTEXT_HEADERS, INTERNAL_HEADER_PREFIX } from '../../../workers/shared/lock-identity.js';

test('只导出三个常量', () => {
  assert.deepEqual(Object.keys(mod).sort(), ['CLIENT_CONTEXT_HEADERS', 'INTERNAL_HEADER_PREFIX', 'LOCK_IDENTITY_HEADERS']);
});

test('头名逐字固定', () => {
  assert.deepEqual({ ...LOCK_IDENTITY_HEADERS }, {
    role: 'X-Styrigx-Lock-Role',
    by: 'X-Styrigx-Lock-By',
    tempkeyId: 'X-Styrigx-Lock-Tempkey-Id',
  });
  assert.deepEqual({ ...CLIENT_CONTEXT_HEADERS }, {
    address: 'X-Styrigx-Client-Address',
    country: 'X-Styrigx-Client-Country',
    city: 'X-Styrigx-Client-City',
  });
  assert.equal(INTERNAL_HEADER_PREFIX, 'x-styrigx-');
});

test('常量冻结，不可改', () => {
  assert.ok(Object.isFrozen(LOCK_IDENTITY_HEADERS));
  assert.ok(Object.isFrozen(CLIENT_CONTEXT_HEADERS));
});

test('所有头名都以内部前缀开头（小写比较），且互不重复', () => {
  const all = [...Object.values(LOCK_IDENTITY_HEADERS), ...Object.values(CLIENT_CONTEXT_HEADERS)];
  for (const h of all) assert.ok(h.toLowerCase().startsWith(INTERNAL_HEADER_PREFIX), h);
  assert.equal(new Set(all.map((h) => h.toLowerCase())).size, all.length);
  /* 都是合法头名：Headers 能接受 */
  const hd = new Headers();
  for (const h of all) hd.set(h, '1');
  assert.equal([...hd.keys()].length, all.length);
});
