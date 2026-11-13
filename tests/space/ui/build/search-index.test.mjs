/**
 * 主站全站索引 space/scripts/build/build-search-index.mjs（P4-3 PR-2：副标题 = 完整面包屑、text = 页面设置行文字，AI 才说得出路径；
 * PR-4b：子页去掉 settings 一层；2026-11-12 起分类只有状态页 /status/，它的子页面包屑最上一级是状态页，账号页独立）
 * - pageText：<main> 里的分组标题、设置行标题和说明、行所在 <a> 的地址；脚本 / 图标不算，「正在读取…」占位不要
 * - build(pub)：临时目录里的假产物（CI 单测这一步还没构建，靠它跑）
 * - 最后一组对真实构建跑（先 npm run build；没构建就跳过）
 * 运行：node --test tests/space/ui/build/search-index.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const S = await import(pathToFileURL(path.join(REPO, 'space/scripts/build/build-search-index.mjs')).href);

const HTML = `<html><head><title>安全 | Styrigx</title></head><body><nav><span class="block font-medium">顶栏不算</span></nav>
<main id="sgx-main"><script>var x = '<span class="block font-medium">脚本不算</span>';</script>
<h2 class="set-gh"><span class="set-ic"><svg><path d="M0"/></svg></span><span>安全</span></h2>
<a class="set-row" id="sec-lock-cred" href="/security/lock/"><span class="set-ic"><svg></svg></span>
  <span class="flex-1 min-w-0">
    <span class="block font-medium">锁屏凭证</span>
    <span class="block text-xs text-m-on-surface-variant mt-0.5" id="sec-lock-sub">解锁密码、通行密钥、会话</span>
  </span></a>
<div class="set-row" role="button"><span class="block font-medium">解锁密码</span>
  <span class="block text-xs mt-0.5 text-m-primary" id="pw">正在读取…</span></div>
<div class="set-row"><span class="block font-medium">A &amp; B</span></div>
</main></body></html>`;

test('pageText：分组标题、设置行（标题、说明、所在 <a> 的地址）；脚本、图标、<main> 外不算；占位说明不要', () => {
  const t = S.pageText(HTML);
  assert.deepEqual(t.heads, ['安全']);
  assert.deepEqual(t.rows, [
    { title: '锁屏凭证', sub: '解锁密码、通行密钥、会话', href: '/security/lock/' },
    { title: '解锁密码', sub: '', href: '' },
    { title: 'A & B', sub: '', href: '' },
  ]);
  assert.deepEqual(S.pageText('<html><body>没有 main</body></html>'), { heads: [], rows: [] });
});

/** 假页面：标题 + <main> 里的行 */
const page = (/** @type {string} */ title, /** @type {string} */ main) => `<html><head><title>${title} | Styrigx</title></head><body><main id="sgx-main">${main}</main></body></html>`;
const row = (/** @type {string} */ t, /** @type {string} */ sub, /** @type {string} */ href) =>
  `<a class="set-row" href="${href}"><span class="flex-1"><span class="block font-medium">${t}</span><span class="block text-xs mt-0.5">${sub}</span></span></a>`;

test('build(pub)：副标题 = 完整面包屑（状态页自己没有；子页从状态页起；账号页独立），text = 上级行说明 + 本页内容，截到 TEXT_MAX；跳转页不进；私密照旧', () => {
  const pub = mkdtempSync(path.join(tmpdir(), 'sgx-search-index-'));
  const put = (/** @type {string} */ rel, /** @type {string} */ html) => {
    mkdirSync(path.join(pub, rel), { recursive: true });
    writeFileSync(path.join(pub, rel, 'index.html'), html);
  };
  writeFileSync(path.join(pub, 'files-index.json'), JSON.stringify({ items: [] }));
  /* P4-3 PR-4c：英文在根（无前缀），中文在 zh/ */
  put('zh', page('主页', row('状态', '', '/zh/status/')));
  put('zh/status', page('状态', '<h2 class="set-gh"><span>状态</span></h2>' + row('可用率', '监测、配额、存储', '/zh/status/uptime/')));
  put('zh/status/uptime', page('可用率', '<h2 class="set-gh"><span>监测</span></h2><div class="set-row"><span class="block font-medium">可用率</span><span class="block text-xs">正在读取…</span></div>' +
    '<div class="set-row"><span class="block font-medium">长</span><span class="block text-xs">' + '字'.repeat(400) + '</span></div>'));
  put('zh/status/empty', page('空页', ''));
  put('zh/status/old', '<html><head><meta http-equiv="refresh" content="0; url=/zh/status/"><title>旧页</title></head></html>');
  put('', page('Home', ''));
  put('status', page('Status', row('Uptime', 'Uptime, quota, storage', '/status/uptime/')));
  put('status/uptime', page('Uptime', ''));
  put('zh/account', page('账号', ''));
  put('zh/account/security', page('账号安全', ''));
  /* 进站 v3 L1：/security/ 不是分类了，就算产物里有也不收录 */
  put('zh/security/lock', page('锁屏凭证', ''));
  const ix = S.build(pub);
  const get = (/** @type {string} */ u) => ix.items.find((x) => x.url === 'https://styrigx.com' + u);
  const st = get('/zh/status/uptime/');
  assert.equal(st.lang, 'zh');
  assert.equal(st.subtitle, '主页' + S.CRUMB + '状态');
  assert.ok(st.text.startsWith('监测、配额、存储 监测 可用率 长 字'), st.text);
  assert.equal(st.text.length, S.TEXT_MAX);
  assert.doesNotMatch(st.text, /正在读取/);
  assert.equal(get('/zh/status/').subtitle, '主页');
  assert.equal(get('/zh/').subtitle, '');
  assert.equal(get('/zh/').title, '主页');
  assert.equal(get('/zh/status/old/'), undefined, '跳转页不进索引');
  assert.equal(get('/status/uptime/').lang, 'en');
  assert.equal(get('/status/uptime/').subtitle, 'Home › Status');
  assert.equal(get('/status/uptime/').text, 'Uptime, quota, storage');
  assert.equal(get('/zh/status/empty/').text, undefined, '没有文字就不带 text');
  assert.equal(get('/zh/security/lock/'), undefined, '安全页不再收录');
  /* 2026-11-08 账号整页删了（账号都在顶栏头像的账号终端里）：account/** 不再收录 */
  assert.equal(get('/zh/account/security/'), undefined, '账号页不进索引');
  assert.equal(get('/zh/account/'), undefined);
  assert.equal(st.private, undefined);
  assert.ok(!ix.items.some((x) => /\/en\//.test(x.url)), '索引里没有 /en/ 地址（P4-3 PR-4c）');
  assert.ok(!ix.items.some((x) => /\/settings\//.test(x.url)), '索引里没有 settings 一层的地址');
});

const BUILT = existsSync(path.join(REPO, 'space/web/public/status/index.html'));

test('真实构建：状态页 / 主页的面包屑；安全页（进站 v3 L1 删了）不在索引里；功能开关副标题带面包屑', { skip: !BUILT && '没构建 space/web/public（CI 单测这一步不构建；上面的假产物用例覆盖逻辑）' }, () => {
  const ix = S.build();
  const get = (/** @type {string} */ u) => ix.items.find((x) => x.url === 'https://styrigx.com' + u && x.id.startsWith('setting:'));
  assert.ok(!ix.items.some((x) => /\/security\//.test(x.url)), '进站 v3 L1：索引里没有 /security/');
  assert.equal(get('/zh/status/').subtitle, '主页');
  assert.ok(!ix.items.some((x) => /\/theme\//.test(x.url)), '对齐 PR-C：风格页 /theme/ 退役，索引里没有');
  /* P4-3 PR-4b：显示页删除，索引里没有 /display/ */
  assert.ok(!ix.items.some((x) => /\/display\//.test(x.url)), '索引里没有 /display/');
  assert.ok(!ix.items.some((x) => /^https:\/\/styrigx\.com\/en\//.test(x.url)), '索引里没有 /en/（P4-3 PR-4c）');
  /* 对齐 PR-B：主页不再有分类入口；数字健康 / 关于本站旧地址不进索引；2026-11-12 旷野删除，状态单独成页 /status/，/wild/ 不进索引 */
  for (const old of ['wellbeing', 'wild', 'about']) assert.ok(!ix.items.some((x) => new RegExp('/' + old + '/$').test(x.url)), '索引里没有 /' + old + '/');
  assert.equal(get('/status/').title, 'Status');
  assert.equal(get('/status/').subtitle, 'Home');
  assert.equal(get('/zh/status/').title, '状态');
  assert.equal(get('/zh/status/').subtitle, '主页');
  assert.equal(get('/zh/').subtitle, '', '主页自己没有面包屑');
  assert.equal(get('/').title, 'Home');
  assert.equal(get('/zh/').title, '主页');
  assert.ok(!ix.items.some((x) => /\/account\//.test(x.url)), '2026-11-08 账号整页删了，索引里没有 /account/');
  for (const x of ix.items) if (x.text) assert.ok(x.text.length <= S.TEXT_MAX || x.id.startsWith('feature:'), x.id + ' text 超长');
  /* 对齐 PR-C：风格页 /theme/ 退役，调色板开关只在外观弹层（features.yaml section 空），不进索引 */
  assert.ok(!ix.items.some((x) => x.id.startsWith('feature:palette:')), '调色板开关不进索引');
  /* 显示页删除：主题模式 / 布局 / 语言只在快捷面板，不进索引 */
  for (const id of ['theme-mode', 'layout', 'lang']) assert.ok(!ix.items.some((x) => x.id.startsWith('feature:' + id + ':')), id + ' 不进索引');
  assert.equal(get('/status/').private, undefined);
});
