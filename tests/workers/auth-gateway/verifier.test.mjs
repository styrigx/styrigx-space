/**
 * 服务绑定验票（workers/auth-gateway/src/core/lock-session.js，RPC 入口 AuthVerifier 只是薄包装）：
 * - checkLockSession：与网关验页面同一套逻辑；只回结论
 * - wrangler 入口导出 AuthVerifier
 * - AuthVerifier.conclusion()（P2-1，逻辑在 core/conclusion.js，细节见 conclusion.test.mjs）：经 RPC 入口走一遍——
 *   Secrets Store 绑定换成字符串后验门、问 ACCOUNT_VERIFIER；没进门不问账号；lockSession() 不变
 *
 * 运行：node --test tests/workers/auth-gateway/verifier.test.mjs
 */
import '../account/_cf-workers.mjs'; /* cloudflare:workers 替身：AuthVerifier 是 WorkerEntrypoint */
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
const { AuthVerifier } = await import(REPO + '/workers/auth-gateway/src/rpc/auth-verifier.js');
const { _resetSecretCache } = await import(REPO + '/workers/auth-gateway/src/secrets.js');

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

test('checkLockSession：任何进门方式都有效，只回 { ok, reason }（进门二值，不回等级）；没有 cookie、伪造都无效', async () => {
  for (const by of ['password', 'passkey', 'tempkey']) {
    const c = await testLockSession(LOCK.priv, 0, by);
    assert.deepEqual(await checkLockSession('a=1; sgx-lock-session=' + c, env()), { ok: true, reason: 'ok' });
  }
  assert.deepEqual(await checkLockSession('', env()), { ok: false, reason: 'no-cookie' });
  assert.deepEqual(await checkLockSession(undefined, env()), { ok: false, reason: 'no-cookie' });
  const other = await genKeyPair();
  const forged = await testLockSession(other.priv, 0, 'password');
  assert.equal((await checkLockSession('sgx-lock-session=' + forged, env())).ok, false);
  const low = await testLockSession(LOCK.priv, 1, 'password');
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

/* ---------------- AuthVerifier.conclusion（P2-1） ---------------- */

const DEV = 'devtestdevtest01';
function fakeVerifier(reply) {
  const calls = [];
  return { calls, async authorize(c, x, o) { calls.push([c, x, o]); return reply; }, async accountSession() { return { ok: true }; } };
}

test('AuthVerifier：有 lockSession 和 conclusion 两个方法，没有 fetch', () => {
  assert.equal(typeof AuthVerifier.prototype.lockSession, 'function');
  assert.equal(typeof AuthVerifier.prototype.conclusion, 'function');
  assert.equal(AuthVerifier.prototype.fetch, undefined);
});

test('AuthVerifier.conclusion：进门 + 账号会话有效 → { lock, account }；锁屏公钥是 Secrets Store 绑定也能读；opts.reauth 原样要', async () => {
  _resetSecretCache();
  const v = fakeVerifier({ ok: true, reason: 'ok', deviceId: DEV, scopes: ['daymark.write', 'curio.write'], reauth: true });
  const e = { ...env(), SGX_LOCK_PUBLIC: { get: async () => LOCK.pub }, ACCOUNT_VERIFIER: v };
  const ck = 'sgx-lock-session=' + (await testLockSession(LOCK.priv, 0, 'password')) + '; sgx-account-session=x';
  const r = await new AuthVerifier({}, e).conclusion(ck, { ua: 'UA' }, { reauth: true });
  assert.deepEqual(r, {
    lock: { ok: true, by: 'password', tempkeyId: '', reason: 'ok' },
    account: { ok: true, deviceId: DEV, scopes: ['curio.write', 'daymark.write'], reauth: true, reason: 'ok' },
  });
  assert.deepEqual(v.calls, [[ck, { ua: 'UA' }, { reauth: true }]]);
});

test('AuthVerifier.conclusion：没进门 → lock.ok=false、account no-lock，不调账号；账号绑定缺失 → account.ok=false', async () => {
  _resetSecretCache();
  const v = fakeVerifier({ ok: true, reason: 'ok', deviceId: DEV, scopes: [], reauth: false });
  const r = await new AuthVerifier({}, { ...env(), ACCOUNT_VERIFIER: v }).conclusion('sgx-account-session=x', {});
  assert.equal(r.lock.ok, false);
  assert.equal(r.account.ok, false);
  assert.equal(r.account.reason, 'no-lock');
  assert.equal(v.calls.length, 0);
  _resetSecretCache();
  const ck = 'sgx-lock-session=' + (await testLockSession(LOCK.priv, 0, 'tempkey'));
  const r2 = await new AuthVerifier({}, env()).conclusion(ck, {});
  assert.equal(r2.lock.ok, true);
  assert.equal(r2.lock.by, 'tempkey');
  assert.deepEqual(r2.account, { ok: false, deviceId: '', scopes: [], reauth: false, reason: 'no-verifier' });
});

test('AuthVerifier.lockSession：只回 { ok, reason }（方案 3.4 R11）', async () => {
  _resetSecretCache();
  const c = await testLockSession(LOCK.priv, 0, 'password');
  assert.deepEqual(await new AuthVerifier({}, env()).lockSession('sgx-lock-session=' + c), { ok: true, reason: 'ok' });
});
