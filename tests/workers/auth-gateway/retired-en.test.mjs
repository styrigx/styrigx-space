/**
 * 旧 /en/…（P4-3 PR-4c 删除，不 301）由网关自己判 404（workers/auth-gateway/src/gate.js isRetiredEnPath / retiredEnNotFound）。
 * 原则（Gray 2026-11-07）：英文在根路径上是源，中文 /zh/ 是翻译层，/en/ 不该有任何产物或路由。
 *
 * 线上事故（2026-11-07，main 0ff16ebc 部署后）：解锁会话访问 https://styrigx.com/en/ 拿到 200 的旧英文首页
 * （源码 data-sgx-build="77ce4d6"，PR-4b 1/2 的产物，引用的 /css/ /js/ 指纹文件在当前部署里都已 404 → 首页小组件一直 "--"），
 * 而当时的生产产物里根本没有 en/。网关对有效会话的页面原样回源，回源链路上留着的旧 /en/ 副本就被放了出来。
 * 这里用 ASSETS 桩模拟「回源 /en/ 还能拿到旧首页」：修复前 /en/ 带会话 200 旧首页，修复后一律 404、不回源取 /en/ 地址。
 *
 * 运行：node --test tests/workers/auth-gateway/retired-en.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testLockSession } from './_tickets.mjs';
import { genKeyPair, makeAuthD1 } from '../_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const worker = (await import(REPO + '/workers/auth-gateway/src/app.js')).default;
const { isRetiredEnPath, NOT_FOUND_PROBE_PATH } = await import(REPO + '/workers/auth-gateway/src/gate.js');

const { priv: PRIV, pub: PUB } = await genKeyPair();
const CTX = { waitUntil() {} };

const STALE_EN_HOME = '<!DOCTYPE html><html lang="en" data-sgx-build="77ce4d6"><head><title>Space | Styrigx</title></head><body><div id="home-widgets">Sloan Gray</div></body></html>';
const NOT_FOUND_PAGE = '<!DOCTYPE html><html lang="en" data-sgx-build="0ff16eb"><head><title>404 Page not found | Styrigx</title></head><body><section class="sgx-404">Page not found</section></body></html>';
const HOME = '<!DOCTYPE html><html lang="en"><head><title>Space | Styrigx</title></head><body><div id="home-widgets">Sloan Gray</div></body></html>';

function env() {
  const seen = [];
  return {
    seen,
    SGX_ENV: 'production', SGX_SITE: 'space', SGX_LOCK_PUBLIC: PUB,
    KV_LOCK_DOOR: { async get() { return null; }, async put() {}, async delete() {} },
    D1_LOCK_AUTH: makeAuthD1({ epochs: { 'lock-epoch': 0 } }),
    ASSETS: {
      /* 回源桩：/en/… 还能拿到旧首页（线上那份旧副本）；/ 是当前首页；其余不存在的地址 = Pages 的 404.html（状态 404） */
      async fetch(req) {
        const p = new URL(req.url).pathname;
        seen.push(p);
        const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, must-revalidate' } });
        if (p === '/en/' || p === '/en' || p.startsWith('/en/')) return html(STALE_EN_HOME);
        if (p === '/') return html(HOME);
        return html(NOT_FOUND_PAGE, 404);
      },
    },
  };
}

async function sessionCookie() {
  return 'sgx-lock-session=' + (await testLockSession(PRIV, 0, 'password'));
}

const get = (e, p, cookie) => worker.fetch(new Request('https://styrigx.com' + p, { headers: cookie ? { Cookie: cookie } : {} }), e, CTX);

const EN_PATHS = ['/en/', '/en', '/en/about/', '/en/account/', '/en/security/lock/', '/en/status/', '/en/xyz-test/', '/EN/', '/En/about/', '/%65n/', '//en/', '/en/index.html', '/en/files-index.json', '/en/robots.txt', '/en/x.js', '/en/?return=/'];

test('isRetiredEnPath：/en、/en/… 及大小写 / 编码 / 多斜杠绕法都算；/zh/、根、/enx/、子站 /blog/en/ 不算', () => {
  for (const p of ['/en', '/en/', '/en/about/', '/EN/', '/%65n/', '//en/', '/en/a.js']) assert.equal(isRetiredEnPath(p), true, p);
  for (const p of ['/', '/zh/', '/zh/en/', '/enx/', '/env/', '/english/', '/blog/en/', '/about/', '/en.html']) assert.equal(isRetiredEnPath(p), false, p);
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
