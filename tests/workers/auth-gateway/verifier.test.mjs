/**
 * 服务绑定验票（workers/auth-gateway/src/verifier.js，RPC 入口 SessionVerifier 只是薄包装）：
 * - checkSession：与网关验页面同一套逻辑；只回结论
 * - checkAppPass：验签 + aud/scope + exp + session epoch + appEpoch；KV 出错 fail closed
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
const { checkSession, checkAppPass, currentAppEpoch } = await import(REPO + '/workers/auth-gateway/src/verifier.js');
const { signSessionCookie } = await import(REPO + '/workers/auth-gateway/functions/_kernel/session.js');
const { signAppToken } = await import(REPO + '/workers/auth-gateway/functions/api/app-token.js');

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
const APP = await pair();

function env({ epoch = '0', appEpoch = null, kvThrows = false } = {}) {
  return {
    SGX_LOCK_PUBLIC: LOCK.pub,
    SGX_APP_PUBLIC: APP.pub,
    OWNER_KV: {
      async get(k) {
        if (kvThrows) throw new Error('kv down');
        if (k === 'session-epoch') return epoch;
        if (k === 'app-epoch:book') return appEpoch;
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

test('checkAppPass：有效通行证通过，回 appEpoch', async () => {
  const t = await signAppToken(APP.priv, 0, 3, 'book', 'upload');
  const r = await checkAppPass('sgx-verified=x; sgx-app=' + t, env({ appEpoch: '3' }), 'book', 'upload');
  assert.equal(r.ok, true);
  assert.equal(r.appEpoch, 3);
});

test('checkAppPass：aud/scope 不符、伪造、epoch/appEpoch 落后、缺公钥、KV 出错一律拒绝', async () => {
  const t = await signAppToken(APP.priv, 0, 3, 'book', 'upload');
  const h = 'sgx-app=' + t;
  assert.equal((await checkAppPass(h, env(), 'book', 'delete')).reason, 'scope');
  assert.equal((await checkAppPass(h, env(), 'other', 'upload')).reason, 'scope');
  const other = await pair();
  const forged = await signAppToken(other.priv, 0, 3, 'book', 'upload');
  assert.equal((await checkAppPass('sgx-app=' + forged, env(), 'book', 'upload')).reason, 'bad-sig');
  assert.equal((await checkAppPass(h, env({ epoch: '1' }), 'book', 'upload')).reason, 'epoch-low');
  assert.equal((await checkAppPass(h, env({ appEpoch: '4' }), 'book', 'upload')).reason, 'app-epoch-low');
  assert.equal((await checkAppPass(h, Object.assign(env(), { SGX_APP_PUBLIC: '' }), 'book', 'upload')).reason, 'no-pubkey');
  assert.equal((await checkAppPass(h, env({ kvThrows: true }), 'book', 'upload')).reason, 'kv-error');
  assert.equal((await checkAppPass('', env(), 'book', 'upload')).reason, 'no-pass');
  assert.equal((await checkAppPass(h, env(), 'Book!', 'upload')).reason, 'bad-request');
});

test('checkAppPass：多个同名 cookie 时任一有效即通过', async () => {
  const t = await signAppToken(APP.priv, 0, 0, 'book', 'upload');
  const r = await checkAppPass('sgx-app=junk; sgx-app=' + t, env(), 'book', 'upload');
  assert.equal(r.ok, true);
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

test('currentAppEpoch：读 KV，缺失为 0，KV 出错 fail closed', async () => {
  assert.deepEqual(await currentAppEpoch(env({ appEpoch: '7' }), 'book'), { ok: true, appEpoch: 7 });
  assert.deepEqual(await currentAppEpoch(env(), 'book'), { ok: true, appEpoch: 0 });
  assert.equal((await currentAppEpoch(env({ kvThrows: true }), 'book')).ok, false);
  assert.equal((await currentAppEpoch(env(), '../x')).ok, false);
});
