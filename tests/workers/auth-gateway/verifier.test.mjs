/**
 * 服务绑定验票（workers/auth-gateway/src/verifier.js，RPC 入口 AuthVerifier 只是薄包装）：
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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { checkLockSession } = await import(REPO + '/workers/auth-gateway/src/verifier.js');
const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-session.js');

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}
async function pair() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    priv: derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY'),
    pub: derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY'),
  };
}
const LOCK = await pair();

function env({ epoch = '0', kvThrows = false } = {}) {
  return {
    SGX_LOCK_PUBLIC: LOCK.pub,
    KV_LOCK_DOOR: {
      async get(k) {
        if (kvThrows) throw new Error('kv down');
        if (k === 'session-epoch') return epoch;
        return null;
      },
    },
  };
}

test('checkLockSession：访客/管理员有效，回角色；没有 cookie、伪造都无效', async () => {
  for (const role of ['admin', 'visitor']) {
    const c = await testLockSession(LOCK.priv, 0, role);
    assert.deepEqual(await checkLockSession('a=1; sgx-lock-session=' + c, env()), { ok: true, role });
  }
  assert.deepEqual(await checkLockSession('', env()), { ok: false, reason: 'no-cookie' });
  assert.deepEqual(await checkLockSession(undefined, env()), { ok: false, reason: 'no-cookie' });
  const other = await pair();
  const forged = await testLockSession(other.priv, 0, 'admin', 'password');
  assert.equal((await checkLockSession('sgx-lock-session=' + forged, env())).ok, false);
  const low = await testLockSession(LOCK.priv, 1, 'admin', 'password');
  assert.equal((await checkLockSession('sgx-lock-session=' + low, env({ epoch: '2' }))).ok, false);
});




test('部署入口导出 AuthVerifier、ShareIssuer（短链 Worker 专用），wrangler main 指向它', () => {
  const toml = readFileSync(REPO + '/workers/auth-gateway/wrangler.toml', 'utf8');
  assert.match(toml, /^main = "src\/worker\.js"$/m);
  const src = readFileSync(REPO + '/workers/auth-gateway/src/worker.js', 'utf8');
  assert.match(src, /export \{ default \} from '\.\/index\.js'/);
  assert.match(src, /export \{ AuthVerifier, ShareIssuer \} from '\.\/rpc\.js'/);
  const rpc = readFileSync(REPO + '/workers/auth-gateway/src/rpc.js', 'utf8');
  assert.match(rpc, /class AuthVerifier extends WorkerEntrypoint/);
  assert.match(rpc, /class ShareIssuer extends WorkerEntrypoint/);
  /* AuthVerifier 只有验票，签钥匙 / 发会话只在 ShareIssuer（只有 styrigx-share 绑定它） */
  const sv = rpc.slice(rpc.indexOf('class AuthVerifier'), rpc.indexOf('class ShareIssuer'));
  assert.doesNotMatch(sv, /createLinkKey|revokeLinkKey|openLinkSession/);
});

