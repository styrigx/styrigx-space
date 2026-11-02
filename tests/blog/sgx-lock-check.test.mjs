// 切回标签页的锁定检查：web/assets/js/blog/sgx-lock-check.js（问网关 /api/lock-session-check，401 跳主站锁屏）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../../web/blog/assets/js/blog/sgx-lock-check.js', import.meta.url), 'utf8');

/**
 * 在假的 window / document 里跑脚本，返回触发器和记录。
 * respond：fetch 的回答（{status, json} 或 'network'），json 是函数时当 r.json() 的实现
 */
function load({ href = 'https://atlas.styrigx.com/blog/post/a/', respond = { status: 204 }, now = 100000 } = {}) {
  const docListeners = {};
  const winListeners = {};
  const replaced = [];
  const calls = [];
  let clock = now;
  const doc = {
    visibilityState: 'visible',
    addEventListener: (t, f) => (docListeners[t] = f),
  };
  const win = {
    location: { href, replace: (u) => replaced.push(u) },
    addEventListener: (t, f) => (winListeners[t] = f),
  };
  const fetch = (url, init) => {
    calls.push({ url, init });
    const r = typeof respond === 'function' ? respond(calls.length) : respond;
    if (r === 'network') return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve({
      status: r.status,
      json: typeof r.json === 'function' ? r.json : () => Promise.resolve(r.json),
    });
  };
  const ctx = {
    window: win,
    document: doc,
    fetch,
    URL,
    Date: { now: () => clock },
  };
  vm.runInNewContext(src, ctx);
  const flush = () => new Promise((res) => setTimeout(res, 0));
  return {
    docListeners,
    winListeners,
    replaced,
    calls,
    doc,
    tick: (ms) => (clock += ms),
    /** 触发一次检查并等 promise 链跑完 */
    async focus() {
      winListeners.focus();
      await flush();
      await flush();
    },
  };
}

const parse = (u) => {
  const url = new URL(u);
  return { origin: url.origin, path: url.pathname, keys: [...url.searchParams.keys()], p: url.searchParams };
};

test('fetch 用 cache: no-store 选项（不是请求头），同源带 cookie', async () => {
  const s = load();
  await s.focus();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].url, '/api/lock-session-check');
  assert.equal(s.calls[0].init.cache, 'no-store');
  assert.equal(s.calls[0].init.credentials, 'same-origin');
  assert.equal(s.calls[0].init.headers, undefined, '不再塞 Cache-Control 请求头（请求头管不到浏览器自己的 HTTP 缓存）');
});

test('204 会话有效：不跳', async () => {
  const s = load({ respond: { status: 204 } });
  await s.focus();
  assert.deepEqual(s.replaced, []);
});

test('401 带网关原因名：原样带上 why，参数顺序 lock → why → return（同网关 lockRedirect）', async () => {
  for (const why of ['no-cookie', 'invalid-session']) {
    const s = load({ respond: { status: 401, json: { ok: false, why } } });
    await s.focus();
    assert.equal(s.replaced.length, 1, why);
    const t = parse(s.replaced[0]);
    assert.equal(t.origin, 'https://styrigx.com');
    assert.equal(t.path, '/');
    assert.deepEqual(t.keys, ['lock', 'why', 'return']);
    assert.equal(t.p.get('lock'), '1');
    assert.equal(t.p.get('why'), why);
    assert.equal(t.p.get('return'), 'https://atlas.styrigx.com/blog/post/a/');
  }
});

test('401 没有 / 不认识的 why、或 body 不是 JSON：一律 invalid-session（不再用旧名 sig）', async () => {
  const bodies = [
    { status: 401, json: { ok: false } },
    { status: 401, json: { ok: false, why: 'sig' } },
    { status: 401, json: { ok: false, why: '__proto__' } },
    { status: 401, json: { ok: false, why: 1 } },
    { status: 401, json: null },
    { status: 401, json: () => Promise.reject(new SyntaxError('bad json')) },
  ];
  for (const b of bodies) {
    const s = load({ respond: b });
    await s.focus();
    assert.equal(s.replaced.length, 1);
    assert.equal(parse(s.replaced[0]).p.get('why'), 'invalid-session', JSON.stringify(b.json));
  }
  assert.doesNotMatch(src, /'sig'/);
});

test('回跳地址去掉已有的 lock / why / return，保留其他参数和 #hash', async () => {
  const href =
    'https://atlas.styrigx.com/blog/en/post/b/?lock=1&q=x&why=no-cookie&return=https%3A%2F%2Fatlas.styrigx.com%2Fblog%2F&page=2#sec';
  const s = load({ href, respond: { status: 401, json: { ok: false, why: 'no-cookie' } } });
  await s.focus();
  const ret = parse(s.replaced[0]).p.get('return');
  assert.equal(ret, 'https://atlas.styrigx.com/blog/en/post/b/?q=x&page=2#sec');
  /* 只有这三个参数时连 ? 一起去掉 */
  const s2 = load({
    href: 'https://atlas.styrigx.com/blog/?lock=1&why=invalid-session&return=%2F',
    respond: { status: 401, json: { ok: false, why: 'invalid-session' } },
  });
  await s2.focus();
  assert.equal(parse(s2.replaced[0]).p.get('return'), 'https://atlas.styrigx.com/blog/');
});

test('其他状态码 / 网络错误：不跳，下次再查', async () => {
  for (const respond of [{ status: 500 }, { status: 200, json: { ok: true } }, { status: 403 }, 'network']) {
    const s = load({ respond });
    await s.focus();
    assert.deepEqual(s.replaced, [], JSON.stringify(respond));
  }
});

test('节流 5 秒：5 秒内重复触发只问一次', async () => {
  const s = load();
  await s.focus();
  await s.focus();
  assert.equal(s.calls.length, 1);
  s.tick(5000);
  await s.focus();
  assert.equal(s.calls.length, 2);
});

test('触发时机：可见时 visibilitychange、focus、bfcache 恢复的 pageshow（普通 pageshow 不查）', async () => {
  const s = load();
  s.doc.visibilityState = 'hidden';
  s.docListeners.visibilitychange();
  assert.equal(s.calls.length, 0, '变为隐藏不查');
  s.doc.visibilityState = 'visible';
  s.docListeners.visibilitychange();
  assert.equal(s.calls.length, 1);
  s.tick(5000);
  s.winListeners.pageshow({ persisted: false });
  assert.equal(s.calls.length, 1);
  s.winListeners.pageshow({ persisted: true });
  assert.equal(s.calls.length, 2);
  assert.equal(typeof s.winListeners.focus, 'function');
});
