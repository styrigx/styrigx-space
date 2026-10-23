import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../../workers/search-index/src/index.js';

test('缺了某站的索引时，后面的站名不错位', async () => {
  const store = { 'site:curio': { items: [{ id: 'c1', type: 'item', lang: 'zh', title: '奇趣测试', url: 'https://curio.styrigx.com/' }] } };
  const env = { KV_SEARCH_INDEX: { get: async (k) => store[k] ?? null } };
  const res = await worker.fetch(new Request('https://x/search?q=' + encodeURIComponent('奇趣测试') + '&lang=zh', { headers: { 'X-Sgx-Role': 'owner' } }), env, {});
  const body = await res.json();
  const text = JSON.stringify(body);
  assert.ok(text.includes('curio'), text);
  assert.ok(!text.includes('"daymark"') && !text.includes('"blog"'), text);
});
