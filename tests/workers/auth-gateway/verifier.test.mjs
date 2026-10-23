/**
 * 服务绑定验票（workers/auth-gateway/src/verifier.js，RPC 入口 SessionVerifier 只是薄包装）：
 * - checkSession：与网关验页面同一套逻辑；只回结论
 * - wrangler 入口导出 SessionVerifier
 *
 * 运行：node --test tests/workers/auth-gateway/verifier.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { checkSession } = await import(REPO + '/workers/auth-gateway/src/verifier.js');
const { signSessionCookie } = await import(REPO + '/workers/auth-gateway/functions/_kernel/session.js');

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

test('checkSession：访客/主人有效，回角色；没有 cookie、伪造都无效', async () => {
  for (const role of ['owner', 'visitor']) {
    const c = await signSessionCookie(LOCK.priv, 0, role, 'owner');
    assert.deepEqual(await checkSession('a=1; sgx-verified=' + c, env()), { ok: true, role });
  }
  assert.deepEqual(await checkSession('', env()), { ok: false, reason: 'no-cookie' });
  assert.deepEqual(await checkSession(undefined, env()), { ok: false, reason: 'no-cookie' });
  const other = await pair();
  const forged = await signSessionCookie(other.priv, 0, 'owner', 'owner');
  assert.equal((await checkSession('sgx-verified=' + forged, env())).ok, false);
  const low = await signSessionCookie(LOCK.priv, 1, 'owner', 'owner');
  assert.equal((await checkSession('sgx-verified=' + low, env({ epoch: '2' }))).ok, false);
});




test('部署入口导出 SessionVerifier，wrangler main 指向它', () => {
  const toml = readFileSync(REPO + '/workers/auth-gateway/wrangler.toml', 'utf8');
  assert.match(toml, /^main = "src\/worker\.js"$/m);
  const src = readFileSync(REPO + '/workers/auth-gateway/src/worker.js', 'utf8');
  assert.match(src, /export \{ default \} from '\.\/index\.js'/);
  assert.match(src, /export \{ SessionVerifier \} from '\.\/rpc\.js'/);
  const rpc = readFileSync(REPO + '/workers/auth-gateway/src/rpc.js', 'utf8');
  assert.match(rpc, /class SessionVerifier extends WorkerEntrypoint/);
});

