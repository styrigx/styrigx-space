/**
 * 主站全站索引 space/scripts/build-search-index.mjs（P4-3 PR-2：副标题 = 完整面包屑、text = 页面设置行文字，AI 才说得出路径）
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
const S = await import(pathToFileURL(path.join(REPO, 'space/scripts/build-search-index.mjs')).href);

const HTML = `<html><head><title>安全 | Styrigx</title></head><body><nav><span class="block font-medium">顶栏不算</span></nav>
<main id="sgx-main"><script>var x = '<span class="block font-medium">脚本不算</span>';</script>
<h2 class="set-gh"><span class="set-ic"><svg><path d="M0"/></svg></span><span>安全</span></h2>
<a class="set-row" id="sec-lock-cred" href="/settings/security/lock/"><span class="set-ic"><svg></svg></span>
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
    { title: '锁屏凭证', sub: '解锁密码、通行密钥、会话', href: '/settings/security/lock/' },
    { title: '解锁密码', sub: '', href: '' },
    { title: 'A & B', sub: '', href: '' },
  ]);
  assert.deepEqual(S.pageText('<html><body>没有 main</body></html>'), { heads: [], rows: [] });
});

/** 假页面：标题 + <main> 里的行 */
const page = (/** @type {string} */ title, /** @type {string} */ main) => `<html><head><title>${title} | Styrigx</title></head><body><main id="sgx-main">${main}</main></body></html>`;
const row = (/** @type {string} */ t, /** @type {string} */ sub, /** @type {string} */ href) =>
  `<a class="set-row" href="${href}"><span class="flex-1"><span class="block font-medium">${t}</span><span class="block text-xs mt-0.5">${sub}</span></span></a>`;

test('build(pub)：副标题 = 完整面包屑（根页没有），text = 上级行说明 + 本页内容，截到 TEXT_MAX；跳转页不进；私密照旧', () => {
  const pub = mkdtempSync(path.join(tmpdir(), 'sgx-search-index-'));
  const put = (/** @type {string} */ rel, /** @type {string} */ html) => {
    mkdirSync(path.join(pub, rel), { recursive: true });
    writeFileSync(path.join(pub, rel, 'index.html'), html);
  };
  writeFileSync(path.join(pub, 'files-index.json'), JSON.stringify({ items: [] }));
  put('settings', page('设置', row('安全', '', '/settings/security/')));
  put('settings/security', page('安全', '<h2 class="set-gh"><span>安全</span></h2>' + row('锁屏凭证', '解锁密码、通行密钥、会话', '/settings/security/lock/')));
  put('settings/security/lock', page('锁屏凭证', '<h2 class="set-gh"><span>通行密钥</span></h2><div class="set-row"><span class="block font-medium">解锁密码</span><span class="block text-xs">正在读取…</span></div>' +
    '<div class="set-row"><span class="block font-medium">长</span><span class="block text-xs">' + '字'.repeat(400) + '</span></div>'));
  put('settings/security/tempkeys', page('临时钥匙', ''));
  put('settings/old', '<html><head><meta http-equiv="refresh" content="0; url=/settings/"><title>旧页</title></head></html>');
  put('en/settings', page('Settings', ''));
  put('en/settings/security', page('Security', row('Lock screen credentials', 'Password, passkeys, sessions', '/en/settings/security/lock/')));
  put('en/settings/security/lock', page('Lock screen credentials', ''));
  put('account', page('账号', ''));
  put('account/security', page('账号安全', ''));
  const ix = S.build(pub);
  const get = (/** @type {string} */ u) => ix.items.find((x) => x.url === 'https://styrigx.com' + u);
  const lock = get('/settings/security/lock/');
  assert.equal(lock.subtitle, '设置' + S.CRUMB + '安全');
  assert.ok(lock.text.startsWith('解锁密码、通行密钥、会话 通行密钥 解锁密码 长 字'), lock.text);
  assert.equal(lock.text.length, S.TEXT_MAX);
  assert.doesNotMatch(lock.text, /正在读取/);
  assert.equal(get('/settings/security/').subtitle, '设置');
  assert.equal(get('/settings/').subtitle, '');
  assert.equal(get('/settings/old/'), undefined, '跳转页不进索引');
  assert.equal(get('/en/settings/security/lock/').subtitle, 'Settings › Security');
  assert.equal(get('/en/settings/security/lock/').text, 'Password, passkeys, sessions');
  assert.equal(get('/settings/security/tempkeys/').text, undefined, '没有文字就不带 text');
  assert.equal(get('/settings/security/tempkeys/').private, true);
  assert.equal(get('/account/security/').subtitle, '账号');
  assert.equal(get('/account/security/').private, true);
  assert.equal(lock.private, undefined);
});

const BUILT = existsSync(path.join(REPO, 'space/web/public/settings/security/lock/index.html'));

test('真实构建：锁屏凭证的副标题是完整面包屑，text 带上级行说明和本页内容；功能开关副标题带面包屑', { skip: !BUILT && '没构建 space/web/public（CI 单测这一步不构建；上面的假产物用例覆盖逻辑）' }, () => {
  const ix = S.build();
  const get = (/** @type {string} */ u) => ix.items.find((x) => x.url === 'https://styrigx.com' + u && x.id.startsWith('setting:'));
  const lock = get('/settings/security/lock/');
  assert.equal(lock.title, '锁屏凭证');
  assert.equal(lock.subtitle, '设置 › 安全');
  assert.match(lock.text, /通行密钥/);
  assert.match(lock.text, /解锁密码、通行密钥、会话/, '上级页「安全」里指向本页那一行的说明');
  assert.doesNotMatch(lock.text, /正在读取/);
  const en = get('/en/settings/security/lock/');
  assert.equal(en.subtitle, 'Settings › Security');
  assert.match(en.text, /passkeys/i);
  assert.equal(get('/settings/display/').subtitle, '设置');
  assert.equal(get('/settings/').subtitle, '', '根页没有面包屑');
  assert.equal(get('/account/security/').subtitle, '账号');
  for (const x of ix.items) if (x.text) assert.ok(x.text.length <= S.TEXT_MAX || x.id.startsWith('feature:'), x.id + ' text 超长');
  const feat = ix.items.find((x) => x.id.startsWith('feature:') && x.lang === 'zh' && x.url === 'https://styrigx.com/settings/display/');
  assert.ok(feat && feat.subtitle === '设置' + S.CRUMB + '显示', '功能开关副标题 = 面包屑 + 页名');
  /* 私密标记照旧 */
  assert.equal(get('/settings/security/tempkeys/').private, true);
  assert.equal(lock.private, undefined);
});
