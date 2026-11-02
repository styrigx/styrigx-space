// 列表页页签 hash 协议（web/assets/js/blog/app-tabs.ts）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHash, routeHash } from '../../web/blog/assets/js/blog/app-tabs-route.js';

test('hash → 页签', () => {
  assert.deepEqual(parseHash(''), { tab: 'home' });
  assert.deepEqual(parseHash('#home'), { tab: 'home' });
  assert.deepEqual(parseHash('#posts'), { tab: 'posts' });
  assert.deepEqual(parseHash('#topics'), { tab: 'topics' });
  assert.deepEqual(parseHash('#topics/tag/ai'), {
    tab: 'topics',
    filter: { kind: 'tag', slug: 'ai' },
  });
  assert.deepEqual(parseHash('#topics/series/styrigx-ui-%E9%89%B4'), {
    tab: 'topics',
    filter: { kind: 'series', slug: 'styrigx-ui-鉴' },
  });
  assert.equal(parseHash('#archive'), null, '没有归档页签');
  assert.equal(parseHash('#some-heading'), null);
});

test('页签 → hash', () => {
  assert.equal(routeHash({ tab: 'home' }), '');
  assert.equal(routeHash({ tab: 'posts' }), '#posts');
  assert.equal(routeHash({ tab: 'topics', filter: { kind: 'tag', slug: 'ai' } }), '#topics/tag/ai');
});
