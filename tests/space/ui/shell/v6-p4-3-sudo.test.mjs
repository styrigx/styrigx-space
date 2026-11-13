/**
 * v6 P4-3（定稿 v5.5 §四「后台数据控制……一律 root 档，站长用 sudo 提权、不必 su root」；§五 设备踢出 root 档；§七「站长预填 sudo …」）：
 * - 终端 sudo device [rm <n> | rm --all] / sudo sub …：身份层先验自己的凭据（sudoProof），账号层这一条命令里的接口都改走 POST /api/identity sudo
 * - shell/account/api.js setSudo：账号接口 → { action:'sudo', <证明>, command:{ method:'POST', path:'/api/account/<入口>', body } }；清掉后照旧直接调
 * - 不是 sudo 的账号命令开始前清掉 sudo（device / sub 先 A.sudo(null)）
 * 运行：node --test tests/space/ui/shell/v6-p4-3-sudo.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShell, TERM_EN } from '../../../../space/web/assets/common/js/term/terminal.js';
import * as accountApi from '../../../../space/web/assets/common/js/account/api.js';

function mem() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
const act = { cd: () => ({ kind: 'scroll', label: '' }), theme() {}, ask() {}, find: () => Promise.resolve({ ok: true, results: [] }), today: () => Promise.resolve(null), daymarkHref: () => '/daymark/', close() {} };
const WEBMASTER = { name: 'styrigx', webmaster: true, sudoers: true, wheel: true, groups: ['wheel', 'sudoers', 'ai'] };
const sh = (w, u) => createShell({ act, storage: mem(), who: { get: () => w, on() {}, v6: () => u || null } });
function layers() {
  const calls = [];
  const via = () => Promise.resolve({ password: 'pw' });
  const ident = { hasSession: () => true, sudoProof: (done) => { calls.push('proof'); done(via); } };
  const acct = {
    sudo: (v) => calls.push(['sudo', typeof v]), deviceList: () => calls.push('list'), deviceRm: (n) => calls.push(['rm', n]), deviceRmAll: () => calls.push('rmAll'),
    cmdSub: (l, g) => calls.push(['sub', l, g]),
  };
  return { v: { ident, acct }, calls };
}
const text = (o) => o.seg.map((s) => s[1]).join('');

test('sudo device rm <n> / rm --all / device：先验自己的凭据，再在账号层借 root 跑；用法不对不验凭据', () => {
  for (const [line, want] of [['sudo device rm 2', ['rm', 2]], ['sudo device rm --all', 'rmAll'], ['sudo device', 'list']]) {
    const L = layers();
    assert.equal(sh('u:styrigx', WEBMASTER).exec(line, L.v).flow, true, line);
    assert.deepEqual(L.calls, ['proof', ['sudo', 'function'], want], line);
  }
  const L = layers();
  assert.equal(text(sh('u:styrigx', WEBMASTER).exec('sudo device kick 2', L.v).out[0]), TERM_EN.usageDevice);
  assert.deepEqual(L.calls, []);
});

test('非 sudo 的 device / sub 先清掉 sudo（这一条直接调）；访客的 sudo device 先提示 su', () => {
  const L = layers();
  sh('u:styrigx', WEBMASTER).exec('device', L.v);
  assert.deepEqual(L.calls, [['sudo', 'object'], 'list']);
  const R = layers();
  sh('u:root', { name: 'root', root: true, groups: [] }).exec('sub show', R.v, 'sub show');
  assert.deepEqual(R.calls[0], ['sudo', 'object']);
  const G = layers();
  const o = sh('nobody').exec('sudo device rm 1', G.v).out;
  assert.equal(G.calls.length, 0);
  assert.ok(o.length >= 1);
});

test('account/api.js setSudo：这一条命令里的账号接口改走 POST /api/identity sudo（证明 + command），清掉后照旧直接调', async () => {
  const sent = [];
  const old = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push([url, JSON.parse(init.body)]); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  try {
    accountApi.setSudo(() => Promise.resolve({ password: 'pw' }));
    assert.equal(accountApi.sudoOn(), true);
    await accountApi.devices.revoke(3);
    await accountApi.proxy.rm('Foo');
    accountApi.setSudo(null);
    await accountApi.devices.list();
    assert.deepEqual(sent, [
      ['/api/identity', { action: 'sudo', password: 'pw', command: { method: 'POST', path: '/api/account/devices', body: { action: 'revoke', n: 3 } } }],
      ['/api/identity', { action: 'sudo', password: 'pw', command: { method: 'POST', path: '/api/account/proxy', body: { action: 'rm', name: 'Foo' } } }],
      ['/api/account/devices', { action: 'list' }],
    ]);
  } finally {
    globalThis.fetch = old;
    accountApi.setSudo(null);
  }
});
