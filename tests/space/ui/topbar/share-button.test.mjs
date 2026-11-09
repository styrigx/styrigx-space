/**
 * 子站「分享本页」（space/web/assets/js/shell/share-button.js → 共享外壳 share.js，2026-10-24；2026-11-04 P5-1 起是子站快捷面板第 2 页的磁贴，顶栏右圆删除）。
 * 进门二值（P2-3）：不分角色，都 POST https://styrigx.com/api/share（credentials include、reuse、24 小时 / 12 小时会话、页面标题当名字）
 * → 系统分享 / 复制兜底；401 reauth → 最小锁侧复验步骤，通过后自动重试一次、取消什么也不分享；生成中再点不理；失败只 toast，不拿原地址冒充短链。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellFiles } from '../../../../space/scripts/gen-shell.mjs';
import { strings } from '../../../fixtures/strings.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const S = await import(path.join(REPO, 'space/web/assets/js/shell/share-button.js'));
const CODE = 'AbCdEfGhIjKlMnOpQrStUv';

test('共享外壳 share.js = shell/share-button.js 原样；不 import；nav.json 带 share 图标；shell.css 有磁贴忙碌 / toast 样式，没有右圆 / 胶囊', () => {
  const files = shellFiles();
  assert.equal(files['share.js'], readFileSync(path.join(REPO, 'space/web/assets/js/shell/share-button.js'), 'utf8'));
  assert.doesNotMatch(files['share.js'], /^\s*import\s/m);
  assert.match(JSON.parse(files['nav.json']).icons.share, /^<svg[\s\S]*<\/svg>$/);
  for (const sel of ['.is-busy[data-sgx-share] {', '.is-busy[data-sgx-share] svg {', '.sgx-share-toast {', '.sgx-share-toast.show']) {
    assert.ok(files['shell.css'].includes(sel), sel);
  }
  for (const sel of ['.sgx-tb-end', '.sgx-tb-gbtn', '.sgx-tb-share']) assert.ok(!files['shell.css'].includes(sel), '已删：' + sel);
  /* 按钮标记在共享顶栏的 NAVIGATE 里（顶栏 v3）：data-qp="share" 同时带 data-sgx-share（share.js 按它找按钮） */
  assert.match(files['topbar.html'], /<button type="button" class="sgx-nav-btn" data-qp="share" data-sgx-share aria-label="\{\{ \$t\.topbar\.share \}\}">/);
});

test('pageUrl：origin + pathname + search，去掉 lock / why / return / share，不带 #', () => {
  /* 合并 PR3 起三站在主域名 /blog/ /curio/ /daymark/ 下 */
  assert.equal(S.pageUrl({ origin: 'https://styrigx.com', pathname: '/blog/post/a/', search: '' }), 'https://styrigx.com/blog/post/a/');
  assert.equal(S.pageUrl({ origin: 'https://styrigx.com', pathname: '/blog/p/', search: '?lock=1&q=x&return=%2F&why=a&share=1' }), 'https://styrigx.com/blog/p/?q=x');
  assert.equal(S.pageUrl({ origin: 'https://styrigx.com', pathname: '/curio/', search: '?lock=1' }), 'https://styrigx.com/curio/');
});

test('linkName：去控制字符、合并空白、最多 24 字（按字符不是按 UTF-16）', () => {
  assert.equal(S.linkName('  日刻 · 今日一句\n'), '日刻 · 今日一句');
  assert.equal([...S.linkName('😀'.repeat(30))].length, 24);
  assert.equal(S.linkName(''), '');
});

test('不再分角色：没有 roleOf，源码不读旧等级标记', () => {
  assert.equal(S.roleOf, undefined);
  assert.doesNotMatch(readFileSync(path.join(REPO, 'space/web/assets/js/shell/share-button.js'), 'utf8'), /data-sgx-role/); // old-name guard
});

function fakeFetch(status, body) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (status === 'throw') throw new TypeError('Failed to fetch');
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { f, calls };
}

test('createLink：请求形状（跨源带 cookie、reuse、24h / 12h、名字截断）；成功给 https://styrigx.com/s/<码>', async () => {
  const { f, calls } = fakeFetch(200, { ok: true, reused: true, link: { path: '/s/' + CODE } });
  const r = await S.createLink({ url: 'https://styrigx.com/blog/post/a/', title: '一'.repeat(30), fetch: f });
  assert.deepEqual(r, { ok: true, url: 'https://styrigx.com/s/' + CODE, reused: true });
  assert.equal(calls[0].url, 'https://styrigx.com/api/share');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'include');
  assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(calls[0].body, { action: 'create', reuse: true, name: '一'.repeat(24), to: 'https://styrigx.com/blog/post/a/', hours: 24, session: 43200 });
});

test('createLink（进站 v3 Q3：新建不要 reauth）：401（不论 error）→ session，409 → full，500 / 网络错 / 响应里没有像样的 path → fail', async () => {
  const cases = [[401, { ok: false, error: 'reauth' }, 'session'], [401, { ok: false }, 'session'], [401, { ok: false, error: 'session' }, 'session'], [409, { ok: false, error: 'full' }, 'full'],
    [503, { ok: false, error: 'server' }, 'fail'], [403, { ok: false, error: 'origin' }, 'fail'], ['throw', null, 'fail'],
    [200, { ok: true, link: { path: 'https://evil.com/' } }, 'fail'], [200, { ok: true, link: {} }, 'fail'], [200, null, 'fail']];
  for (const [st, body, key] of cases) {
    const { f } = fakeFetch(st, body);
    assert.deepEqual(await S.createLink({ url: 'https://x/', title: '', fetch: f }), { ok: false, key }, String(st) + JSON.stringify(body));
  }
});

function fakeNav(opts) {
  const log = [];
  const nav = {};
  if (opts.share !== undefined) {
    nav.share = async (d) => {
      log.push(['share', d]);
      if (opts.share !== 'ok') { const e = new Error('x'); e.name = opts.share; throw e; }
    };
  }
  nav.clipboard = { writeText: async (t) => { log.push(['copy', t]); if (opts.copyFail) throw new Error('denied'); } };
  return { nav, log };
}
const fakeDoc = { createElement: () => { throw new Error('no dom'); }, body: {} };
const T = { copied: '已复制分享链接', copyFail: '复制失败' };

test('shareOrCopy：系统分享成功不 toast；AbortError 不复制；NotAllowedError / 没有 Web Share → 复制 + 已复制分享链接；复制失败 → 复制失败', async () => {
  for (const [share, copyFail, want, toastWant, logKinds] of [
    ['ok', false, 'shared', [], ['share']],
    ['AbortError', false, 'aborted', [], ['share']],
    ['NotAllowedError', false, 'copied', ['已复制分享链接'], ['share', 'copy']],
    ['TypeError', false, 'copied', ['已复制分享链接'], ['share', 'copy']],
    [undefined, false, 'copied', ['已复制分享链接'], ['copy']],
    [undefined, true, 'failed', ['复制失败'], ['copy']],
  ]) {
    const { nav, log } = fakeNav({ share, copyFail });
    const toasts = [];
    const r = await S.shareOrCopy({ title: 't', url: 'https://styrigx.com/s/' + CODE }, { nav, doc: fakeDoc, toast: (m) => toasts.push(m), t: T });
    assert.equal(r, want, String(share));
    assert.deepEqual(toasts, toastWant, String(share));
    assert.deepEqual(log.map((x) => x[0]), logKinds, String(share));
    if (log[0] && log[0][0] === 'share') assert.deepEqual(log[0][1], { title: 't', url: 'https://styrigx.com/s/' + CODE });
  }
});

function fakeDom() {
  const attrs = {};
  const cls = new Set();
  let onClick = null;
  const btn = {
    classList: { toggle: (c, v) => (v ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) },
    setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; },
    addEventListener: (_t, fn) => { onClick = fn; },
  };
  /* 页面上的外壳字符串表 #sgx-i18n-shell（语言包化 2026-11-07：share.js 从这里取文案，中文页 = 英文 ← 中文的合并） */
  const shellTable = JSON.stringify(strings('space', 'zh').shell);
  const doc = { title: '文章 · 博客', documentElement: { lang: 'zh-CN', getAttribute: () => null }, querySelector: () => btn, getElementById: (id) => (id === 'sgx-i18n-shell' ? { textContent: shellTable } : null), createElement: () => { throw new Error('no dom'); }, body: {} };
  return { btn, doc, attrs, cls, click: () => onClick({ preventDefault() {} }) };
}

test('mountShare：生成中 aria-busy + is-busy，再点不理（只发一次请求）；完了恢复；分享的是短链', async () => {
  const d = fakeDom();
  let release;
  const calls = [];
  const f = (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Promise((res) => { release = () => res({ ok: true, status: 200, json: async () => ({ ok: true, link: { path: '/s/' + CODE } }) }); });
  };
  const { nav, log } = fakeNav({ share: 'ok' });
  const m = S.mountShare({ doc: d.doc, nav, fetch: f, toast: () => {}, url: () => 'https://styrigx.com/blog/p/' });
  const p1 = m.share();
  assert.equal(d.attrs['aria-busy'], 'true');
  assert.ok(d.cls.has('is-busy'));
  assert.equal(await m.share(), 'busy');
  d.click();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1, '忙的时候不再发请求');
  release();
  assert.equal(await p1, 'shared');
  assert.equal(d.attrs['aria-busy'], undefined);
  assert.ok(!d.cls.has('is-busy'));
  assert.deepEqual(log, [['share', { title: '文章 · 博客', url: 'https://styrigx.com/s/' + CODE }]]);
  assert.equal(calls[0].to, 'https://styrigx.com/blog/p/');
  assert.equal(calls[0].name, '文章 · 博客');
});

test('mountShare：接口失败 → 只 toast 原因，不分享也不复制原地址；同一个按钮只绑一次', async () => {
  const d = fakeDom();
  const { nav, log } = fakeNav({ share: 'ok' });
  const toasts = [];
  const { f, calls } = fakeFetch(401, { ok: false, error: 'session' });
  const m = S.mountShare({ doc: d.doc, nav, fetch: f, toast: (x) => toasts.push(x), url: () => 'https://styrigx.com/blog/p/', reauth: async () => { throw new Error('session 不该走复验'); } });
  assert.equal(await m.share(), 'error');
  assert.equal(calls.length, 1);
  assert.deepEqual(log, []);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /重新解锁/);
  assert.ok(!d.cls.has('is-busy'));
  assert.equal(S.mountShare({ doc: d.doc, nav }), null, '同一个按钮只绑一次');
});

test('mountShare（进站 v3 Q3 定稿 08:00）：新建只要进站会话——不弹复验、不重试；401 → 会话过期提示；最小复验步骤（lockReauthStep / reauthApi / .sgx-share-reauth）删了', async () => {
  assert.equal(S.reauthApi, undefined);
  assert.equal(S.lockReauthStep, undefined);
  const d = fakeDom();
  const { nav, log } = fakeNav({ share: 'ok' });
  const toasts = [];
  const cf = fakeFetch(401, { ok: false, error: 'reauth' });
  const m = S.mountShare({ doc: d.doc, nav, fetch: cf.f, toast: (x) => toasts.push(x), url: () => 'https://styrigx.com/curio/x/' });
  assert.equal(await m.share(), 'error');
  assert.equal(cf.calls.length, 1, '只请求一次');
  assert.deepEqual(log, [], '什么也不分享');
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /重新解锁/);
  assert.ok(!d.cls.has('is-busy'));
  const src = readFileSync(path.join(REPO, 'space/web/assets/js/shell/share-button.js'), 'utf8');
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /sgx-share-reauth|lock-reauth|lock-password|credentials\.get/);
});
