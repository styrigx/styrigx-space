/**
 * 边缘测试台（tests/space/e2e/helpers/edge-harness.cjs）里假的 ISSUER 绑定必须有正式 ShareIssuer 的每个 RPC 方法。
 * P2-3 给 ShareIssuer 加了 checkReauth，测试台没跟上 → share Worker 回 503 config，edge-flow 的短链用例全红（PR #264 第一次 CI）。
 * 这里在 node 单测里先拦住，不用等 Playwright。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => readFileSync(path.join(REPO, p), 'utf8');

test('edge-harness 的 ISSUER 覆盖 ShareIssuer 的全部 RPC 方法', () => {
  const rpc = read('workers/auth-gateway/src/rpc/share-issuer.js');
  const methods = [...rpc.matchAll(/^ {2}async (\w+)\(/gm)].map((m) => m[1]);
  assert.ok(methods.length >= 4, 'ShareIssuer 至少有 createLinkKey / revokeLinkKey / checkReauth / openLinkSession');
  const harness = read('tests/space/e2e/helpers/edge-harness.cjs');
  const block = harness.match(/ISSUER:\s*\{([\s\S]*?)\n\s*\},/);
  assert.ok(block, 'edge-harness.cjs 里找不到 ISSUER 绑定');
  for (const m of methods) {
    assert.match(block[1], new RegExp('\\b' + m + ':'), 'edge-harness ISSUER 缺 ' + m);
  }
});

test('share Worker 用到的 ISSUER 方法都在 ShareIssuer 上', () => {
  const rpc = read('workers/auth-gateway/src/rpc/share-issuer.js');
  const used = new Set([...read('workers/share/src/api/share.js').matchAll(/issuer\.(\w+)/g)].map((m) => m[1]));
  for (const m of used) assert.match(rpc, new RegExp('^ {2}async ' + m + '\\(', 'm'), 'ShareIssuer 缺 ' + m);
});
