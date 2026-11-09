/**
 * 旧 /en/…（P4-3 PR-4c 删除，不 301）由网关自己判 404（workers/space-core/src/gate.js isRetiredEnPath / retiredEnNotFound）。
 * 原则（Gray 2026-11-07）：英文在根路径上是源，中文 /zh/ 是翻译层，/en/ 不该有任何产物或路由。
 *
 * 线上事故（2026-11-07，main 0ff16ebc 部署后）：解锁会话访问 https://styrigx.com/en/ 拿到 200 的旧英文首页
 * （源码 data-sgx-build="77ce4d6"，PR-4b 1/2 的产物，引用的 /css/ /js/ 指纹文件在当前部署里都已 404 → 首页小组件一直 "--"），
 * 而当时的生产产物里根本没有 en/。网关对有效会话的页面原样回源，回源链路上留着的旧 /en/ 副本就被放了出来。
 * 这里用 ASSETS 桩模拟「回源 /en/ 还能拿到旧首页」：修复前 /en/ 带会话 200 旧首页，修复后一律 404、不回源取 /en/ 地址。
 *
 * 四站统一（Gray 2026-11-07：语言规则是通版）：子站 /blog/en/…、/curio/en/…、/daymark/en/… 同一条规则（gate.js retiredEnSitePrefix），
 * 由网关直接 404、取该站自己的 404 页（回源 /<站>/__sgx-not-found__/），有没有会话都一样；静态后缀（/blog/en/x.js）也不直通。
 * 只给主站判的旧版本上，子站这几组用例失败（有会话回源 200 旧页 / 没会话 302 锁屏 / 静态后缀直通回源）。
 *
 * 运行：node --test tests/workers/space-core/retired-en.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testLockSession } from './_tickets.mjs';
import { genKeyPair, makeAuthD1 } from '../_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const worker = (await import(REPO + '/workers/space-core/src/app.js')).default;
const { isRetiredEnPath, retiredEnSitePrefix, NOT_FOUND_PROBE_PATH } = await import(REPO + '/workers/space-core/src/gate.js');

const { priv: PRIV, pub: PUB } = await genKeyPair();
const CTX = { waitUntil() {} };

const STALE_EN_HOME = '<!DOCTYPE html><html lang="en" data-sgx-build="77ce4d6"><head><title>Space | Styrigx</title></head><body><div id="home-widgets">Sloan Gray</div></body></html>';
const NOT_FOUND_PAGE = '<!DOCTYPE html><html lang="en" data-sgx-build="0ff16eb"><head><title>404 Page not found | Styrigx</title></head><body><section class="sgx-404">Page not found</section></body></html>';
const HOME = '<!DOCTYPE html><html lang="en"><head><title>Space | Styrigx</title></head><body><div id="home-widgets">Sloan Gray</div></body></html>';

const staleSub = (s) => `<!DOCTYPE html><html lang="en" data-sgx-lock-session="valid" data-sgx-build="77ce4d6"><head><title>OLD ${s} en</title></head><body><main class="stale-${s}">old english ${s}</main></body></html>`;
const subNotFound = (s) => `<!DOCTYPE html><html lang="en" data-sgx-lock-session="valid"><head><title>404 | ${s}</title></head><body><section class="${s}-404">${s} page not found</section></body></html>`;
const subPage = (s, rest) => `<!DOCTYPE html><html lang="en"><head><title>${s}</title></head><body><main class="${s}-page">${s} ${rest}</main></body></html>`;

function env() {
  const seen = [];
  return {
    seen,
    SGX_ENV: 'production', SGX_SITE: 'space', SGX_SPACE_PUBLIC: PUB,
    KV_LOCK_DOOR: { async get() { return null; }, async put() {}, async delete() {} },
    D1_SPACE: makeAuthD1({ epochs: { 'lock-epoch': 0 } }),
    ASSETS: {
      /* 回源桩：/en/… 还能拿到旧首页（线上那份旧副本）；/ 是当前首页；其余不存在的地址 = Pages 的 404.html（状态 404） */
      async fetch(req) {
        const p = new URL(req.url).pathname;
        seen.push(p);
        const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, must-revalidate' } });
        if (p === '/en/' || p === '/en' || p.startsWith('/en/')) return html(STALE_EN_HOME);
        if (p === '/') return html(HOME);
        /* 子站：/<站>/en/… 也还能拿到旧页（同一类旧副本）；/<站>/ 下其余不存在的地址回该站自己的 404.html；普通页面 200 */
        const m = p.match(/^\/(blog|curio|daymark)(\/.*)?$/i);
        if (m) {
          const s = m[1].toLowerCase();
          const rest = m[2] || '/';
          if (/^\/en(\/|$)/i.test(rest)) return /\.js$/.test(rest) ? new Response('stale()', { headers: { 'Content-Type': 'text/javascript' } }) : html(staleSub(s));
          if (rest.startsWith('/__sgx-not-found__')) return html(subNotFound(s), 404);
          return html(subPage(s, rest));
        }
        return html(NOT_FOUND_PAGE, 404);
      },
    },
  };
}

async function sessionCookie() {
  return 'sgx-space-session=' + (await testLockSession(PRIV, 0, 'password'));
}

const get = (e, p, cookie) => worker.fetch(new Request('https://styrigx.com' + p, { headers: cookie ? { Cookie: cookie } : {} }), e, CTX);

const EN_PATHS = ['/en/', '/en', '/en/about/', '/en/account/', '/en/security/lock/', '/en/status/', '/en/xyz-test/', '/EN/', '/En/about/', '/%65n/', '//en/', '/en/index.html', '/en/files-index.json', '/en/robots.txt', '/en/x.js', '/en/?return=/'];

test('isRetiredEnPath：/en、/en/… 及大小写 / 编码 / 多斜杠绕法都算；/zh/、根、/enx/ 不算', () => {
  for (const p of ['/en', '/en/', '/en/about/', '/EN/', '/%65n/', '//en/', '/en/a.js']) assert.equal(isRetiredEnPath(p), true, p);
  for (const p of ['/', '/zh/', '/zh/en/', '/enx/', '/env/', '/english/', '/about/', '/en.html']) assert.equal(isRetiredEnPath(p), false, p);
});

test('四站同一个函数：/<站>/en… 及归一后等价写法都算，站前缀给对；误伤反例不算', () => {
  const hit = {
    '': ['/en/', '/EN', '//en//about/', '/blog/../en/'],
    '/blog': ['/blog/en', '/blog/en/', '/blog/EN/', '/blog/%65n/', '//blog//en/', '/BLOG/En/post/x/', '/blog/en/rss.xml', '/blog/en/x.js', '/%62log/en/', '/blog/./en/'],
    '/curio': ['/curio/en', '/curio/en/', '/Curio/EN/', '/curio/%65n/', '//curio//en//', '/curio/en/items/'],
    '/daymark': ['/daymark/en', '/daymark/en/', '/DAYMARK/en/', '/daymark/%65N/', '//daymark//en/', '/daymark/en/sitemap.xml'],
  };
  for (const [prefix, list] of Object.entries(hit)) {
    for (const p of list) {
      assert.equal(isRetiredEnPath(p), true, p);
      assert.equal(retiredEnSitePrefix(p), prefix, p);
    }
  }
  for (const p of [
    '/blog/', '/blog/english-post/', '/blog/post/en/', '/blog/zh/', '/blog/zh/en/', '/blog/env/', '/blog/en.html', '/blog/tags/en/',
    '/curio/', '/curio/enx/', '/curio/zh/en/', '/curio/api/en/', '/curio/api/items?lang=en',
    '/daymark/', '/daymark/entries/', '/daymark/api/en/', '/daymark/api/today', '/daymark/zh/',
    '/other/en/', '/blogs/en/', '/zh/blog/en/',
  ]) {
    assert.equal(isRetiredEnPath(p), false, p);
    assert.equal(retiredEnSitePrefix(p), null, p);
  }
});

const SUB_EN = {
  blog: ['/blog/en/', '/blog/en', '/blog/en/post/2026-09-27-invite-board/', '/blog/en/rss.xml', '/blog/EN/', '/blog/%65n/', '//blog//en/', '/BLOG/En/tags/ai/', '/blog/en/x.js'],
  curio: ['/curio/en/', '/curio/en', '/curio/en/items/', '/curio/EN/', '/curio/%65n/', '//curio//en/', '/curio/en/sitemap.xml', '/curio/en/app.js'],
  daymark: ['/daymark/en/', '/daymark/en', '/daymark/en/entries/', '/daymark/EN/', '/daymark/%65n/', '//daymark//en/', '/daymark/en/sitemap.xml'],
};

for (const [site, paths] of Object.entries(SUB_EN)) {
  for (const withSession of [true, false]) {
    test(`子站 ${site}：/${site}/en/…（含大小写 / 编码 / 多斜杠）${withSession ? '有' : '没'}会话一律 404 该站自己的 404 页，不 302 / 301、不回源取 /en/ 地址，no-store`, async () => {
      const c = withSession ? await sessionCookie() : undefined;
      for (const p of paths) {
        const e = env();
        const r = await get(e, p, c);
        assert.equal(r.status, 404, p + ' 应 404（修复前：有会话回源 200 旧页 / 没会话 302 锁屏 / 静态后缀直通）');
        assert.equal(r.headers.get('Location'), null, p + ' 不许带 Location');
        assert.equal(r.headers.get('Cache-Control'), 'private, no-store', p);
        assert.equal(r.headers.get('X-SGX-Runtime'), 'worker', p + ' 由网关回答');
        const html = await r.text();
        assert.match(html, new RegExp(site + ' page not found'), p + ' 应是该站自己的 404');
        assert.doesNotMatch(html, /old english|77ce4d6|stale\(\)/, p + ' 不许出旧页');
        assert.doesNotMatch(html, /data-sgx-lock-session/, p + ' 子站页面不带会话标记');
        assert.deepEqual(e.seen, ['/' + site + NOT_FOUND_PROBE_PATH], p + ' 回源只取该站的 404 探针：' + e.seen.join(','));
      }
    });
  }
}

test('子站：回源拿到的不是 HTML（或是跳转、或抛错）→ 纯文本 404，不带 Location', async () => {
  for (const bad of [
    async () => new Response(null, { status: 308, headers: { Location: '/blog/__sgx-not-found__' } }),
    async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    async () => { throw new Error('origin down'); },
  ]) {
    const e = env();
    e.ASSETS.fetch = bad;
    const r = await get(e, '/blog/en/', await sessionCookie());
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('Location'), null);
    assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(await r.text(), 'not found');
  }
});

test('子站误伤反例：/blog/english-post/、/curio/enx/、/daymark/zh/、/blog/post/en/ 照常走子站关口（有会话 200 正文，没会话 302 锁屏），静态后缀照常直通', async () => {
  const c = await sessionCookie();
  for (const p of ['/blog/english-post/', '/blog/post/en/', '/curio/enx/', '/curio/zh/', '/daymark/zh/', '/daymark/entries/', '/blog/tags/en/']) {
    const e = env();
    const r = await get(e, p, c);
    assert.equal(r.status, 200, p);
    assert.match(await r.text(), /-page">/, p);
    assert.deepEqual(e.seen, [p], p + ' 回源原地址');
    const r2 = await get(env(), p);
    assert.equal(r2.status, 302, p + ' 没会话 302 锁屏');
    assert.match(r2.headers.get('Location') || '', /^https:\/\/styrigx\.com\/\?lock=1&why=no-cookie&return=/, p);
  }
  const e = env();
  const js = await get(e, '/blog/english.js');
  assert.equal(js.status, 200);
  assert.deepEqual(e.seen, ['/blog/english.js']);
});

test('子站接口路径里的 en 段不被前缀规则命中：/curio/api/en/、/daymark/api/en/ 漏到网关时照旧 401 JSON（不是 404 页）', async () => {
  for (const p of ['/curio/api/en/', '/daymark/api/en/x', '/daymark/api/today?lang=en']) {
    const e = env();
    const r = await get(e, p);
    assert.equal(r.status, 401, p);
    assert.match(r.headers.get('Content-Type') || '', /application\/json/, p);
    assert.deepEqual(e.seen, [], p + ' 没会话不回源');
  }
});

test('有效会话：/en/…（含大小写 / 编码绕法）一律 404 的主站 404 页，不 301、不回源取 /en/ 地址，no-store', async () => {
  const c = await sessionCookie();
  for (const p of EN_PATHS) {
    const e = env();
    const r = await get(e, p, c);
    assert.equal(r.status, 404, p + ' 应 404（修复前回源拿到旧首页 200）');
    assert.equal(r.headers.get('Location'), null, p + ' 不许带 Location');
    assert.equal(r.headers.get('Cache-Control'), 'private, no-store', p);
    const html = await r.text();
    assert.match(html, /Page not found/, p);
    assert.doesNotMatch(html, /home-widgets|77ce4d6/, p + ' 不许出旧首页');
    assert.match(html, /<html data-sgx-lock-session="valid"/, p + ' 有效会话注入 valid（不出锁屏层）');
    assert.ok(e.seen.every((x) => !/^\/en(\/|$)/i.test(x)), p + ' 回源了 /en/ 地址：' + e.seen.join(','));
    assert.deepEqual(e.seen, [NOT_FOUND_PROBE_PATH], p);
  }
});

test('没会话：/en/… 同样直接 404（不 302 到锁屏；部署冒烟据此不带会话检查），注入 locked', async () => {
  for (const p of EN_PATHS) {
    const e = env();
    const r = await get(e, p);
    assert.equal(r.status, 404, p);
    assert.equal(r.headers.get('Location'), null, p);
    assert.equal(r.headers.get('Cache-Control'), 'private, no-store', p);
    const html = await r.text();
    assert.doesNotMatch(html, /home-widgets|77ce4d6/, p);
    assert.match(html, /data-sgx-lock-session="locked"/, p);
  }
});

test('回源拿到的不是 HTML（或是跳转）→ 纯文本 404，仍然不带 Location', async () => {
  const c = await sessionCookie();
  for (const bad of [
    () => new Response(null, { status: 308, headers: { Location: '/__sgx-not-found__' } }),
    () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ]) {
    const e = env();
    e.ASSETS.fetch = async () => bad();
    const r = await get(e, '/en/', c);
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('Location'), null);
    assert.equal(await r.text(), 'not found');
  }
});

test('不受影响：/ 和 /zh/ 照常 200，/enx/ 这类普通路径照常过会话（没会话 302 锁屏）', async () => {
  const c = await sessionCookie();
  const e = env();
  const home = await get(e, '/', c);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /home-widgets/);
  const r = await get(env(), '/enx/');
  assert.equal(r.status, 302);
  assert.match(r.headers.get('Location') || '', /\/\?lock=1&return=%2Fenx%2F$/);
});
