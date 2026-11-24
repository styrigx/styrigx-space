/**
 * AI 窗口分档·索引直出（2026-11-24 设计稿 v1.0）：ai/panel.js 的纯函数 + 源码约定。
 * - tierOf：GET /api/ai 200 = model，401 = guest，403 = noai，别的不切档
 * - cleanFind：按 url 去重（整个地址相同才算；同一个 /music/zh/ 多条只留第一条，只差 # 的日刻句子不算重复）后取前 FIND_SHOW（5）条；只留四个字段
 * - findPath：结果地址 → 站内路径；hasFind / 历史里 find 能存能读回
 * - 建议关键词：音乐 / 博客 / 游戏、Music / Blog / Games（Gray 2026-11-24 14:46）
 * 运行：node --test tests/space/ui/shell/ai-tier-find.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

globalThis.window = globalThis.window || {};
const AP = await import('../../../../space/web/assets/common/js/frame/ai/panel.js');
const REPO = new URL('../../../../', import.meta.url);
const rd = (f) => readFileSync(new URL(f, REPO), 'utf8');

function memStore(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test('tierOf：200 模型档；401 访客索引档；403 无权限索引档；5xx / 0 不切档', () => {
  assert.equal(AP.tierOf(200), 'model');
  assert.equal(AP.tierOf(401), 'guest');
  assert.equal(AP.tierOf(403), 'noai');
  for (const s of [0, 404, 429, 500, 503]) assert.equal(AP.tierOf(s), '', String(s));
});

test('cleanFind：按 url 去重后取前 5 条；坏条目丢掉；只留 title / url / site / snippet', () => {
  const music = { title: '太阳之子', url: 'https://styrigx.com/music/zh/', site: 'curio', snippet: '曲目', text: '不该带出去' };
  const raw = [
    music,
    { ...music, title: '伟大的渺小' },
    { ...music, title: '晴天' },
    { title: '尼采', url: 'https://styrigx.com/daymark/zh/#flavors/a/x', site: 'daymark', snippet: '' },
    { title: '尼采 2', url: 'https://styrigx.com/daymark/zh/#flavors/a/y', site: 'daymark', snippet: '' },
    null, { title: '', url: 'https://styrigx.com/x/' }, { title: 'no url' },
    ...Array.from({ length: 8 }, (_, i) => ({ title: 'post ' + i, url: 'https://styrigx.com/blog/p' + i + '/', site: 'blog' })),
  ];
  const out = AP.cleanFind(raw);
  assert.equal(out.length, AP.FIND_SHOW);
  assert.equal(AP.FIND_SHOW, 5);
  assert.deepEqual(out[0], { title: '太阳之子', url: 'https://styrigx.com/music/zh/', site: 'curio', snippet: '曲目' });
  assert.equal(out.filter((x) => x.url === 'https://styrigx.com/music/zh/').length, 1, '同一地址只留第一条');
  assert.deepEqual(out.slice(1).map((x) => x.title), ['尼采', '尼采 2', 'post 0', 'post 1'], '只差 # 的日刻句子不算重复');
  for (const it of out) assert.deepEqual(Object.keys(it).sort(), ['site', 'snippet', 'title', 'url']);
  assert.deepEqual(AP.cleanFind(null), []);
});

test('findPath：绝对地址 → 站内路径（带查询 / 锚点）；不是绝对地址原样', () => {
  assert.equal(AP.findPath('https://styrigx.com/blog/post/x/'), '/blog/post/x/');
  assert.equal(AP.findPath('https://styrigx.com'), '/');
  assert.equal(AP.findPath('https://styrigx.com/curio/?q=1#a'), '/curio/?q=1#a');
  assert.equal(AP.findPath('/zh/status/'), '/zh/status/');
});

test('历史：索引档的回答（find）存进去能读回、去重后最多 5 条；hasFind 标「搜索」', () => {
  const s = memStore();
  const msgs = [
    { role: 'user', text: '音乐', ts: 1 },
    { role: 'assistant', text: '太阳之子 https://styrigx.com/music/zh/', ts: 2, find: { results: [{ title: '太阳之子', url: 'https://styrigx.com/music/zh/', site: 'curio', snippet: '' }, { title: '晴天', url: 'https://styrigx.com/music/zh/', site: 'curio', snippet: '' }] } },
  ];
  AP.saveChats({ cur: 'c1', chats: [{ id: 'c1', title: '', time: 2, msgs }] }, s);
  const d = AP.loadChats(s);
  assert.equal(d.chats.length, 1);
  assert.deepEqual(d.chats[0].msgs[1].find, { results: [{ title: '太阳之子', url: 'https://styrigx.com/music/zh/', site: 'curio', snippet: '' }] });
  assert.equal(AP.hasFind(d.chats[0].msgs), true);
  assert.equal(AP.hasFind([{ role: 'assistant', text: 'x', ts: 1 }]), false);
});

test('源码约定：索引档走 GET /api/find?…&mode=recall；loadModels 认 401 和 403（tierOf）；会话中途 403 forbidden 切索引档重问；胶囊纯放大镜图标', () => {
  const src = rd('space/web/assets/common/js/frame/ai/panel.js');
  assert.equal(AP.FIND_API, '/api/find');
  assert.match(src, /FIND_API \+ '\?q=' \+ encodeURIComponent\(qq\) \+ '&lang=' \+ lang \+ '&mode=recall'/);
  assert.match(src, /const v = r \? tierOf\(r\.status\) : '';/);
  assert.match(src, /if \(failed === 'forbidden' && !ans\.text\) \{\s*setTier\('noai'\);/);
  assert.doesNotMatch(src, /setLocked|is-locked/);
  const tb = rd('space/web/layouts/partials/common/frame/topbar.html');
  assert.match(tb, /<span data-ai-model-find aria-hidden="true"><svg [^>]*><circle /);
  assert.doesNotMatch(tb, /data-ai-model-lock/);
  assert.match(tb, /data-ai-finfo hidden/);
  /* 头像 = 参数 avatar 的 96 档（主站 /avatar/96.webp；子站站内地址规矩是 https://styrigx.com 绝对地址，one-site.test.mjs） */
  assert.match(tb, /<img class="sgx-ai-badge-img" src="\{\{ replace \(\.avatar \| default "\/avatar\/192\.webp"\) "\/192\.webp" "\/96\.webp" \}\}" alt=""/);
});

test('建议关键词：音乐 / 博客 / 游戏，Music / Blog / Games（Gray 2026-11-24 14:46）；中英键一致', () => {
  const zh = yaml.load(rd('space/web/data/common/frame/i18n/zh.yaml')).ai;
  const en = yaml.load(rd('space/web/data/common/frame/i18n/en.yaml')).ai;
  assert.deepEqual([zh.fsug1, zh.fsug2, zh.fsug3], ['音乐', '博客', '游戏']);
  assert.deepEqual([en.fsug1, en.fsug2, en.fsug3], ['Music', 'Blog', 'Games']);
  assert.equal(zh.findLabel, '站内搜索（不经 AI）');
  assert.equal(zh.findGuest, '站内搜索，不经 AI。su 登录后可问 AI');
  assert.equal(zh.findNoAi, '站内搜索，不经 AI。这个账号没有 AI 权限');
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
});
