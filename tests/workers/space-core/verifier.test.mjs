/**
 * 服务绑定 RPC 入口 SpaceVerifier（workers/space-core/src/rpc/space-verifier.js）：
 * - wrangler 入口导出 default 和 SpaceVerifier（v6 P4 起 ShareJanitor 随分享短链删除）
 * - v6 P4（定稿 v5.2 §十三）起进站会话删除：session() 没了；conclusion() 一律 denied（奇趣 / 日刻的旧路径不成立，走 admit()）
 * - admit() / auditRoot() 见 v6-cutover.test.mjs
 *
 * 运行：node --test tests/workers/space-core/verifier.test.mjs
 */
import '../account/_cf-workers.mjs'; /* cloudflare:workers 替身：SpaceVerifier 是 WorkerEntrypoint */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { SpaceVerifier } = await import(REPO + '/workers/space-core/src/rpc/space-verifier.js');

test('部署入口只导出 default 和 SpaceVerifier（v6 P4：ShareJanitor 随分享短链删除），wrangler main 指向它', () => {
  const toml = readFileSync(REPO + '/workers/space-core/wrangler.toml', 'utf8');
  assert.match(toml, /^main = "src\/index\.js"$/m);
  const src = readFileSync(REPO + '/workers/space-core/src/index.js', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(src, /export \{ default \} from '\.\/app\.js'/);
  assert.match(src, /export \{ SpaceVerifier \} from '\.\/rpc\/space-verifier\.js'/);
  assert.doesNotMatch(src, /ShareJanitor|ShareIssuer|share-/);
  for (const f of ['rpc/share-issuer.js', 'rpc/auth-verifier.js', 'rpc/share-janitor.js']) {
    assert.equal(existsSync(REPO + '/workers/space-core/src/' + f), false, f);
  }
  const av = readFileSync(REPO + '/workers/space-core/src/rpc/space-verifier.js', 'utf8');
  assert.match(av, /class SpaceVerifier extends WorkerEntrypoint/);
  assert.doesNotMatch(av, /createLinkKey|revokeLinkKey|openLinkSession|purge|checkLockSession|resolveSecrets/i);
});

test('SpaceVerifier：conclusion / admit / auditRoot，没有 session（v6 P4）、没有 fetch', () => {
  assert.equal(SpaceVerifier.prototype.session, undefined);
  assert.equal(SpaceVerifier.prototype.lockSession, undefined);
  for (const m of ['conclusion', 'admit', 'auditRoot']) assert.equal(typeof SpaceVerifier.prototype[m], 'function', m);
  assert.equal(SpaceVerifier.prototype.fetch, undefined);
});

test('SpaceVerifier.conclusion（v6 P4）：一律 denied，不问账号 Worker', async () => {
  let asked = 0;
  const e = { ACCOUNT_VERIFIER: { async authorize() { asked++; return { ok: true }; } } };
  for (const ck of ['', 'sgx-space-session=password.0.9999999999999.; sgx-account-session=x', 'sgx-session=root']) {
    assert.deepEqual(await new SpaceVerifier({}, e).conclusion(ck, { ua: 'UA' }, { reauth: true }), {
      space: { ok: false, by: '', linkId: '', reason: 'no-session' },
      account: { ok: false, deviceId: '', scopes: [], reauth: false, reason: 'no-space' },
    });
  }
  assert.equal(asked, 0);
});
