/**
 * POST /api/account/proxy（代理订阅管理，经 AccountService 命名入口；终端 sub 指令 v3.1）——v6 P4 起只认 v6 会话（root 档）：
 * - 没有 v6 会话 / 不够 root（styrigx）→ 401，都不调 PROXY
 * - 门卫通过才调服务绑定 PROXY（styrigx-proxy-rules 的 ProxyAdmin），不认识的 action 400 action、参数不对 400 params、
 *   没绑 503 config、RPC 抛错 / 回的不是对象 503 upstream
 * - ProxyAdmin 的业务失败原样回 422；show / token 回令牌 + 下载地址前缀
 * 只是把旧会话下的这些用例改用 v6 会话重写（原 api-proxy.test.mjs，随旧账号会话删除），接口行为不变。
 * 运行：node --test tests/workers/account/api-proxy.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceCall } from './_auth.mjs';
import { makeAccountD1 } from './_d1.mjs';

const SRC = new URL('../../../workers/account/src/', import.meta.url).pathname;
const { _resetSecretCache } = await import(SRC + 'secrets.js');
const { makePasswordRecord } = await import(SRC + 'core/password.js');
const ORIGIN = 'https://styrigx.com';
const PEP = 'pepper-account-test';
const PW = { root: 'root-pass-01', styrigx: 'sty-pass-01' };
let ipN = 0;

function fakeProxy() {
  const calls = [];
  const rec = (name, ret) => async (...args) => { calls.push([name, ...args]); return typeof ret === 'function' ? ret(...args) : ret; };
  return {
    calls,
    status: rec('status', { ok: true, sources: [] }),
    setKey: rec('setKey', (k) => (k.startsWith('age1pq1') ? { ok: false, error: 'pq-unsupported' } : { ok: true })),
    showToken: rec('showToken', { ok: true, token: 'S'.repeat(43) }),
    rotateToken: rec('rotateToken', { ok: true, token: 'T'.repeat(43) }),
    addAirport: rec('addAirport', { ok: true, host: 'sub.example.com' }),
    upload: rec('upload', { ok: true, nodes: 1 }),
    setEnabled: rec('setEnabled', { ok: true }),
    remove: rec('remove', { ok: false, error: 'not-found' }),
    rename: rec('rename', { ok: true }),
  };
}
/** 库里两个用户（root、styrigx，都有密码）；token(env, 'root') = styrigx 登录后 su root 的会话，token(env, 'styrigx') = 只有 styrigx */
async function makeEnv(proxy = fakeProxy()) {
  _resetSecretCache();
  const env = { SGX_ENV: 'production', SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: ORIGIN, SGX_ACCOUNT_PASSWORD_PEPPER: PEP, D1_ACCOUNT: makeAccountD1(), PROXY: proxy };
  const raw = env.D1_ACCOUNT.raw;
  for (const [uid, name, groups] of [[0, 'root', []], [1000, 'styrigx', ['wheel', 'sudoers']]]) {
    raw.prepare("INSERT INTO account_users (uid, name, avatar, expires_at, epoch, disabled, created_at) VALUES (?, ?, '', 0, 0, 0, 1)").run(uid, name);
    for (const g of groups) raw.prepare('INSERT INTO account_user_groups (uid, grp, added_at) VALUES (?, ?, 1)').run(uid, g);
    raw.prepare("INSERT INTO account_user_password (uid, record, pepper_id, must_change, expires_at) VALUES (?, ?, 'account', 0, 0)").run(uid, JSON.stringify(await makePasswordRecord(PW[name], PEP)));
  }
  const sty = await identity(env, { action: 'su', user: 'styrigx', password: PW.styrigx });
  const rt = await identity(env, { action: 'su', user: 'styrigx', password: PW.styrigx });
  await identity(env, { action: 'su', user: 'root', password: PW.root }, rt);
  return { proxy, env, ROOT: 'sgx-session=' + rt, STY: 'sgx-session=' + sty };
}
async function identity(env, body, token) {
  const headers = { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.' + (++ipN % 250) };
  if (token) headers.Cookie = 'sgx-session=' + token;
  const res = await serviceCall(new Request(ORIGIN + '/api/identity', { method: 'POST', headers, body: JSON.stringify(body) }), env);
  assert.equal(res.status, 200, JSON.stringify(body));
  const c = res.headers.getSetCookie().find((x) => x.startsWith('sgx-session='));
  return token || c.split(';')[0].slice('sgx-session='.length);
}
async function post(ctx, body, cookie = ctx.ROOT) {
  const headers = { Origin: ORIGIN, 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  return serviceCall(new Request(ORIGIN + '/api/account/proxy', { method: 'POST', headers, body: JSON.stringify(body) }), ctx.env);
}

test('门卫：没有 v6 会话 401；styrigx（不是 root）401；都不调 PROXY', async () => {
  const ctx = await makeEnv(); const { proxy } = ctx;
  assert.equal((await post(ctx, { action: 'status' }, '')).status, 401);
  assert.equal((await post(ctx, { action: 'status' }, 'sgx-account-session=a.b.c')).status, 401, '旧账号会话 cookie 不算');
  assert.equal((await post(ctx, { action: 'status' }, ctx.STY)).status, 401, 'styrigx 不是 root');
  assert.deepEqual(proxy.calls, []);
});

test('root：status / add / upload / mv / on / off 原样转给 ProxyAdmin；rm 业务失败原样回 422', async () => {
  const ctx = await makeEnv(); const { proxy } = ctx;
  for (const [body, name] of [
    [{ action: 'status' }, 'status'],
    [{ action: 'add', name: 'Linkcube', url: 'https://sub.example.com/x' }, 'addAirport'],
    [{ action: 'upload', name: 'F', text: 'proxies: []' }, 'upload'],
    [{ action: 'mv', from: 'F', to: 'G' }, 'rename'],
    [{ action: 'on', name: 'F' }, 'setEnabled'],
    [{ action: 'off', name: 'F' }, 'setEnabled'],
  ]) {
    const r = await post(ctx, body);
    assert.equal(r.status, 200, body.action);
    assert.equal((await r.json()).ok, true);
    assert.equal(proxy.calls.at(-1)[0], name);
  }
  assert.deepEqual(proxy.calls.filter((c) => c[0] === 'setEnabled').map((c) => c[2]), [true, false]);
  assert.deepEqual(proxy.calls.find((c) => c[0] === 'addAirport').slice(1), ['Linkcube', 'https://sub.example.com/x']);
  assert.deepEqual(proxy.calls.find((c) => c[0] === 'rename').slice(1), ['F', 'G']);
  assert.equal((await post(ctx, { action: 'mv', from: 'F' })).status, 400, 'mv 少参数 400 params');
  const rm = await post(ctx, { action: 'rm', name: 'Nope' });
  assert.equal(rm.status, 422);
  assert.deepEqual(await rm.json(), { ok: false, error: 'not-found' });
});

test('show / token 回令牌和下载地址前缀；key 转给 setKey，PQ 公钥 422', async () => {
  const ctx = await makeEnv(); const { proxy } = ctx;
  const sh = await post(ctx, { action: 'show' });
  assert.equal(sh.status, 200);
  assert.deepEqual(await sh.json(), { ok: true, token: 'S'.repeat(43), base: 'https://proxy-rules.styrigx.com/s/' });
  const tk = await post(ctx, { action: 'token' });
  assert.equal(tk.status, 200);
  assert.deepEqual(await tk.json(), { ok: true, token: 'T'.repeat(43), base: 'https://proxy-rules.styrigx.com/s/' });
  assert.deepEqual(proxy.calls.map((c) => c[0]), ['showToken', 'rotateToken']);
  assert.equal((await post(ctx, { action: 'key', pubkey: 'age1abc' })).status, 200);
  const pq = await post(ctx, { action: 'key', pubkey: 'age1pq1abc' });
  assert.equal(pq.status, 422);
  assert.deepEqual(await pq.json(), { ok: false, error: 'pq-unsupported' });
});

test('参数和配置：不认识的 action 400；缺参数 400 params；没绑 PROXY 503 config；RPC 抛错 / 回的不是对象 503 upstream', async () => {
  const ctx = await makeEnv();
  for (const action of ['nuke', 'link', 'refresh']) assert.equal((await (await post(ctx, { action })).json()).error, 'action', action);
  for (const body of [{ action: 'add', name: 'A' }, { action: 'upload', name: 'A' }, { action: 'on' }, { action: 'rm', name: '' }, { action: 'key' }]) {
    const r = await post(ctx, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal((await r.json()).error, 'params');
  }
  const bare = await makeEnv();
  delete bare.env.PROXY;
  const r = await post(bare, { action: 'status' });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'config');
  const boom = await makeEnv({ ...fakeProxy(), status: async () => { throw new Error('rpc'); } });
  const r2 = await post(boom, { action: 'status' });
  assert.equal(r2.status, 503);
  assert.equal((await r2.json()).error, 'upstream');
  const odd = await makeEnv({ ...fakeProxy(), status: async () => null });
  const r3 = await post(odd, { action: 'status' });
  assert.equal(r3.status, 503);
  assert.equal((await r3.json()).error, 'upstream');
});
