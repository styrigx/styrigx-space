/**
 * styrigx-search-index GET /healthz（2026-10-28）：给 styrigx-status 的服务绑定 SEARCH 每分钟测一次。
 * 运行：node --test tests/workers/search-index/healthz.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { _resetCache } from '../../../workers/search-index/src/index.js';

const kv = (store, { throws = false } = {}) => ({
  KV_SEARCH_INDEX: { get: async (k) => { if (throws) throw new Error('kv down'); return store[k] ?? null; } },
});
const get = (env, method = 'GET') => worker.fetch(new Request('https://styrigx-search-index/healthz', { method }), env, {});
const IX = { items: [{ id: 'x', type: 'post', lang: 'zh', title: '私密标题', url: 'https://styrigx.com/', private: true }] };

beforeEach(() => _resetCache());

test('四站都在 → 200 { ok, sites: 4, missing: [] }，不回任何条目', async () => {
  const r = await get(kv({ 'site:space': IX, 'site:blog': IX, 'site:daymark': IX, 'site:curio': IX }));
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.deepEqual(JSON.parse(text), { ok: true, sites: 4, missing: [] });
  assert.ok(!text.includes('私密标题'));
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
});

test('缺子站只算缺项 → 仍 200，missing 列出来', async () => {
  const r = await get(kv({ 'site:space': IX }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, sites: 1, missing: ['blog', 'daymark', 'curio'] });
});

test('一个索引都没有 / KV 抛错 / 没绑 KV → 503 index', async () => {
  for (const env of [kv({}), kv({}, { throws: true }), {}]) {
    _resetCache();
    const r = await get(env);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, 'index');
  }
});

test('方法不对 → 405；/healthz/ 之类别的路径照旧 404', async () => {
  assert.equal((await get(kv({ 'site:space': IX }), 'POST')).status, 405);
  const r = await worker.fetch(new Request('https://styrigx-search-index/healthz/'), kv({}), {});
  assert.equal(r.status, 404);
});
