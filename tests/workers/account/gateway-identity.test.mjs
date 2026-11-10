/**
 * workers/account/src/lib/gateway.js readLockIdentity：网关写的进站身份头（v5 收尾）。
 * - by 白名单 password / passkey / link（分享链接的会话，只作审计）；tempkey 不认（v5 起临时钥匙删除）→ by ''
 * - Link-Id 只在 by=link 且格式合规时给；旧的 X-Styrigx-Space-Tempkey-Id 不再读
 * - 没有 X-Styrigx-Space-Session: 1 → null
 *
 * 运行：node --test tests/workers/account/gateway-identity.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLockIdentity, LOCK_IDENTITY_HEADERS, passedGateway } from '../../../workers/account/src/lib/gateway.js';

const H = (o) => new Headers(o);

test('readLockIdentity：by=link 带 Link-Id → 记下（审计）；password / passkey 不带 id', () => {
  assert.deepEqual({ ...LOCK_IDENTITY_HEADERS }, { session: 'X-Styrigx-Space-Session', by: 'X-Styrigx-Space-By', linkId: 'X-Styrigx-Space-Link-Id' });
  assert.deepEqual(readLockIdentity(H({ 'X-Styrigx-Space-Session': '1', 'X-Styrigx-Space-By': 'link', 'X-Styrigx-Space-Link-Id': 'lktesttesttest01' })),
    { session: true, by: 'link', linkId: 'lktesttesttest01' });
  for (const by of ['password', 'passkey']) {
    assert.deepEqual(readLockIdentity(H({ 'X-Styrigx-Space-Session': '1', 'X-Styrigx-Space-By': by, 'X-Styrigx-Space-Link-Id': 'lktesttesttest01' })),
      { session: true, by, linkId: '' }, by + ' 不带 linkId');
  }
  assert.deepEqual(readLockIdentity(H({ 'X-Styrigx-Space-Session': '1', 'X-Styrigx-Space-By': 'link', 'X-Styrigx-Space-Link-Id': 'bad id!' })),
    { session: true, by: 'link', linkId: '' }, '格式不对的 id 丢掉');
});

test('readLockIdentity：by=tempkey 不认（by 为空），Tempkey-Id 头不读；仍算有进站会话（门由 Session 头决定）', () => {
  const id = readLockIdentity(H({ 'X-Styrigx-Space-Session': '1', 'X-Styrigx-Space-By': 'tempkey', 'X-Styrigx-Space-Tempkey-Id': 'tk1' }));
  assert.deepEqual(id, { session: true, by: '', linkId: '' });
  assert.equal('tempkeyId' in /** @type {any} */ (id), false);
  assert.equal(passedGateway(H({ 'X-Styrigx-Space-Session': '1', 'X-Styrigx-Space-By': 'tempkey' })), true);
});

test('readLockIdentity：没有 Session: 1 → null', () => {
  assert.equal(readLockIdentity(H({ 'X-Styrigx-Space-By': 'link', 'X-Styrigx-Space-Link-Id': 'lktesttesttest01' })), null);
  assert.equal(readLockIdentity(H({ 'X-Styrigx-Space-Session': '0', 'X-Styrigx-Space-By': 'link' })), null);
  assert.equal(readLockIdentity(null), null);
});

test('by 白名单 = 网关进站会话票允许的 by（v5 S8 核对）：password / passkey / link 都认；space / recovery-key / tempkey / 空 / 大小写变体都不认', async () => {
  const { TICKETS, LOCK_SESSION_TICKET } = await import('../../../workers/space-core/src/core/realms.js');
  const bys = [...TICKETS[LOCK_SESSION_TICKET].bys].sort();
  assert.deepEqual(bys, ['link', 'passkey', 'password']);
  for (const by of bys) {
    const id = readLockIdentity(H({ 'X-Styrigx-Space-Session': '1', 'X-Styrigx-Space-By': by, 'X-Styrigx-Space-Link-Id': 'lktesttesttest01' }));
    assert.equal(id && id.by, by, by);
  }
  for (const by of ['space', 'recovery-key', 'tempkey', '', 'Link', 'PASSWORD', 'link ', 'root']) {
    const id = readLockIdentity(H({ 'X-Styrigx-Space-Session': '1', 'X-Styrigx-Space-By': by }));
    assert.equal(id && id.by, by.trim() === 'link' ? 'link' : '', JSON.stringify(by));
  }
});
