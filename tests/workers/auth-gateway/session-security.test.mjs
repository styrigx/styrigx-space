/**
 * 2.4.1 锁屏服务端安全测试（node --test）。
 *
 * 覆盖用例（对应 Gray 7 类修复的第 1/2/3/4/5/6 项中需要服务端断言的部分）：
 * - sgx-verified 设置/清除走同一函数、属性只定义一处（含 Domain=.styrigx.com）
 * - getLockEpoch：D1 出错 / 没绑抛错；新库当 0；每次读 D1 不缓存；bump 出错绝不写入；没有 KV 回落
 * - 纪元接口已删除（第 6 层）
 * - /api/lock-all-devices（2.8.0 独立 L2 API）：进门会话 → epoch+1、清 cookie 带 Domain、
 *   KV 出错 → 503 且不写入；临时钥匙进门的会话 → 403；无会话 → 401；旧三段式 cookie 无效
 * - gate.js：缺 SGX_LOCK_PUBLIC 时生产环境 fail closed（只放白名单）；
 *   过期 cookie 被拒；旧 epoch cookie 被拒；伪造签名被拒；
 *   未验证的非白名单路径 302 到 https://styrigx.com/?lock=1&return=<站内路径>
 *   （Cache-Control: no-store，不再返回 200 锁屏 HTML）；
 *   ?return= 只接受站内路径（/ 开头，非 //、/\），非法一律回首页 /；
 *   控制字符 / 反斜杠 / 编码绕过（/%09/evil.com 等）一律回首页；safeReturn 导出供复用
 * - /api/lock-session-check：有效会话 200 {ok:true}，否则 401
 * - 三个解锁接口（password/verify/passkey）成功时 Set-Cookie 属性齐全：
 *   Path=/、Secure、HttpOnly、SameSite=Lax、Domain=.styrigx.com
 *
 * 运行：node --test tests/kernel/
 * 说明：mock KV 只替代 Cloudflare KV（外部环境敏感项），被测的是自家逻辑；
 * Ed25519 测试密钥在测试内临时生成，不用生产密钥、不进仓库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  setLockSessionCookie,
  clearLockSessionCookie,
  signLockSessionTicket,
  parseLockSessionTicket,
  getLockEpoch,
  bumpLockEpoch,
  LOCK_SESSION_MAX_AGE,
} from '../../../workers/auth-gateway/src/core/lock-session.js';
import { b64urlEnc, ed25519Sign } from '../../../workers/auth-gateway/src/lib/crypto.js';
import { onRequestPost as pwPost } from '../../../workers/auth-gateway/src/api/lock-password.js';
import { onRequestPost as lockAllPost } from '../../../workers/auth-gateway/src/api/lock-all-devices.js';
import { onRequest as mw } from '../../../workers/auth-gateway/src/gate.js';
import { testLockSession } from './_tickets.mjs';
import { makeKV, genKeyPair, postReq, authD1For, forbiddenKV } from '../_harness.mjs';

/* ---------- mock KV ---------- */

/**
 * 网关存储：kv 只当作「上线前的 KV」（authD1For(kv) 模拟部署前跑过 space/scripts/migrate-kv-to-d1.mjs），
 * env 里只有三个 D1 绑定（同一个库），没有 KV。
 */
function stores(kv = makeKV()) {
  return { D1_LOCK_AUTH: authD1For(kv) , D1_LOCK_AUTH: authD1For(kv)};
}
/** 建一份 kv，并在它的 D1 替身里写好 lock-epoch */
function kvWithEpoch(n, seed) {
  const kv = makeKV(seed);
  authD1For(kv).setEpoch('lock-epoch', n);
  return kv;
}
const lockEpochOf = (kv) => authD1For(kv).epoch('lock-epoch');

/* ---------- Ed25519 测试密钥（临时生成） ---------- */

let TEST_PRIV_PEM = '';
let TEST_PUB_PEM = '';

async function genTestKeys() {
  ({ priv: TEST_PRIV_PEM, pub: TEST_PUB_PEM } = await genKeyPair());
}


/* 2.10.2：签发测试用 进门会话 cookie */
async function mintSessionCookie() {
  const { signLockSessionTicket } = await import('../../../workers/auth-gateway/src/core/lock-session.js');
  return await testLockSession(TEST_PRIV_PEM, 0, 'password');
}

/* 在 account-password 记录里预置密码 test-pass-12345（100000 次迭代与服务端一致） */
/* 2.11 定稿：seed lock-password（含 pepper），供 verify 测试用 */
async function seedPassword(kv, password = 'test-pass-12345') {
  const { makePasswordRecord } = await import('../../../workers/auth-gateway/src/core/password.js');
  const rec = await makePasswordRecord(password, 'test-pepper');
  authD1For(kv).putPassword('lock', rec);
}

/* ================================================================
 * 1. cookie 设置/清除统一
 * ================================================================ */

test('setLockSessionCookie 属性只定义一处（含 Domain=.styrigx.com）', async () => {
  await genTestKeys();
  const h = new Headers();
  setLockSessionCookie(h, '0.123.sig');
  const sc = h.get('Set-Cookie');
  assert.match(sc, /^sgx-lock-session=0\.123\.sig; /);
  assert.match(sc, /Domain=\.styrigx\.com/);
  assert.match(sc, /Path=\//);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Lax/);
  assert.match(sc, new RegExp(`Max-Age=${LOCK_SESSION_MAX_AGE}`));
  assert.equal(LOCK_SESSION_MAX_AGE, 43200);
});

test('clearLockSessionCookie 用相同 Domain/Path 并正确过期', () => {
  const h = new Headers();
  clearLockSessionCookie(h);
  const sc = h.get('Set-Cookie');
  assert.match(sc, /^sgx-lock-session=; /);
  assert.match(sc, /Domain=\.styrigx\.com/);
  assert.match(sc, /Path=\//);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Lax/);
  assert.match(sc, /Max-Age=0/);
  assert.match(sc, /Expires=Thu, 01 Jan 1970/);
});

/* ================================================================
 * 2. getLockEpoch / bumpLockEpoch（2026-10-27 起在 D1：d1-state.js readEpoch / bumpEpoch）
 * ================================================================ */

test('getLockEpoch：新库当 0；D1 有值返回值；上线前 KV 里的旧值由导入脚本 +1 写进 D1（不回退）', async () => {
  assert.equal(await getLockEpoch(stores()), 0);
  assert.equal(await getLockEpoch(stores(kvWithEpoch(7))), 7);
  const legacy = makeKV({ 'lock-epoch': '7' });
  assert.equal(await getLockEpoch(stores(legacy)), 8);
  assert.equal(await getLockEpoch(stores(legacy)), 8, '只导一次');
  assert.equal(legacy.store.get('lock-epoch'), '7', 'KV 旧值原样保留');
  assert.equal(legacy._calls.get, 0, '网关代码不读 KV');
});

test('getLockEpoch：读取出错抛错（D1 出错 / D1 没绑）；每次都读 D1，不缓存', async () => {
  const kv = makeKV();
  authD1For(kv).failOn = () => true;
  await assert.rejects(() => getLockEpoch(stores(kv)), /d1-fail/);
  await assert.rejects(() => getLockEpoch({}), /d1-missing/);
  /* env 里有 KV 也没用：没有回落 */
  await assert.rejects(() => getLockEpoch({ KV_LOCK_DOOR: makeKV({ 'lock-epoch': '3' }) }), /d1-missing/);
  const live = kvWithEpoch(2);
  assert.equal(await getLockEpoch(stores(live)), 2);
  authD1For(live).setEpoch('lock', 3);
  assert.equal(await getLockEpoch(stores(live)), 3, 'D1 一变，下一次读就是新值');
});

test('bumpLockEpoch：0→1，N→N+1（原子自增，两次并发推进拿到两个不同的值）；出错绝不写入', async () => {
  assert.equal(await bumpLockEpoch(stores()), 1);
  const kv = kvWithEpoch(4);
  assert.equal(await bumpLockEpoch(stores(kv)), 5);
  assert.equal(lockEpochOf(kv), 5);
  const got = await Promise.all([bumpLockEpoch(stores(kv)), bumpLockEpoch(stores(kv))]);
  assert.deepEqual(got.sort(), [6, 7]);
  assert.equal(lockEpochOf(kv), 7);

  const broken = kvWithEpoch(9);
  authD1For(broken).failOn = (sql) => /^UPDATE epoch/.test(sql);
  await assert.rejects(() => bumpLockEpoch(stores(broken)), /d1-fail/);
  /* 写入失败：原值不动（杜绝 epoch 变小） */
  assert.equal(lockEpochOf(broken), 9);
});

test('bumpLockEpoch：D1 没绑 → 抛错；env 里的 KV 碰一下就抛错也照常推进（不读不写 KV）', async () => {
  await assert.rejects(() => bumpLockEpoch({ KV_LOCK_DOOR: makeKV() }), /d1-missing/);
  const touched = [];
  const kv = kvWithEpoch(1);
  assert.equal(await bumpLockEpoch({ ...stores(kv), KV_LOCK_DOOR: forbiddenKV('KV_LOCK_DOOR', touched) }), 2);
  assert.equal(lockEpochOf(kv), 2);
  assert.deepEqual(touched, []);
});

/* ================================================================
 * 3. 纪元接口已删除（没有调用方；子站经网关 AuthVerifier 验票，网关自己核对纪元）
 * ================================================================ */

test('纪元接口已删除：路由表里没有，文件也不在', async () => {
  const { API_ROUTES } = await import('../../../workers/auth-gateway/src/router.js');
  assert.equal(API_ROUTES.has('/api/lock-epoch'), false);
  const fs = await import('node:fs');
  assert.equal(fs.existsSync(new URL('../../../workers/auth-gateway/src/api/lock-epoch.js', import.meta.url)), false);
});

/* ================================================================
 * owner-password：verify / lockout
 * ================================================================ */

test('password verify 通过：Set-Cookie 带 Domain=.styrigx.com（Ed25519 格式）', async () => {
  const kv = makeKV();
  await seedPassword(kv);
  const env = { D1_LOCK_AUTH: authD1For(kv), SGX_LOCK_PRIVATE: TEST_PRIV_PEM, SGX_PW_PEPPER: 'test-pepper' };
  const r = await pwPost({ request: postReq('https://styrigx.com/api/lock-password', { action: 'verify', password: 'test-pass-12345' }), env });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const sc = r.headers.get('Set-Cookie');
  assert.match(sc, /Domain=\.styrigx\.com/);
  assert.match(sc, /Max-Age=43200/);
  const parsed = parseLockSessionTicket(sc.split(';')[0].split('=')[1]);
  assert.ok(parsed);
  assert.equal(parsed.epoch, 0);
  assert.ok(parsed.exp > Date.now());
  assert.equal(parsed.sig.length > 10, true);
});

test('password verify：读 lock-epoch（D1）出错 → 503（不签发会话）', async () => {
  const kv = makeKV();
  await seedPassword(kv);
  /* 只让纪元的查询抛错 */
  authD1For(kv).failOn = (sql) => /FROM epoch|INTO epoch/.test(sql);
  const env = { D1_LOCK_AUTH: authD1For(kv), SGX_LOCK_PRIVATE: TEST_PRIV_PEM, SGX_PW_PEPPER: 'test-pepper' };
  const r = await pwPost({ request: postReq('https://styrigx.com/api/lock-password', { action: 'verify', password: 'test-pass-12345' }), env });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('Set-Cookie'), null);
});

test('password verify：密码错误 → 403（不签发）', async () => {
  const kv = makeKV();
  await seedPassword(kv);
  const env = { D1_LOCK_AUTH: authD1For(kv), SGX_LOCK_PRIVATE: TEST_PRIV_PEM, SGX_PW_PEPPER: 'test-pepper' };
  const r = await pwPost({ request: postReq('https://styrigx.com/api/lock-password', { action: 'verify', password: 'nope-nope-nope' }), env });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('Set-Cookie'), null);
});

/* ================================================================
 * /api/lock-all-devices（2.8.0：从 lock-password lockout 拆出的独立 L2 API）
 * ================================================================ */


test('lock-all-devices：临时钥匙进门、没有锁侧复验 → 403 reauth（epoch 不变；进门会话本身不算复验）', async () => {
  const kv = kvWithEpoch(2);
  const cookie = await testLockSession(TEST_PRIV_PEM, 2, 'tempkey');
  const env = { D1_LOCK_AUTH: authD1For(kv), SGX_LOCK_PUBLIC: TEST_PUB_PEM };
  const r = await lockAllPost({
    request: postReq('https://styrigx.com/api/lock-all-devices', {}, { 'Cookie': 'sgx-lock-session=' + cookie }),
    env,
  });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'reauth');
  assert.equal(lockEpochOf(kv), 2);
});

test('lock-all-devices：无会话 → 401', async () => {
  const kv = kvWithEpoch(2);
  const env = { D1_LOCK_AUTH: authD1For(kv), SGX_LOCK_PUBLIC: TEST_PUB_PEM };
  const r = await lockAllPost({
    request: postReq('https://styrigx.com/api/lock-all-devices', {}),
    env,
  });
  assert.equal(r.status, 401);
  assert.equal(lockEpochOf(kv), 2);
});

test('lock-all-devices：旧三段式 cookie → 401 无效', async () => {
  const kv = kvWithEpoch(2);
  const env = { D1_LOCK_AUTH: authD1For(kv), SGX_LOCK_PUBLIC: TEST_PUB_PEM };
  const r = await lockAllPost({
    request: postReq('https://styrigx.com/api/lock-all-devices', {}, { 'Cookie': 'sgx-lock-session=2.9999999999999.fakesig' }),
    env,
  });
  assert.equal(r.status, 401);
  assert.equal(lockEpochOf(kv), 2);
});


/* ================================================================
 * _middleware
 * ================================================================ */

function mwCtx(url, { cookie = '', env = {} } = {}) {
  const headers = {};
  if (cookie) headers['Cookie'] = 'sgx-lock-session=' + cookie;
  return {
    request: new Request(url, { headers }),
    next: async () => new Response('NEXT-BY-APP', { status: 200 }),
    env,
  };
}

const PROD_ENV = () => ({
  SGX_ENV: 'production',
  SGX_SITE: 'space',
  SGX_LOCK_PUBLIC: TEST_PUB_PEM,
  ...stores(),
});
const PROD_URL = 'https://styrigx.com/display/';

async function validCookie(epoch = 0, role = 'password') {
  return await testLockSession(TEST_PRIV_PEM, epoch, role);
}

test('middleware：生产环境缺 SGX_LOCK_PUBLIC → fail closed（非白名单 302 到首页锁屏）', async () => {
  const env = { SGX_ENV: 'production', SGX_SITE: 'space', ...stores() };
  const r = await mw(mwCtx(PROD_URL, { env }));
  assert.equal(r.status, 302);
  const loc = r.headers.get('Location');
  assert.ok(loc.startsWith('https://styrigx.com/?lock=1&return='));
  assert.equal(decodeURIComponent(loc.slice(loc.indexOf('return=') + 7)), '/display/');
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  /* 白名单路径放行 */
  const r2 = await mw(mwCtx('https://styrigx.com/api/lock-credentials', { env }));
  assert.equal(await r2.text(), 'NEXT-BY-APP');
  const r3 = await mw(mwCtx('https://styrigx.com/', { env }));
  assert.equal(await r3.text(), 'NEXT-BY-APP');
});

test('middleware：有公钥但无 cookie → 302 到首页锁屏；有效 cookie → 放行', async () => {
  const r = await mw(mwCtx(PROD_URL, { env: PROD_ENV() }));
  assert.equal(r.status, 302);
  assert.ok(r.headers.get('Location').startsWith('https://styrigx.com/?lock=1&return='));

  const r2 = await mw(mwCtx(PROD_URL, { cookie: await validCookie(0), env: PROD_ENV() }));
  assert.equal(await r2.text(), 'NEXT-BY-APP');
});

test('middleware：未带 cookie 访问内页 → 302，return 是站内路径', async () => {
  const target = 'https://styrigx.com/browser/?x=1';
  const r = await mw(mwCtx(target, { env: PROD_ENV() }));
  assert.equal(r.status, 302);
  const loc = r.headers.get('Location');
  assert.ok(loc.startsWith('https://styrigx.com/?lock=1&return='));
  /* return 解码后是站内路径（含 query），不是完整 URL */
  assert.equal(decodeURIComponent(loc.slice(loc.indexOf('return=') + 7)), '/browser/?x=1');
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
});

test('middleware：有效签名 cookie 访问内页 → 200 正文（不是锁屏）', async () => {
  const r = await mw(mwCtx(PROD_URL, { cookie: await validCookie(0), env: PROD_ENV() }));
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'NEXT-BY-APP');
  assert.equal(r.headers.get('Location'), null);
});

test('middleware：已锁时主站头像 /avatar/<尺寸>.webp → 200 放行（不 302）', async () => {
  for (const sz of [32, 96, 192, 512]) {
    const r = await mw(mwCtx('https://styrigx.com/avatar/' + sz + '.webp', { env: PROD_ENV() }));
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'NEXT-BY-APP');
  }
  /* 不认识的尺寸不放行 */
  const r2 = await mw(mwCtx('https://styrigx.com/avatar/64.webp', { env: PROD_ENV() }));
  assert.equal(r2.status, 302);
});

test('middleware：已锁时其他 /images/*.webp → 302 到锁屏（不整体放行 webp）', async () => {
  /* 旧的 Hugo 头像路径也不再放行 */
  const r0 = await mw(mwCtx('https://styrigx.com/images/avatar_hu_abc123_56x56_fill_q75_box_smart1.webp', { env: PROD_ENV() }));
  assert.equal(r0.status, 302);
  const r = await mw(mwCtx('https://styrigx.com/images/some-photo_hu_abc123.webp', { env: PROD_ENV() }));
  assert.equal(r.status, 302);
  assert.ok(r.headers.get('Location').startsWith('https://styrigx.com/?lock=1&return='));
  /* 非 avatar_ 开头的 avif 也一样 */
  const r2 = await mw(mwCtx('https://styrigx.com/images/banner.avif', { env: PROD_ENV() }));
  assert.equal(r2.status, 302);
});

test('middleware：过期 cookie 被拒（302 到首页锁屏）', async () => {
  const payload = '0.' + (Date.now() - 1000);
  const sig = await ed25519Sign(TEST_PRIV_PEM, payload);
  const env = PROD_ENV();
  const r = await mw(mwCtx(PROD_URL, { cookie: payload + '.' + sig, env }));
  assert.equal(r.status, 302);
  assert.ok(r.headers.get('Location').startsWith('https://styrigx.com/?lock=1&return='));
});

test('middleware：伪造签名被拒（302 到首页锁屏）', async () => {
  const env = PROD_ENV();
  const r = await mw(mwCtx(PROD_URL, { cookie: '0.9999999999999.badsig', env }));
  assert.equal(r.status, 302);
  assert.ok(r.headers.get('Location').startsWith('https://styrigx.com/?lock=1&return='));
});

test('middleware：lockout 后旧 epoch cookie 失效', async () => {
  const kv = kvWithEpoch(0);
  const env = { SGX_ENV: 'production', SGX_SITE: 'space', SGX_LOCK_PUBLIC: TEST_PUB_PEM, D1_LOCK_AUTH: authD1For(kv) };
  const oldCookie = await testLockSession(TEST_PRIV_PEM, 0, 'password');
  /* 旧 cookie 有效 */
  const r1 = await mw(mwCtx(PROD_URL, { cookie: oldCookie, env }));
  assert.equal(await r1.text(), 'NEXT-BY-APP');
  /* bump（模拟 lockout） */
  await bumpLockEpoch(env);
  /* 旧 cookie 失效 → 302 到首页锁屏 */
  const r2 = await mw(mwCtx(PROD_URL, { cookie: oldCookie, env }));
  assert.equal(r2.status, 302);
  assert.ok(r2.headers.get('Location').startsWith('https://styrigx.com/?lock=1&return='));
  /* 新 cookie 有效 */
  const newCookie = await testLockSession(TEST_PRIV_PEM, 1, 'password');
  const r3 = await mw(mwCtx(PROD_URL, { cookie: newCookie, env }));
  assert.equal(await r3.text(), 'NEXT-BY-APP');
});

test('middleware：SGX_ENV 显式写成非生产值才不锁', async () => {
  for (const name of ['development', 'test', 'preview']) {
    const r = await mw(mwCtx('http://localhost:8931/display/', { env: { SGX_ENV: name } }));
    assert.equal(await r.text(), 'NEXT-BY-APP', name);
  }
});

test('middleware：缺 SGX_ENV 或写错 → 按生产处理（fail closed），任何 host 都不放行', async () => {
  for (const env of [{}, { SGX_ENV: '' }, { SGX_ENV: 'prod' }, { SGX_ENV: 'Preview' }]) {
    const local = await mw(mwCtx('http://localhost:8931/display/', { env }));
    assert.equal(local.status, 301, JSON.stringify(env));
    assert.equal(local.headers.get('Location'), 'https://styrigx.com/display/');
    const api = await mw(mwCtx('https://passkey-e2e.styrigx-space.pages.dev/api/lock-credentials', { env }));
    assert.equal(api.status, 403, JSON.stringify(env));
  }
  /* 正式域名缺 SGX_ENV：照常走会话检查（缺公钥 → 302 锁屏） */
  const r = await mw(mwCtx(PROD_URL, { env: { SGX_SITE: 'space', ...stores() } }));
  assert.equal(r.status, 302);
  assert.ok(r.headers.get('Location').startsWith('https://styrigx.com/?lock=1&return='));
});

test('middleware：styrigx-space.pages.dev → 301 到 https://styrigx.com（保留 path+query，no-store）', async () => {
  const r = await mw(mwCtx('https://styrigx-space.pages.dev/store/?a=1', { env: {} }));
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('Location'), 'https://styrigx.com/store/?a=1');
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
});

test('middleware：pages.dev 根路径 → 301 到 https://styrigx.com/', async () => {
  const r = await mw(mwCtx('https://styrigx-space.pages.dev/', { env: {} }));
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('Location'), 'https://styrigx.com/');
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
});

test('middleware：分支预览别名 xxx.styrigx-space.pages.dev + SGX_ENV=preview → 不跳转（放行）', async () => {
  const r = await mw(mwCtx('https://feat-xyz.styrigx-space.pages.dev/store/', { env: { SGX_ENV: 'preview' } }));
  /* 非生产环境：放行到 next()，不做 pages.dev 跳转 */
  assert.equal(await r.text(), 'NEXT-BY-APP');
});

test('middleware：正式域名 styrigx.com → 不走 pages.dev 跳转（走正常锁屏逻辑）', async () => {
  const r = await mw(mwCtx('https://styrigx.com/store/', { env: PROD_ENV() }));
  /* 无 cookie：走锁屏 302，不是 pages.dev 的 301 */
  assert.equal(r.status, 302);
  assert.ok(r.headers.get('Location').startsWith('https://styrigx.com/?lock=1&return='));
});

test('middleware：?return= 只接受站内路径，非法一律回首页 /', async () => {
  const env = PROD_ENV();
  const cookie = await validCookie(0);

  async function tryReturn(ret) {
    const r = await mw(mwCtx(
      'https://styrigx.com/?lock=1&return=' + encodeURIComponent(ret),
      { cookie, env }
    ));
    return r;
  }

  /* 合法站内路径 → 302 到该路径，带 no-store（2.4.1 锁屏原则） */
  let r = await tryReturn('/display/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), '/display/');
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store');

  r = await tryReturn('/browser/?x=1');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), '/browser/?x=1');
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store');

  /* 白名单跨站 URL（https://*.styrigx.com）→ 302 到该 URL */
  r = await tryReturn('https://styrigx.com/display/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), 'https://styrigx.com/display/');

  r = await tryReturn('https://blog-preview.styrigx.com/post/abc/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), 'https://blog-preview.styrigx.com/post/abc/');

  r = await tryReturn('https://styrigx.com/daymark/zh/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), 'https://styrigx.com/daymark/zh/');

  /* 已下线的旧子域名、旧图志（P4-3 PR-1 删掉 301、域名下线，仍在回跳黑名单里）→ 回首页 */
  for (const h of ['blog.styrigx.com', 'daymark.styrigx.com', 'curio.styrigx.com', 'atlas.styrigx.com']) {
    r = await tryReturn('https://' + h + '/');
    assert.equal(r.headers.get('Location'), '/', h);
  }

  /* 已下线的书库（book / book-preview）→ 回首页 */
  r = await tryReturn('https://book.styrigx.com/');
  assert.equal(r.headers.get('Location'), '/');
  r = await tryReturn('https://book-preview.styrigx.com/read/');
  assert.equal(r.headers.get('Location'), '/');

  /* 外部域名 → 回首页 */
  r = await tryReturn('https://evil.com/');
  assert.equal(r.headers.get('Location'), '/');

  /* 后缀欺骗 → 回首页 */
  r = await tryReturn('https://styrigx.com.evil.com/');
  assert.equal(r.headers.get('Location'), '/');

  /* http（非 https）→ 回首页 */
  r = await tryReturn('http://styrigx.com/blog/');
  assert.equal(r.headers.get('Location'), '/');

  /* 带 userinfo → 回首页 */
  r = await tryReturn('https://user@styrigx.com/');
  assert.equal(r.headers.get('Location'), '/');

  /* URL 里含反斜杠 → 回首页 */
  r = await tryReturn('https://styrigx.com/\\evil');
  assert.equal(r.headers.get('Location'), '/');

  /* 协议相对 URL → 回首页 */
  r = await tryReturn('//evil.com/');
  assert.equal(r.headers.get('Location'), '/');

  /* 反斜杠 trick → 回首页 */
  r = await tryReturn('/\\evil.com/');
  assert.equal(r.headers.get('Location'), '/');

  /* javascript: → 回首页 */
  r = await tryReturn('javascript:alert(1)');
  assert.equal(r.headers.get('Location'), '/');

  /* 无会话时不跳转（走正常锁流程，'/' 白名单放行） */
  r = await mw(mwCtx(
    'https://styrigx.com/?lock=1&return=' + encodeURIComponent('/display/'),
    { env }
  ));
  assert.equal(r.headers.get('Location'), null);
  assert.equal(await r.text(), 'NEXT-BY-APP');
});

test('middleware：首页 ?return=子站&why= + 有效会话 → 200 不 302（防主站↔子站死循环）', async () => {
  const env = PROD_ENV();
  const cookie = await validCookie(0);
  const url = 'https://styrigx.com/?lock=1&return=' + encodeURIComponent('https://styrigx.com/daymark/') + '&why=sig';
  const r = await mw(mwCtx(url, { cookie, env }));
  /* L1 不 302：返回 200 首页，让 lock.js 显示失败原因，而不是在主站↔子站间无限跳转 */
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Location'), null);
  assert.equal(await r.text(), 'NEXT-BY-APP');
});

test('middleware：首页 ?return=子站（无 why）+ 有效会话 → 302 回子站（原有行为不变）', async () => {
  const env = PROD_ENV();
  const cookie = await validCookie(0);
  const url = 'https://styrigx.com/?lock=1&return=' + encodeURIComponent('https://styrigx.com/daymark/');
  const r = await mw(mwCtx(url, { cookie, env }));
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), 'https://styrigx.com/daymark/');
});

test('middleware：无有效会话访问内页 → 302 到首页锁屏（return 为站内路径）', async () => {
  const env = PROD_ENV();
  const original = 'https://styrigx.com/display/?x=1';
  const r = await mw(mwCtx(original, { env }));
  assert.equal(r.status, 302);
  const loc = r.headers.get('Location');
  assert.ok(loc.startsWith('https://styrigx.com/?lock=1&return='));
  /* return 解码后是站内路径 */
  assert.equal(decodeURIComponent(loc.slice(loc.indexOf('return=') + 7)), '/display/?x=1');
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
});

/* ================================================================
 * /api/lock-session-check（2.4.1 防循环）
 * ================================================================ */

/* lock-session-check 的 200 / 401 契约（锁屏密码进门、临时钥匙进门、无会话、旧三段式坏票）2026-10-26 并进
 * auth-flow-2026-10-21.test.mjs 的 B 段（经真实网关入口，断言逐条保留），这里不再重复。 */

/* ================================================================
 * 三个解锁接口：成功时 Set-Cookie 属性（2.4.1 会话诊断）
 * ================================================================ */

function assertSessionCookieAttrs(sc, maxAge) {
  assert.ok(sc, '必须带 Set-Cookie');
  assert.match(sc, /^sgx-lock-session=/);
  assert.match(sc, /Path=\//);
  assert.match(sc, /Secure/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  assert.match(sc, /Domain=\.styrigx\.com/);
  /* 2.8.0：锁屏密码 / 通行密钥进门 43200，临时钥匙进门按钥匙剩余时间 */
  const expected = maxAge || '43200';
  assert.match(sc, new RegExp('Max-Age=' + expected));
}

test('password verify 通过：Set-Cookie 属性齐全（Path/Secure/HttpOnly/SameSite=Lax）', async () => {
  const kv = makeKV();
  await seedPassword(kv);
  const env = { D1_LOCK_AUTH: authD1For(kv), SGX_LOCK_PRIVATE: TEST_PRIV_PEM, SGX_PW_PEPPER: 'test-pepper' };
  const r = await pwPost({ request: postReq('https://styrigx.com/api/lock-password', { action: 'verify', password: 'test-pass-12345' }), env });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assertSessionCookieAttrs(r.headers.get('Set-Cookie'));
});

test('临时 LockKey 进门通过：Set-Cookie 属性齐全（v2 进站会话 by=tempkey、带 tempkeyId，Max-Age = 剩余时间封顶 12 小时；没有 sgx-tk）', async () => {
  const { onRequestPost: tkPost } = await import('../../../workers/auth-gateway/src/api/lock-tempkey-unlock.js');
  const { createTempkey } = await import('../../../workers/auth-gateway/src/core/lock-tempkey.js');
  const kv = makeKV();
  const { code } = await createTempkey(stores(kv), 'test-pepper', { name: '', ms: 30 * 24 * 3600 * 1000 });
  const env = { D1_LOCK_AUTH: authD1For(kv), SGX_LOCK_PRIVATE: TEST_PRIV_PEM, SGX_PW_PEPPER: 'test-pepper' };
  const r = await tkPost({ request: postReq('https://styrigx.com/api/lock-tempkey-unlock', { code }), env });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const all = r.headers.getSetCookie();
  const sc = all.find((c) => c.startsWith('sgx-lock-session=') && c.includes('Domain='));
  assertSessionCookieAttrs(sc, '43200');
  /* LockSessionTicket v2：by.epoch.exp.tempkeyId.sig */
  const parts = sc.split(';')[0].slice('sgx-lock-session='.length).split('.');
  assert.equal(parts.length, 5);
  assert.equal(parts[0], 'tempkey');
  assert.match(parts[1], /^\d+$/, 'epoch');
  assert.match(parts[2], /^\d+$/, 'exp');
  assert.match(parts[3], /^[A-Za-z0-9_-]{16}$/, 'tempkeyId');
  assert.ok(!all.some((c) => c.startsWith('sgx-tk=')), '钥匙票已并入会话');
});

test('passkey auth 通过：Set-Cookie 属性齐全', async () => {
  const { onRequestPost: pkPost } = await import('../../../workers/auth-gateway/src/api/lock-passkey.js');
  const b64url = (buf) => Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  /* 生成测试用 ECDSA P-256 密钥对，写入 KV（模拟已注册的通行密钥） */
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const credId = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const kv = makeKV();
  authD1For(kv).putPasskey('lock', {
    name: 'test-key', credId, publicKey: jwk, signCount: 0, uv: 1,
    createdAt: Date.now(), lastUsedAt: 0,
  });
  /* 预置 auth challenge */
  const cid = 'test-cid-' + Date.now();
  const challenge = b64url(crypto.getRandomValues(new Uint8Array(32)));
  authD1For(kv).putChallenge('lock', cid, 'auth', challenge, Date.now() + 60000);

  const env = {
    D1_LOCK_AUTH: authD1For(kv),
    SGX_LOCK_PRIVATE: TEST_PRIV_PEM,
    SGX_RP_ID: 'styrigx.com',
    SGX_ORIGIN: 'https://styrigx.com',
  };

  /* 构造 WebAuthn 断言 */
  const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('styrigx.com')));
  const authData = new Uint8Array(37);
  authData.set(rpIdHash, 0);
  authData[32] = 0x05; /* UP + UV */
  authData[36] = 1; /* signCount = 1 */
  const clientData = { type: 'webauthn.get', challenge, origin: 'https://styrigx.com' };
  const clientDataJSON = new TextEncoder().encode(JSON.stringify(clientData));
  const cdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
  const sigBase = new Uint8Array(authData.length + cdHash.length);
  sigBase.set(authData, 0);
  sigBase.set(cdHash, authData.length);
  const sigDer = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, sigBase);
  /* Node 的 WebCrypto ECDSA 签名是 raw r||s（64 字节），服务端要 DER，先转一下 */
  const rawSig = new Uint8Array(sigDer);
  const rB = rawSig.slice(0, 32);
  const sB = rawSig.slice(32, 64);
  const trim = (v) => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    v = v.slice(i);
    /* DER 整数高位置 1 时前面补 0x00 */
    if (v[0] >= 0x80) {
      const w = new Uint8Array(v.length + 1);
      w.set(v, 1);
      return w;
    }
    return v;
  };
  const rT = trim(rB), sT = trim(sB);
  const derLen = 2 + rT.length + 2 + sT.length;
  const der = new Uint8Array(2 + derLen);
  let o = 0;
  der[o++] = 0x30; der[o++] = derLen;
  der[o++] = 0x02; der[o++] = rT.length; der.set(rT, o); o += rT.length;
  der[o++] = 0x02; der[o++] = sT.length; der.set(sT, o);
  const sigDerB64 = b64url(der);

  const body = {
    action: 'auth',
    cid,
    credential: {
      id: credId,
      rawId: credId,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: sigDerB64,
        userHandle: null,
      },
      type: 'public-key',
    },
  };
  const r = await pkPost({ request: postReq('https://styrigx.com/api/lock-passkey', body), env });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assertSessionCookieAttrs(r.headers.get('Set-Cookie'));
});

/* ================================================================
 * 2.4.1-diag：fail-closed 签发 + 临时自检接口
 * ================================================================ */

/* ---------- issueLockSession 单元 ---------- */

test('diag: issueLockSession 无 SGX_LOCK_PRIVATE → 500 no-session-key（不签发）', async () => {
  const { issueLockSession } = await import('../../../workers/auth-gateway/src/core/lock-session.js');
  const headers = new Headers();
  const err = await issueLockSession({ ...stores() }, headers, { by: 'password', role: 'password' });
  assert.deepEqual(err, { status: 500, body: { ok: false, error: 'no-session-key' } });
  assert.equal(headers.get('Set-Cookie'), null);
});

test('diag: issueLockSession 私钥格式错误 → 500 session-sign-failed', async () => {
  const { issueLockSession } = await import('../../../workers/auth-gateway/src/core/lock-session.js');
  const headers = new Headers();
  const err = await issueLockSession({ ...stores(), SGX_LOCK_PRIVATE: 'not-a-key' }, headers, { by: 'password', role: 'password' });
  assert.deepEqual(err, { status: 500, body: { ok: false, error: 'session-sign-failed' } });
  assert.equal(headers.get('Set-Cookie'), null);
});

test('diag: issueLockSession 读纪元出错（D1）→ 503（不签发）', async () => {
  const { issueLockSession } = await import('../../../workers/auth-gateway/src/core/lock-session.js');
  const headers = new Headers();
  const kv = makeKV();
  authD1For(kv).failOn = () => true;
  const err = await issueLockSession({ ...stores(kv), SGX_LOCK_PRIVATE: TEST_PRIV_PEM }, headers, { by: 'password', role: 'password' });
  assert.equal(err.status, 503);
  assert.deepEqual(err.body, { ok: false, error: 'server' });
  assert.equal(headers.get('Set-Cookie'), null);
});

test('diag: issueLockSession 正常 → null 且 Set-Cookie 已设置', async () => {
  const { issueLockSession, LOCK_SESSION_COOKIE } = await import('../../../workers/auth-gateway/src/core/lock-session.js');
  assert.equal(LOCK_SESSION_COOKIE, 'sgx-lock-session');
  const headers = new Headers();
  const err = await issueLockSession({ ...stores(), SGX_LOCK_PRIVATE: TEST_PRIV_PEM }, headers, { by: 'password', role: 'password' });
  assert.equal(err, null);
  assert.match(headers.get('Set-Cookie'), /^sgx-lock-session=[^;]+; /);
});

/* ---------- 三解锁接口 fail-closed ---------- */

test('diag: password verify 无 SGX_LOCK_PRIVATE → 500 no-session-key（不是 ok:true）', async () => {
  const kv = makeKV();
  await seedPassword(kv);
  const env = { D1_LOCK_AUTH: authD1For(kv), SGX_PW_PEPPER: 'test-pepper' };
  const r = await pwPost({ request: postReq('https://styrigx.com/api/lock-password', { action: 'verify', password: 'test-pass-12345' }), env });
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { ok: false, error: 'no-session-key' });
  assert.equal(r.headers.get('Set-Cookie'), null);
});

test('diag: 临时 LockKey 进门 无 SGX_LOCK_PRIVATE → 500 no-session-key，不下发 cookie', async () => {
  const { onRequestPost: tkPost } = await import('../../../workers/auth-gateway/src/api/lock-tempkey-unlock.js');
  const { createTempkey } = await import('../../../workers/auth-gateway/src/core/lock-tempkey.js');
  const kv = makeKV();
  const { code } = await createTempkey(stores(kv), 'test-pepper', { name: '', ms: 3600 * 1000 });
  const env = { D1_LOCK_AUTH: authD1For(kv), SGX_PW_PEPPER: 'test-pepper' };
  const r = await tkPost({ request: postReq('https://styrigx.com/api/lock-tempkey-unlock', { code }), env });
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { ok: false, error: 'no-session-key' });
  assert.equal(r.headers.get('Set-Cookie'), null);
});

/* 构造一次有效的 passkey auth 请求体（WebAuthn 断言在测试内真实生成） */
async function buildPasskeyAuthFixture() {
  const b64url = (buf) => Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const credId = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const kv = makeKV();
  authD1For(kv).putPasskey('lock', {
    name: 'test-key', credId, publicKey: jwk, signCount: 0, uv: 1,
    createdAt: Date.now(), lastUsedAt: 0,
  });
  const cid = 'test-cid-' + Date.now() + Math.random();
  const challenge = b64url(crypto.getRandomValues(new Uint8Array(32)));
  authD1For(kv).putChallenge('lock', cid, 'auth', challenge, Date.now() + 60000);

  const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('styrigx.com')));
  const authData = new Uint8Array(37);
  authData.set(rpIdHash, 0);
  authData[32] = 0x05;
  authData[36] = 1;
  const clientData = { type: 'webauthn.get', challenge, origin: 'https://styrigx.com' };
  const clientDataJSON = new TextEncoder().encode(JSON.stringify(clientData));
  const cdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
  const sigBase = new Uint8Array(authData.length + cdHash.length);
  sigBase.set(authData, 0);
  sigBase.set(cdHash, authData.length);
  const sigDer = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, sigBase);
  const rawSig = new Uint8Array(sigDer);
  const trim = (v) => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    v = v.slice(i);
    if (v[0] >= 0x80) { const n = new Uint8Array(v.length + 1); n.set(v, 1); v = n; }
    return v;
  };
  const rB = trim(rawSig.slice(0, 32)), sB = trim(rawSig.slice(32, 64));
  const derLen = 2 + rB.length + 2 + sB.length;
  const der = new Uint8Array(2 + derLen);
  let o = 0;
  der[o++] = 0x30; der[o++] = derLen;
  der[o++] = 0x02; der[o++] = rB.length; der.set(rB, o); o += rB.length;
  der[o++] = 0x02; der[o++] = sB.length; der.set(sB, o);

  const body = {
    action: 'auth', cid,
    credential: {
      id: credId, rawId: credId,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(der),
        userHandle: null,
      },
      type: 'public-key',
    },
  };
  return { kv, body };
}

test('diag: passkey auth 无 SGX_LOCK_PRIVATE → 500 no-session-key（不被吞成 403）', async () => {
  const { onRequestPost: pkPost } = await import('../../../workers/auth-gateway/src/api/lock-passkey.js');
  const { kv, body } = await buildPasskeyAuthFixture();
  const env = {
    D1_LOCK_AUTH: authD1For(kv),
    SGX_RP_ID: 'styrigx.com',
    SGX_ORIGIN: 'https://styrigx.com',
  };
  const r = await pkPost({ request: postReq('https://styrigx.com/api/lock-passkey', body), env });
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { ok: false, error: 'no-session-key' });
  assert.equal(r.headers.get('Set-Cookie'), null);
});

test('diag: passkey auth 私钥格式错误 → 500 session-sign-failed（不被吞成 403）', async () => {
  const { onRequestPost: pkPost } = await import('../../../workers/auth-gateway/src/api/lock-passkey.js');
  const { kv, body } = await buildPasskeyAuthFixture();
  const env = {
    D1_LOCK_AUTH: authD1For(kv),
    SGX_LOCK_PRIVATE: 'not-a-valid-key',
    SGX_RP_ID: 'styrigx.com',
    SGX_ORIGIN: 'https://styrigx.com',
  };
  const r = await pkPost({ request: postReq('https://styrigx.com/api/lock-passkey', body), env });
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { ok: false, error: 'session-sign-failed' });
  assert.equal(r.headers.get('Set-Cookie'), null);
});

/* ---------- 写入/读取对账 ---------- */

test('diag: 写入/读取对账：signLockSessionTicket 签发的 cookie 能被 middleware 验签放行', async () => {
  const { LOCK_SESSION_COOKIE } = await import('../../../workers/auth-gateway/src/core/lock-session.js');
  assert.equal(LOCK_SESSION_COOKIE, 'sgx-lock-session');
  const cv = await testLockSession(TEST_PRIV_PEM, 0, 'password');
  /* LockSessionTicket v2：by.epoch.exp.tempkeyId.sig（不是临时钥匙进门时 tempkeyId 为空串） */
  assert.equal(cv.split('.').length, 5);
  assert.ok(cv.startsWith('password.0.'));
  assert.equal(cv.split('.')[3], '');
  const r = await mw(mwCtx(PROD_URL, { cookie: cv, env: PROD_ENV() }));
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'NEXT-BY-APP');
});

/* ================================================================
 * 2.4.1-cookie-dedup：同名 cookie 去重 + 旧主机绑定 cookie 清除 + /api/* 401
 * ================================================================ */

function mwCtxMultiCookie(url, cookieHeader, env) {
  return {
    request: new Request(url, { headers: { 'Cookie': cookieHeader } }),
    next: async () => new Response('NEXT-BY-APP', { status: 200 }),
    env,
  };
}

test('dedup: 旧主机绑定 cookie 在前、新 cookie 在后 → 新的有效即放行', async () => {
  const good = await validCookie(0);
  /* 模拟浏览器行为：旧版无 Domain 的 sgx-lock-session=1 和新版带 Domain 的并存 */
  const header = 'sgx-lock-session=1; sgx-lock-session=' + good;
  const r = await mw(mwCtxMultiCookie(PROD_URL, header, PROD_ENV()));
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'NEXT-BY-APP');
});

test('dedup: 新 cookie 在前、旧的在后 → 同样放行', async () => {
  const good = await validCookie(0);
  const header = 'sgx-lock-session=' + good + '; sgx-lock-session=1';
  const r = await mw(mwCtxMultiCookie(PROD_URL, header, PROD_ENV()));
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'NEXT-BY-APP');
});

test('dedup: 两个同名 cookie 都无效 → 拒绝（302）', async () => {
  const header = 'sgx-lock-session=1; sgx-lock-session=bad.value.here';
  const r = await mw(mwCtxMultiCookie(PROD_URL, header, PROD_ENV()));
  assert.equal(r.status, 302);
  assert.ok(r.headers.get('Location').startsWith('https://styrigx.com/?lock=1&return='));
});

test('setLockSessionCookie 只下发一条 Set-Cookie（新 cookie 名没有旧主机绑定残留，不再另发清除头）', async () => {
  await genTestKeys();
  const h = new Headers();
  setLockSessionCookie(h, '0.123.sig');
  const all = h.getSetCookie();
  assert.equal(all.length, 1);
  assert.match(all[0], /^sgx-lock-session=0\.123\.sig; /);
  assert.match(all[0], /Domain=\.styrigx\.com/);
  assert.match(all[0], /SameSite=Lax/);
});

test('clearLockSessionCookie 下发一条清除头（带 Domain）', () => {
  const h = new Headers();
  clearLockSessionCookie(h);
  const all = h.getSetCookie();
  assert.equal(all.length, 1);
  assert.match(all[0], /^sgx-lock-session=; /);
  assert.match(all[0], /Domain=\.styrigx\.com/);
  assert.match(all[0], /Max-Age=0/);
});

test('dedup: 未登录请求 /api/xxx → 401 JSON，不是 302', async () => {
  const r = await mw(mwCtx('https://styrigx.com/api/some-endpoint', { env: PROD_ENV() }));
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('Location'), null);
  const j = await r.json();
  assert.equal(j.ok, false);
});

test('dedup: /api/diag/session 已删除 → 404（不是 302 到锁屏）', async () => {
  /* diag 目录已删，Cloudflare 会返回 404；middleware 不应 302 拦截 /api/* */
  const r = await mw(mwCtx('https://styrigx.com/api/diag/session', { env: PROD_ENV() }));
  /* middleware 对未验证的 /api/* 返回 401（路由本身不存在时由平台返回 404，
     这里断言 middleware 不 302） */
  assert.ok(r.status === 401 || r.status === 404);
  assert.equal(r.headers.get('Location'), null);
});

test('middleware：有效会话的 HTML 页面 → Cache-Control: private, no-store', async () => {
  const ctx = {
    request: new Request('https://styrigx.com/display/', {
      headers: { 'Cookie': 'sgx-lock-session=' + await validCookie(0) },
    }),
    next: async () => new Response('<html></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }),
    env: PROD_ENV(),
  };
  const r = await mw(ctx);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
});

test('middleware：有效会话的静态资源 → 不覆盖 Cache-Control', async () => {
  const ctx = {
    request: new Request('https://styrigx.com/assets/main.css', {
      headers: { 'Cookie': 'sgx-lock-session=' + await validCookie(0) },
    }),
    next: async () => new Response('body', {
      status: 200,
      headers: { 'Content-Type': 'text/css', 'Cache-Control': 'public, max-age=31536000' },
    }),
    env: PROD_ENV(),
  };
  const r = await mw(ctx);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Cache-Control'), 'public, max-age=31536000');
});

test('middleware：首页无会话 → 200 + data-sgx-lock-session="locked"（不再白名单直放）', async () => {
  const ctx = {
    request: new Request('https://styrigx.com/', {}),
    next: async () => new Response('<html lang="zh"><head></head><body></body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }),
    env: PROD_ENV(),
  };
  const r = await mw(ctx);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('data-sgx-lock-session="locked"'), '应注入 locked 状态');
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
});

test('middleware：首页有会话 → 200 + data-sgx-lock-session="valid"', async () => {
  const cookie = await validCookie(0);
  const ctx = {
    request: new Request('https://styrigx.com/', {
      headers: { 'Cookie': 'sgx-lock-session=' + cookie },
    }),
    next: async () => new Response('<html lang="zh"><head></head><body></body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }),
    env: PROD_ENV(),
  };
  const r = await mw(ctx);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('data-sgx-lock-session="valid"'), '应注入 valid 状态');
});

/* ============ 2.8.0：搜索收录 + 锁屏瘦身 ============ */

test('2.8.0：锁屏态首页剥离桌面内容（SGX-DESKTOP markers）', async () => {
  const { injectSessionState } = await import('../../../workers/auth-gateway/src/gate.js');
  const html = '<html lang="zh"><head></head><body>' +
    '<!-- SGX-DESKTOP-START --><div>书单歌单小组件</div><!-- SGX-DESKTOP-END -->' +
    '<div id="nav">导航</div></body></html>';
  const res = new Response(html, { headers: { 'Content-Type': 'text/html' } });
  const out = await injectSessionState(res, 'locked');
  const text = await out.text();
  assert.ok(!text.includes('书单歌单小组件'), '锁屏态不应下发桌面内容');
  assert.ok(text.includes('<div id="nav">导航</div>'), '锁屏需要的导航应保留');
});

test('2.8.0：锁屏态首页带 X-Robots-Tag: noindex', async () => {
  const { injectSessionState } = await import('../../../workers/auth-gateway/src/gate.js');
  const res = new Response('<html><body></body></html>', {
    headers: { 'Content-Type': 'text/html' },
  });
  const locked = await injectSessionState(res, 'locked');
  assert.equal(locked.headers.get('X-Robots-Tag'), 'noindex');
  const res2 = new Response('<html><body></body></html>', {
    headers: { 'Content-Type': 'text/html' },
  });
  const valid = await injectSessionState(res2, 'valid');
  assert.equal(valid.headers.get('X-Robots-Tag'), null, '已解锁页面不应 noindex');
});

test('2.8.0：未验证 302 带 X-Robots-Tag: noindex', async () => {
  const ctx = {
    request: new Request('https://styrigx.com/store/'),
    next: async () => new Response('x'),
    env: PROD_ENV(),
  };
  const r = await mw(ctx);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('X-Robots-Tag'), 'noindex');
});

/* ================================================================
 * 2.8.0 会话角色分离
 * ================================================================ */

async function tempkeyCookie(epoch = 0) {
  const { signLockSessionTicket } = await import('../../../workers/auth-gateway/src/core/lock-session.js');
  return await testLockSession(TEST_PRIV_PEM, epoch, 'tempkey');
}

test('进门二值：临时钥匙进门的人可以访问桌面（/）、设置（/display/）、文件（/files/）、安全总览和锁屏凭证页（中英），页面上没有等级标记', async () => {
  const vCookie = await tempkeyCookie(0);
  const htmlNext = async () => new Response('<html lang="zh"><head></head><body></body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
  const r0 = await mw({
    request: new Request('https://styrigx.com/', { headers: { 'Cookie': 'sgx-lock-session=' + vCookie } }),
    next: htmlNext,
    env: PROD_ENV(),
  });
  assert.equal(r0.status, 200);
  const html = await r0.text();
  assert.ok(html.includes('data-sgx-lock-session="valid"'));
  assert.ok(!/data-sgx-role|data-sgx-upgrade/.test(html), '不再注入等级 / 升级标记'); // old-name guard
  for (const p of ['/display/', '/files/', '/display/', '/zh/display/', '/security/', '/zh/security/', '/security/lock/', '/zh/security/lock/']) {
    const r = await mw(mwCtx('https://styrigx.com' + p, { cookie: vCookie, env: PROD_ENV() }));
    assert.equal(r.status, 200, '临时钥匙进门访问 ' + p + ' 应 200');
  }
});

test('LockResetTicket 只放行 /security/lock/，不开总览；LockReauthTicket 不能代替', async () => {
  await genTestKeys();
  const { signLockResetTicket, signLockReauthTicket } = await import('../../../workers/auth-gateway/src/core/tickets.js');
  const ticket = 'sgx-lock-reset=' + (await signLockResetTicket(TEST_PRIV_PEM, 'password', 0));
  const lockTicket = 'sgx-lock-reauth=' + (await signLockReauthTicket(TEST_PRIV_PEM, 'space', 0));
  const env = {
    SGX_ENV: 'production',
    SGX_SITE: 'space',
    SGX_LOCK_PUBLIC: TEST_PUB_PEM,
    ...stores(),
  };
  const ctx = (url, t) => ({
    request: new Request(url, { headers: { 'Cookie': t || ticket } }),
    next: async () => new Response('<html><head></head><body></body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }),
    env,
  });
  /* 锁屏凭证管理页：放行，注入 lock-reset 状态 */
  let r = await mw(ctx('https://styrigx.com/security/lock/'));
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes('data-sgx-lock-session="lock-reset"'), '应注入 lock-reset 状态');
  /* 安全总览：不放行，302 到锁屏 */
  for (const p of ['/security/', '/display/']) {
    r = await mw(ctx('https://styrigx.com' + p));
    assert.equal(r.status, 302, 'reset 票访问 ' + p + ' 应 302 到锁屏');
    assert.ok(r.headers.get('Location').includes('?lock=1'), p + ' 应跳到锁屏');
  }
  /* 没有会话时，LockReauthTicket 不能开锁屏凭证页 */
  r = await mw(ctx('https://styrigx.com/security/lock/', lockTicket));
  assert.equal(r.status, 302);
});
test('进门二值：临时钥匙进门的人首页带 return=锁屏凭证页 → 直接 302 回原页（不再有升级验证层）', async () => {
  const vCookie = await tempkeyCookie(0);
  const htmlNext = async () => new Response('<html lang="zh"><head></head><body></body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
  const r = await mw({
    request: new Request('https://styrigx.com/?return=' + encodeURIComponent('/security/lock/'), { headers: { 'Cookie': 'sgx-lock-session=' + vCookie } }),
    next: htmlNext,
    env: PROD_ENV(),
  });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), '/security/lock/');
});

test('进门二值：关口不再按角色拦锁屏凭证接口——临时钥匙进门的 POST 都交给接口（调 next），由接口自己要复验', async () => {
  const vCookie = await tempkeyCookie(0);
  for (const api of ['/api/lock-passkey', '/api/lock-password', '/api/lock-all-devices', '/api/lock-reauth', '/api/lock-tempkey']) {
    let reached = false;
    const ctx = {
      request: new Request('https://styrigx.com' + api, {
        method: 'POST',
        headers: { 'Cookie': 'sgx-lock-session=' + vCookie, 'Content-Type': 'application/json', Origin: 'https://styrigx.com' },
        body: JSON.stringify({ action: 'list' }),
      }),
      next: async () => { reached = true; return new Response('REACHED'); },
      env: PROD_ENV(),
    };
    const r = await mw(ctx);
    assert.equal(r.status, 200, api);
    assert.equal(await r.text(), 'REACHED', api + ' 应交给接口');
    assert.ok(reached);
  }
});

test('2.9.3：无会话调非白名单 API 是 401', async () => {
  // /api/lock-password 和 /api/lock-passkey 在白名单里（升级验证用），无会话时放行到 handler
  // /api/lock-all-devices 和 /api/stepup 不在白名单，无会话 → 401
  for (const api of ['/api/lock-all-devices', '/api/stepup']) {
    const ctx = {
      request: new Request('https://styrigx.com' + api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      next: async () => new Response('SHOULD-NOT-REACH'),
      env: PROD_ENV(),
    };
    const r = await mw(ctx);
    assert.equal(r.status, 401, api + ' 无会话应返回 401');
  }
});

test('2.9.3：middleware 放行临时钥匙进门的 POST /api/lock-now（调 next）', async () => {
  const vCookie = await tempkeyCookie(0);
  let nextCalled = false;
  const ctx = {
    request: new Request('https://styrigx.com/api/lock-now', {
      method: 'POST',
      headers: { 'Cookie': 'sgx-lock-session=' + vCookie },
    }),
    next: async () => {
      nextCalled = true;
      return new Response('PASSED-TO-HANDLER', { status: 200 });
    },
    env: PROD_ENV(),
  };
  const r = await mw(ctx);
  assert.ok(nextCalled, '临时钥匙进门调 /api/lock-now 应调用 next()');
  assert.equal(await r.text(), 'PASSED-TO-HANDLER', '应返回 handler 的响应');
});

test('2.9.3：POST /api/lock-now handler 返回 200 并清除 sgx-verified', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/src/api/lock-now.js');
  const vCookie = await tempkeyCookie(0);
  for (const cookie of [vCookie, null]) {
    const r = await onRequestPost({
      request: new Request('https://styrigx.com/api/lock-now', {
        method: 'POST',
        headers: cookie ? { 'Cookie': 'sgx-lock-session=' + cookie } : {},
      }),
      env: PROD_ENV(),
    });
    assert.equal(r.status, 200, (cookie ? 'tempkey' : '无会话') + ' 调 handler 应 200');
    assert.deepEqual(await r.json(), { ok: true });
    const setCookie = r.headers.get('Set-Cookie') || '';
    assert.ok(setCookie.includes('sgx-lock-session=') && setCookie.includes('Max-Age=0'),
      '应清除 sgx-verified cookie');
  }
});

test('2.8.0：旧三段式 cookie（无 role）一律无效', async () => {
  /* 旧格式 epoch.exp.sig */
  const oldCookie = '0.' + String(Date.now() + 3600000) + '.fakesig';
  const ctx = {
    request: new Request('https://styrigx.com/', {
      headers: { 'Cookie': 'sgx-lock-session=' + oldCookie },
    }),
    next: async () => new Response('<html lang="zh"><head></head><body></body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }),
    env: PROD_ENV(),
  };
  const r = await mw(ctx);
  /* 无有效会话 → 首页返回 locked 状态 */
  const html = await r.text();
  assert.ok(html.includes('data-sgx-lock-session="locked"'), '旧 cookie 应被视为无效');
});

test('进门二值：解锁后 return 指向锁屏凭证页 → 回原页（resolveReturn 只做地址白名单；页面自己要锁侧复验）', async () => {
  const oCookie = await mintSessionCookie();
  const htmlNext = async () => new Response('<html lang="zh"><head></head><body></body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
  const ctx = {
    request: new Request('https://styrigx.com/?return=' + encodeURIComponent('/security/lock/'), {
      headers: { 'Cookie': 'sgx-lock-session=' + oCookie },
    }),
    next: htmlNext,
    env: PROD_ENV(),
  };
  const r = await mw(ctx);
  assert.equal(r.status, 302, '应 302');
  assert.equal(r.headers.get('Location'), '/security/lock/');
});

test('解锁后 return 指向普通页 → 正常回跳', async () => {
  const oCookie = await mintSessionCookie();
  const htmlNext = async () => new Response('<html lang="zh"><head></head><body></body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
  const ctx = {
    request: new Request('https://styrigx.com/?return=' + encodeURIComponent('/display/'), {
      headers: { 'Cookie': 'sgx-lock-session=' + oCookie },
    }),
    next: htmlNext,
    env: PROD_ENV(),
  };
  const r = await mw(ctx);
  assert.equal(r.status, 302, '应 302');
  assert.equal(r.headers.get('Location'), '/display/', '普通页 return 应正常回跳');
});
