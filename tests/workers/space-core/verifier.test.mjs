/**
 * 服务绑定验票（workers/space-core/src/core/lock-session.js，RPC 入口 SpaceVerifier 只是薄包装）：
 * - checkLockSession：与网关验页面同一套逻辑；只回结论
 * - wrangler 入口导出 SpaceVerifier
 * - SpaceVerifier.conclusion()（P2-1，逻辑在 core/conclusion.js，细节见 conclusion.test.mjs）：经 RPC 入口走一遍——
 *   Secrets Store 绑定换成字符串后验门、问 ACCOUNT_VERIFIER；没进门不问账号；session()（原 lockSession）只回 { ok, reason }
 *
 * 运行：node --test tests/workers/space-core/verifier.test.mjs
 */
import '../account/_cf-workers.mjs'; /* cloudflare:workers 替身：SpaceVerifier 是 WorkerEntrypoint */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { testLockSession } from './_tickets.mjs';
import { genKeyPair, makeAuthD1 } from '../_harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { checkLockSession } = await import(REPO + '/workers/space-core/src/core/lock-session.js');
const { signLockSessionTicket } = await import(REPO + '/workers/space-core/src/core/lock-session.js');

const LOCK = await genKeyPair();
const { SpaceVerifier } = await import(REPO + '/workers/space-core/src/rpc/space-verifier.js');
const { _resetSecretCache } = await import(REPO + '/workers/space-core/src/secrets.js');

function env({ epoch = '0', kvThrows = false } = {}) {
  const d1 = makeAuthD1({ epochs: { 'lock-epoch': Number(epoch) } }); /* 纪元在 D1 */
  if (kvThrows) d1.failOn = () => true; /* 存储不可用（名字沿用：以前纪元在 KV） */
  return {
    SGX_SPACE_PUBLIC: LOCK.pub,
    KV_LOCK_DOOR: {
      async get() {
        if (kvThrows) throw new Error('kv down');
        return null;
      },
    },
    D1_SPACE: d1,
  };
}

test('checkLockSession：任何进门方式都有效，只回 { ok, reason }（进门二值，不回等级）；没有 cookie、伪造都无效', async () => {
  for (const by of ['password', 'passkey', 'link']) {
    const c = await testLockSession(LOCK.priv, 0, by);
    assert.deepEqual(await checkLockSession('a=1; sgx-space-session=' + c, env()), { ok: true, reason: 'ok' });
  }
  assert.deepEqual(await checkLockSession('', env()), { ok: false, reason: 'no-cookie' });
  assert.deepEqual(await checkLockSession(undefined, env()), { ok: false, reason: 'no-cookie' });
  const other = await genKeyPair();
  const forged = await testLockSession(other.priv, 0, 'password');
  assert.equal((await checkLockSession('sgx-space-session=' + forged, env())).ok, false);
  const low = await testLockSession(LOCK.priv, 1, 'password');
  assert.equal((await checkLockSession('sgx-space-session=' + low, env({ epoch: '2' }))).ok, false);
});




test('部署入口导出 default、SpaceVerifier 和 ShareJanitor（进站 v3 L2：ShareIssuer 删了，分享链接并入本 Worker；v5 S2 加每日清理入口），wrangler main 指向它', () => {
  const toml = readFileSync(REPO + '/workers/space-core/wrangler.toml', 'utf8');
  assert.match(toml, /^main = "src\/index\.js"$/m);
  const src = readFileSync(REPO + '/workers/space-core/src/index.js', 'utf8');
  assert.match(src, /export \{ default \} from '\.\/app\.js'/);
  assert.match(src, /export \{ SpaceVerifier \} from '\.\/rpc\/space-verifier\.js'/);
  assert.match(src, /export \{ ShareJanitor \} from '\.\/rpc\/share-janitor\.js'/);
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /ShareIssuer|share-issuer/);
  assert.equal(existsSync(REPO + '/workers/space-core/src/rpc/share-issuer.js'), false);
  assert.equal(existsSync(REPO + '/workers/space-core/src/rpc/auth-verifier.js'), false);
  const av = readFileSync(REPO + '/workers/space-core/src/rpc/space-verifier.js', 'utf8');
  assert.match(av, /class SpaceVerifier extends WorkerEntrypoint/);
  /* SpaceVerifier 只有验票，签钥匙 / 发会话不在 RPC 上 */
  assert.doesNotMatch(av, /createLinkKey|revokeLinkKey|openLinkSession/);
  /* v5 S2：删数据的清理方法在单独的 ShareJanitor 上，不挂在奇趣 / 日刻绑定的 SpaceVerifier 上 */
  assert.doesNotMatch(av, /purge/i);
});

/* ---------------- SpaceVerifier.conclusion（P2-1） ---------------- */

const DEV = 'devtestdevtest01';
function fakeVerifier(reply) {
  const calls = [];
  return { calls, async authorize(c, x, o) { calls.push([c, x, o]); return reply; }, async session() { return { ok: true }; } };
}

test('SpaceVerifier：有 session 和 conclusion 两个方法，没有 fetch（进站 v3 Q17：lockSession → session）', () => {
  assert.equal(typeof SpaceVerifier.prototype.session, 'function');
  assert.equal(SpaceVerifier.prototype.lockSession, undefined);
  assert.equal(typeof SpaceVerifier.prototype.conclusion, 'function');
  assert.equal(SpaceVerifier.prototype.fetch, undefined);
});

test('SpaceVerifier.conclusion：进门 + 账号会话有效 → { space, account }；锁屏公钥是 Secrets Store 绑定也能读；opts.reauth 原样要', async () => {
  _resetSecretCache();
  const v = fakeVerifier({ ok: true, reason: 'ok', deviceId: DEV, scopes: ['daymark.write', 'curio.write'], reauth: true });
  const e = { ...env(), SGX_SPACE_PUBLIC: { get: async () => LOCK.pub }, ACCOUNT_VERIFIER: v };
  const ck = 'sgx-space-session=' + (await testLockSession(LOCK.priv, 0, 'password')) + '; sgx-account-session=x';
  const r = await new SpaceVerifier({}, e).conclusion(ck, { ua: 'UA' }, { reauth: true });
  assert.deepEqual(r, {
    space: { ok: true, by: 'password', linkId: '', reason: 'ok' },
    account: { ok: true, deviceId: DEV, scopes: ['curio.write', 'daymark.write'], reauth: true, reason: 'ok' },
  });
  assert.deepEqual(v.calls, [[ck, { ua: 'UA' }, { reauth: true }]]);
});

test('SpaceVerifier.conclusion：没进门 → space.ok=false、account no-space，不调账号；账号绑定缺失 → account.ok=false', async () => {
  _resetSecretCache();
  const v = fakeVerifier({ ok: true, reason: 'ok', deviceId: DEV, scopes: [], reauth: false });
  const r = await new SpaceVerifier({}, { ...env(), ACCOUNT_VERIFIER: v }).conclusion('sgx-account-session=x', {});
  assert.equal(r.space.ok, false);
  assert.equal(r.account.ok, false);
  assert.equal(r.account.reason, 'no-space');
  assert.equal(v.calls.length, 0);
  _resetSecretCache();
  const ck = 'sgx-space-session=' + (await testLockSession(LOCK.priv, 0, 'link'));
  const r2 = await new SpaceVerifier({}, env()).conclusion(ck, {});
  assert.equal(r2.space.ok, true);
  assert.equal(r2.space.by, 'link');
  assert.deepEqual(r2.account, { ok: false, deviceId: '', scopes: [], reauth: false, reason: 'no-verifier' });
});

test('SpaceVerifier.session：只回 { ok, reason }（方案 3.4 R11）', async () => {
  _resetSecretCache();
  const c = await testLockSession(LOCK.priv, 0, 'password');
  assert.deepEqual(await new SpaceVerifier({}, env()).session('sgx-space-session=' + c), { ok: true, reason: 'ok' });
});
