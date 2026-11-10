/**
 * POST /api/account/proxy（代理订阅管理，经 AccountService 命名入口；设计稿 v1.7 §7）：
 * - 进站会话（401 session）+ 账号 session（401 account）；key / link 再要本机 reauth 票（403 reauth）
 * - 门卫通过才调服务绑定 PROXY（styrigx-proxy-rules 的 ProxyAdmin），参数不对 400 params、没绑 503 config、RPC 抛错 503 upstream
 * - ProxyAdmin 的业务失败原样回 422；link 回令牌 + 下载地址前缀
 * 运行：node --test tests/workers/account/api-proxy.test.mjs
 */
import './_cf-workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postReq } from '../_harness.mjs';
import { makeAccountD1 } from './_d1.mjs';
import { K, keys, idHeaders, accSession, reauthTicket } from './_fixtures.mjs';

const SRC = '../../../workers/account/src/';
const { AccountService } = await import(SRC + 'rpc/account-service.js');
await keys();
const ORIGIN = 'https://styrigx.com';

function fakeProxy() {
  const calls = [];
  const rec = (name, ret) => async (...args) => { calls.push([name, ...args]); return typeof ret === 'function' ? ret(...args) : ret; };
  return {
    calls,
    status: rec('status', { ok: true, sources: [] }),
    setKey: rec('setKey', (k) => (k.startsWith('age1pq1') ? { ok: false, error: 'pq-unsupported' } : { ok: true })),
    newLink: rec('newLink', { ok: true, token: 'T'.repeat(43) }),
    addAirport: rec('addAirport', { ok: true, host: 'sub.example.com' }),
    upload: rec('upload', { ok: true, nodes: 1 }),
    setEnabled: rec('setEnabled', { ok: true }),
    remove: rec('remove', { ok: false, error: 'not-found' }),
    rename: rec('rename', { ok: true }),
    refresh: rec('refresh', { ok: true, sources: [] }),
  };
}
function makeEnv(proxy = fakeProxy()) {
  return { proxy, env: { SGX_ENV: 'production', D1_ACCOUNT: makeAccountD1(), SGX_ACCOUNT_PRIVATE: K.ACCOUNT.priv, SGX_ACCOUNT_PUBLIC: K.ACCOUNT.pub, SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: ORIGIN, PROXY: proxy } };
}
const acc = async () => 'sgx-account-session=' + (await accSession('password', 0, Date.now()));
const reauth = async () => 'sgx-account-reauth=' + (await reauthTicket('password', 0));
const post = (env, body, cookie, headers = idHeaders()) =>
  new AccountService({ waitUntil() {} }, env).fetch(postReq(ORIGIN + '/api/account/proxy', body, { ...headers, ...(cookie ? { Cookie: cookie } : {}) }));

test('门卫：没进站会话 401；没账号 session 401 account；都不调 PROXY', async () => {
  const { env, proxy } = makeEnv();
  let r = await post(env, { action: 'status' }, null, {});
  assert.equal(r.status, 401, 'AccountService 的门先拦');
  r = await post(env, { action: 'status' });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'account');
  assert.deepEqual(proxy.calls, []);
});

test('会话就够的：status / add / upload / mv / on / off / rm / refresh 原样转给 ProxyAdmin', async () => {
  const { env, proxy } = makeEnv();
  const ck = await acc();
  for (const [body, name] of [
    [{ action: 'status' }, 'status'],
    [{ action: 'add', name: 'Linkcube', url: 'https://sub.example.com/x' }, 'addAirport'],
    [{ action: 'upload', name: 'F', text: 'proxies: []' }, 'upload'],
    [{ action: 'mv', from: 'F', to: 'G' }, 'rename'],
    [{ action: 'on', name: 'F' }, 'setEnabled'],
    [{ action: 'off', name: 'F' }, 'setEnabled'],
    [{ action: 'refresh' }, 'refresh'],
  ]) {
    const r = await post(env, body, ck);
    assert.equal(r.status, 200, body.action);
    assert.equal((await r.json()).ok, true);
    assert.equal(proxy.calls.at(-1)[0], name);
  }
  assert.deepEqual(proxy.calls.filter((c) => c[0] === 'setEnabled').map((c) => c[2]), [true, false]);
  assert.deepEqual(proxy.calls.find((c) => c[0] === 'addAirport').slice(1), ['Linkcube', 'https://sub.example.com/x']);
  assert.deepEqual(proxy.calls.find((c) => c[0] === 'rename').slice(1), ['F', 'G']);
  assert.equal((await post(env, { action: 'mv', from: 'F' }, ck)).status, 400, 'mv 少参数 400 params');
  const rm = await post(env, { action: 'rm', name: 'Nope' }, ck);
  assert.equal(rm.status, 422);
  assert.deepEqual(await rm.json(), { ok: false, error: 'not-found' });
});

test('key / link 要 reauth（403 reauth）；有 reauth 才转；link 回令牌和下载地址前缀；PQ 公钥 422', async () => {
  const { env, proxy } = makeEnv();
  const ck = await acc();
  for (const body of [{ action: 'key', pubkey: 'age1abc' }, { action: 'link' }]) {
    const r = await post(env, body, ck);
    assert.equal(r.status, 403, body.action);
    assert.equal((await r.json()).error, 'reauth');
  }
  assert.deepEqual(proxy.calls, []);
  const both = ck + '; ' + (await reauth());
  const l = await post(env, { action: 'link' }, both);
  assert.equal(l.status, 200);
  assert.deepEqual(await l.json(), { ok: true, token: 'T'.repeat(43), base: 'https://proxy-rules.styrigx.com/s/' });
  assert.equal((await post(env, { action: 'key', pubkey: 'age1abc' }, both)).status, 200);
  assert.equal((await post(env, { action: 'key', pubkey: 'age1pq1abc' }, both)).status, 422);
});

test('参数和配置：不认识的 action 400；缺参数 400 params；没绑 PROXY 503 config；RPC 抛错 503 upstream', async () => {
  const { env } = makeEnv();
  const ck = await acc();
  assert.equal((await (await post(env, { action: 'nuke' }, ck)).json()).error, 'action');
  for (const body of [{ action: 'add', name: 'A' }, { action: 'upload', name: 'A' }, { action: 'on' }, { action: 'rm', name: '' }]) {
    const r = await post(env, body, ck);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal((await r.json()).error, 'params');
  }
  const bare = makeEnv().env;
  delete bare.PROXY;
  const r = await post(bare, { action: 'status' }, ck);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'config');
  const boom = makeEnv({ ...fakeProxy(), status: async () => { throw new Error('rpc'); } }).env;
  const r2 = await post(boom, { action: 'status' }, ck);
  assert.equal(r2.status, 503);
  assert.equal((await r2.json()).error, 'upstream');
});
