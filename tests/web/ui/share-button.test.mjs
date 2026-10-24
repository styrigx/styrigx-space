/**
 * 子站顶栏分享按钮（web/assets/js/shell/share-button.js → 共享外壳 share.js，2026-10-24）。
 * 站长：POST https://styrigx.com/api/share（credentials include、reuse、24 小时 / 12 小时会话、页面标题当名字）→ 系统分享 / 复制兜底；
 * 访客：直接分享当前页地址；生成中再点不理；失败只 toast，不拿原地址冒充短链。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAll } from '../../../scripts/gen-shell.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const S = await import(path.join(REPO, 'web/assets/js/shell/share-button.js'));
const CODE = 'AbCdEfGhIjKlMnOpQrStUv';

test('共享外壳 share.js = shell/share-button.js 原样；不 import；nav.json 带 share 图标；shell.css 有胶囊 / 忙碌 / toast 样式', () => {
  const files = renderAll();
  assert.equal(files['share.js'], readFileSync(path.join(REPO, 'web/assets/js/shell/share-button.js'), 'utf8'));
  assert.doesNotMatch(files['share.js'], /^\s*import\s/m);
  assert.match(JSON.parse(files['nav.json']).icons.share, /^<svg[\s\S]*<\/svg>$/);
  for (const sel of ['.sgx-tb-end-group {', '.sgx-tb-gbtn {', '.sgx-tb-gbtn.is-busy svg', '.sgx-share-toast {', '.sgx-share-toast.show']) {
    assert.ok(files['shell.css'].includes(sel), sel);
  }
});

test('pageUrl：origin + pathname + search，去掉 lock / why / return / share，不带 #', () => {
  assert.equal(S.pageUrl({ origin: 'https://blog.styrigx.com', pathname: '/post/a/', search: '' }), 'https://blog.styrigx.com/post/a/');
  assert.equal(S.pageUrl({ origin: 'https://blog.styrigx.com', pathname: '/p/', search: '?lock=1&q=x&return=%2F&why=a&share=1' }), 'https://blog.styrigx.com/p/?q=x');
  assert.equal(S.pageUrl({ origin: 'https://curio.styrigx.com', pathname: '/', search: '?lock=1' }), 'https://curio.styrigx.com/');
});

test('linkName：去控制字符、合并空白、最多 24 字（按字符不是按 UTF-16）', () => {
  assert.equal(S.linkName('  日刻 · 今日一句\n'), '日刻 · 今日一句');
  assert.equal([...S.linkName('😀'.repeat(30))].length, 24);
  assert.equal(S.linkName(''), '');
});

test('roleOf：owner / admin = 站长；visitor / 没有 = 访客', () => {
  const doc = (r) => ({ documentElement: { getAttribute: () => r } });
  assert.equal(S.roleOf(doc('owner')), 'owner');
  assert.equal(S.roleOf(doc('admin')), 'owner');
  assert.equal(S.roleOf(doc('visitor')), 'visitor');
  assert.equal(S.roleOf(doc(null)), 'visitor');
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
  const r = await S.createLink({ url: 'https://blog.styrigx.com/post/a/', title: '一'.repeat(30), fetch: f });
  assert.deepEqual(r, { ok: true, url: 'https://styrigx.com/s/' + CODE, reused: true });
  assert.equal(calls[0].url, 'https://styrigx.com/api/share');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'include');
  assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(calls[0].body, { action: 'create', reuse: true, name: '一'.repeat(24), to: 'https://blog.styrigx.com/post/a/', hours: 24, session: 43200 });
});

test('createLink：401 → login，409 → full，500 / 网络错 / 响应里没有像样的 path → fail', async () => {
  const cases = [[401, { ok: false }, 'login'], [401, { ok: false, error: 'account' }, 'login'], [409, { ok: false, error: 'full' }, 'full'],
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

function fakeDom(role) {
  const attrs = {};
  const cls = new Set();
  let onClick = null;
  const btn = {
    classList: { toggle: (c, v) => (v ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) },
    setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; },
    addEventListener: (_t, fn) => { onClick = fn; },
  };
  const doc = { title: '文章 · 博客', documentElement: { lang: 'zh-CN', getAttribute: () => role }, querySelector: () => btn, createElement: () => { throw new Error('no dom'); }, body: {} };
  return { btn, doc, attrs, cls, click: () => onClick({ preventDefault() {} }) };
}

test('mountShare 站长：生成中 aria-busy + is-busy，再点不理（只发一次请求）；完了恢复；分享的是短链', async () => {
  const d = fakeDom('owner');
  let release;
  const calls = [];
  const f = (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Promise((res) => { release = () => res({ ok: true, status: 200, json: async () => ({ ok: true, link: { path: '/s/' + CODE } }) }); });
  };
  const { nav, log } = fakeNav({ share: 'ok' });
  const m = S.mountShare({ doc: d.doc, nav, fetch: f, toast: () => {}, url: () => 'https://blog.styrigx.com/p/' });
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
  assert.equal(calls[0].to, 'https://blog.styrigx.com/p/');
  assert.equal(calls[0].name, '文章 · 博客');
});

test('mountShare 站长：接口失败 → 只 toast 原因，不分享也不复制原地址；访客：不调接口，直接分享当前页', async () => {
  const d = fakeDom('owner');
  const { nav, log } = fakeNav({ share: 'ok' });
  const toasts = [];
  const { f } = fakeFetch(401, { ok: false });
  const m = S.mountShare({ doc: d.doc, nav, fetch: f, toast: (x) => toasts.push(x), url: () => 'https://blog.styrigx.com/p/' });
  assert.equal(await m.share(), 'error');
  assert.deepEqual(log, []);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /重新登录/);
  assert.ok(!d.cls.has('is-busy'));

  const v = fakeDom('visitor');
  const vn = fakeNav({ share: 'ok' });
  let fetched = 0;
  const vm = S.mountShare({ doc: v.doc, nav: vn.nav, fetch: () => { fetched++; }, toast: () => {}, url: () => 'https://daymark.styrigx.com/' });
  assert.equal(await vm.share(), 'shared');
  assert.equal(fetched, 0);
  assert.deepEqual(vn.log, [['share', { title: '文章 · 博客', url: 'https://daymark.styrigx.com/' }]]);
  assert.equal(S.mountShare({ doc: v.doc, nav: vn.nav }), null, '同一个按钮只绑一次');
});
