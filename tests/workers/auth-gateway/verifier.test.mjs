/**
 * 服务绑定验票（workers/auth-gateway/src/core/lock-session.js，RPC 入口 AuthVerifier 只是薄包装）：
 * - checkLockSession：与网关验页面同一套逻辑；只回结论
 * - wrangler 入口导出 AuthVerifier
 *
 * 运行：node --test tests/workers/auth-gateway/verifier.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { testLockSession } from './_tickets.mjs';
import { genKeyPair, makeAuthD1 } from '../_harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { checkLockSession } = await import(REPO + '/workers/auth-gateway/src/core/lock-session.js');
const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/src/core/lock-session.js');

const LOCK = await genKeyPair();

function env({ epoch = '0', kvThrows = false } = {}) {
  const d1 = makeAuthD1({ epochs: { 'lock-epoch': Number(epoch) } }); /* 纪元在 D1 */
  if (kvThrows) d1.failOn = () => true; /* 存储不可用（名字沿用：以前纪元在 KV） */
  return {
    SGX_LOCK_PUBLIC: LOCK.pub,
    KV_LOCK_DOOR: {
      async get() {
        if (kvThrows) throw new Error('kv down');
        return null;
      },
    },
    D1_LOCK_AUTH: d1,
  };
}

test('checkLockSession：访客/管理员有效，回角色；没有 cookie、伪造都无效', async () => {
  for (const role of ['admin', 'visitor']) {
    const c = await testLockSession(LOCK.priv, 0, role);
    assert.deepEqual(await checkLockSession('a=1; sgx-lock-session=' + c, env()), { ok: true, role });
  }
  assert.deepEqual(await checkLockSession('', env()), { ok: false, reason: 'no-cookie' });
  assert.deepEqual(await checkLockSession(undefined, env()), { ok: false, reason: 'no-cookie' });
  const other = await genKeyPair();
  const forged = await testLockSession(other.priv, 0, 'admin', 'password');
  assert.equal((await checkLockSession('sgx-lock-session=' + forged, env())).ok, false);
  const low = await testLockSession(LOCK.priv, 1, 'admin', 'password');
  assert.equal((await checkLockSession('sgx-lock-session=' + low, env({ epoch: '2' }))).ok, false);
});




test('部署入口导出 AuthVerifier、ShareIssuer（短链 Worker 专用），wrangler main 指向它', () => {
  const toml = readFileSync(REPO + '/workers/auth-gateway/wrangler.toml', 'utf8');
  assert.match(toml, /^main = "src\/index\.js"$/m);
  const src = readFileSync(REPO + '/workers/auth-gateway/src/index.js', 'utf8');
  assert.match(src, /export \{ default \} from '\.\/app\.js'/);
  assert.match(src, /export \{ AuthVerifier \} from '\.\/rpc\/auth-verifier\.js'/);
  assert.match(src, /export \{ ShareIssuer \} from '\.\/rpc\/share-issuer\.js'/);
  const av = readFileSync(REPO + '/workers/auth-gateway/src/rpc/auth-verifier.js', 'utf8');
  const si = readFileSync(REPO + '/workers/auth-gateway/src/rpc/share-issuer.js', 'utf8');
  assert.match(av, /class AuthVerifier extends WorkerEntrypoint/);
  assert.match(si, /class ShareIssuer extends WorkerEntrypoint/);
  /* AuthVerifier 只有验票，签钥匙 / 发会话只在 ShareIssuer（只有 styrigx-share 绑定它） */
  assert.doesNotMatch(av, /class ShareIssuer|createLinkKey|revokeLinkKey|openLinkSession/);
});

