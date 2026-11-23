/**
 * atlas-core 入口兜底（报告修复 PR 5，2026-11-23）：handler 抛错 → 500 JSON {ok:false,error:'internal'}，不泄栈。
 * 运行：node --test tests/workers/atlas-core/entry-guard.test.mjs
 */
import '../account/_cf-workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { default: app } = await import('../../../workers/atlas-core/src/app.js'); /* 动态导入：先装好 cloudflare:workers 替身 */

test('atlas-core：handler 抛错 → 500 JSON，不带栈', async () => {
  const err = console.error; const seen = [];
  console.error = (...a) => seen.push(a);
  try {
    const res = await app.fetch(/** @type {any} */ ({ url: 'not a url' }), {}, { waitUntil() {} });
    assert.equal(res.status, 500);
    assert.match(res.headers.get('Content-Type'), /application\/json/);
    const body = await res.text();
    assert.deepEqual(JSON.parse(body), { ok: false, error: 'internal' });
    assert.doesNotMatch(body, /at |Error/);
    assert.equal(seen.length, 1);
  } finally { console.error = err; }
});
