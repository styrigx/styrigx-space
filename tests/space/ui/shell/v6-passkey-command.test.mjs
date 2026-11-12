/**
 * 割接 2e：终端 passkey 接 v6（定稿 v5.2 §八「普通用户用 passwd、passkey 改自己的凭据；通行密钥自带 WebAuthn 验证」；
 * v6-commands「自己的账号（普通用户与 root 各管各的）」passkey ls / add / rm <n>；§九 救援白名单含 passkey；§十 sudo 不能动 root 的通行密钥）——
 * - 有 v6 会话（普通用户 / su root / 救援）：账号层直接走 POST /api/identity passkey-*（user 档，管栈顶那个用户自己的），
 *   不要 root、不跑旧 sudo root reauth、不查旧账号会话；401 → 先 su <用户>，身份重问
 * - 访客：先 su <用户>；旧会话（旧 root / 旧 styrigx / 账号 reset 层）照旧（P4 删）
 * - sudo passkey …（v6，定稿 §十）：rootCreds「sudo 不能改 root 的密码或通行密钥 · 先 su root」（同 sudo passwd）
 * - man passkey：v6 普通用户 / root6 都列；AUTH 行 = 已上线 v6 命令 groups 的同类写法「已登录」
 * v6 P4：旧会话（旧 root / 旧 styrigx / 账号 reset 层）和旧账号钥匙（/api/account/keys、sudo root reauth）删了，只剩 v6。
 * 运行：node --test tests/space/ui/shell/v6-passkey-command.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { createShell } from '../../../../space/web/assets/js/shell/terminal.js';
import { mountAuthErr } from '../../../../space/web/assets/js/shell/account/cmd/auth-err.js';
import { mountKeys } from '../../../../space/web/assets/js/shell/account/cmd/keys.js';
import * as accountApi from '../../../../space/web/assets/js/shell/account/api.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const rd = (p) => readFileSync(path.join(REPO, p), 'utf8');

function mem() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
function fixedWho(w) { return { get: () => w, on() {} }; }
const act = { cd: () => ({ kind: 'scroll', label: '' }), theme() {}, ask() {}, find: () => Promise.resolve({ ok: true, results: [] }), today: () => Promise.resolve(null), daymarkHref: () => '/daymark/', close() {} };
const text = (o) => o.seg.map((s) => s[1]).join('');
function layers(inReset) {
  const calls = [];
  const rec = (n) => (...a) => calls.push([n, ...a]);
  const acct = { inReset: !!inReset, passkeyList: rec('passkeyList'), cmdPasskeyAdd: rec('cmdPasskeyAdd'), passkeyRm: rec('passkeyRm') };
  const ident = { hasSession: () => true, cmdSudo: rec('ident.cmdSudo') };
  return { v: { space: { inReset: false }, acct, ident }, calls };
}
const sh = (w) => createShell({ act, storage: mem(), who: fixedWho(w) });

test('passkey：v6 普通用户 / root / 救援都直接管自己的；passkey 与 passkey ls 都列出', () => {
  for (const w of ['u:styrigx', 'u:smoke2', 'u:root']) {
    const L = layers();
    for (const l of ['passkey', 'passkey ls', 'passkey add', 'passkey rm 2']) assert.equal(sh(w).exec(l, L.v).flow, true, w + ' ' + l);
    assert.deepEqual(L.calls, [['passkeyList'], ['passkeyList'], ['cmdPasskeyAdd', true], ['passkeyRm', 2]], w);
  }
});

test('passkey（v6）：不再回旧的「还没登录账号 · 先 sudo root」；参数不对给用法', () => {
  const L = layers();
  for (const l of ['passkey', 'passkey ls']) assert.equal(sh('u:styrigx').exec(l, L.v).out.length, 0, l);
  assert.equal(text(sh('u:styrigx').exec('passkey rm x', L.v).out[0]), 'usage: passkey [ls | add | rm <n>]');
  assert.ok(!L.calls.some((c) => c[0] === 'passkeyRm'));
});

test('passkey：访客先 su <用户>（v6 P4 起旧会话的路径删了）', () => {
  const L = layers();
  assert.equal(text(sh('nobody').exec('passkey', L.v).out[0]), 'not signed in · su <user> first');
  assert.deepEqual(L.calls, []);
});

test('sudo passkey（v6）交给身份层，身份层先回 rootCreds（定稿 §十：sudo 不能为 root 增删通行密钥）；旧写法给 sudo 用法', () => {
  const L = layers();
  assert.equal(sh('u:styrigx').exec('sudo passkey add', L.v).flow, true);
  assert.deepEqual(L.calls, [['ident.cmdSudo', ['passkey', 'add']]]);
  const layer = rd('space/web/assets/js/shell/identity/layer.js');
  assert.match(layer, /if \(argv\[0\] === 'passkey'\) \{ C\.err\(t\('rootCreds'\)\); return; \}\n\s+const cmd = sudoCommand\(argv\);/);
  const old = layers();
  assert.equal(text(sh('nobody').exec('sudo passkey add', old.v).out[0]), 'usage: sudo useradd | userdel | usermod | passwd <name> | groups [name] | who', '访客：同 main 不进身份层，给用法');
  assert.deepEqual(old.calls, []);
  assert.equal(text(sh('nobody').exec('sudo styrigx', old.v).out[0]), 'usage: sudo useradd | userdel | usermod | passwd <name> | groups [name] | who', '旧写法：sudo 用法');
  for (const lang of ['en', 'zh']) {
    const t = yaml.load(rd('space/web/data/sgx-shell-i18n/' + lang + '.yaml'));
    assert.ok(t.identity.rootCreds, lang + ' rootCreds 已上线');
  }
});

test('man：passkey 给 v6 普通用户与 root6 都列；AUTH 行 = 已上线 groups 的同类写法「已登录」（中英）', async () => {
  const names = async (w) => (await sh(w).exec('man')).out.slice(1).map((o) => o.seg[0][1]);
  for (const w of ['u:styrigx', 'u:root']) assert.ok((await names(w)).includes('passkey'), w);
  const zh = yaml.load(rd('space/web/data/sgx-shell-i18n/zh.yaml'));
  const en = yaml.load(rd('space/web/data/sgx-shell-i18n/en.yaml'));
  assert.equal(zh.manBody.passkey.auth, zh.manBody.groups.auth.split('；')[0]);
  assert.equal(en.manBody.passkey.auth, en.manBody.groups.auth.split(';')[0]);
  const pg = rd('space/web/assets/js/shell/term/man/pages.js');
  assert.match(pg, /passkey: \{ d: '[^']+', syn: \['passkey', 'passkey add', 'passkey rm <n>'\], auth: 'signed in' \}/, 'SYNOPSIS 同 main（passkey ls 进 SYNOPSIS 仍是待定项）');
});

/* ---------- 账号层（./cmd/keys.js） ---------- */

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 6; i++) await tick(); }

function fakeCtx(v6reply) {
  const log = [];
  const sent = [];
  const v6 = (name) => (...a) => { sent.push(['v6.' + name, ...a]); return Promise.resolve(typeof v6reply === 'function' ? v6reply(name, a) : v6reply); };
  const old = (name) => (...a) => { sent.push(['keys.' + name, ...a]); return Promise.resolve({ s: 200, j: { ok: true, keys: [] } }); };
  let picker = null;
  const C = {
    t: (k) => k, tf: (k) => k, esc: (s) => String(s), inReset: false, reauthExp: 0, status: { configured: { passkey: false } },
    k: (x) => '[' + x + ']', asUid: () => 1000,
    api: {
      v6keys: { passkeyList: v6('passkeyList'), passkeyAddChallenge: v6('passkeyAddChallenge'), passkeyAdd: v6('passkeyAdd'), passkeyDelete: v6('passkeyDelete') },
      keys: { passkeyList: old('passkeyList'), passkeyDelete: old('passkeyDelete') }, reset: {},
      isErr: (r, c) => !!(r && r.j && r.j.error === c), ERR: {}, errText: () => 'x',
    },
    out: (s) => log.push(['out', s]), err: (s, x) => log.push(['err', s, x]), ok: (s) => log.push(['ok', s]), note: (k) => log.push(['note', k]),
    setMode() {}, toCmd() {}, apiErr: (r) => log.push(['apiErr', r.s]), netErr() {}, echo() {}, echoPick() {}, ask: (...a) => log.push(['ask', a[0]]),
    pick: (m) => { picker = m; }, reauthLeft: () => 0, afterResetChange() {},
    withReauth: (run, lead) => { log.push(['withReauth', lead]); },
    authErr: (r) => { log.push(['authErr', r.s]); return true; },
  };
  return { C, log, sent, pickY: () => picker && picker.y() };
}
const KEYS = { s: 200, j: { ok: true, keys: [{ n: 1, credId: 'A', name: 'S25', provider: '', createdAt: 0, lastUsedAt: 0 }, { n: 2, credId: 'B', name: 'Pixel', provider: '', createdAt: 0, lastUsedAt: 0 }] } };

test('账号层 passkey：列表走 v6keys、不跑旧 reauth', async () => {
  const a = fakeCtx(KEYS);
  mountAuthErr(a.C, null);
  mountKeys(a.C);
  a.C.passkeyList();
  await settle();
  assert.deepEqual(a.sent, [['v6.passkeyList', 1000]]);
  assert.ok(!a.log.some((l) => l[0] === 'withReauth'));
  assert.equal(a.log.filter((l) => l[0] === 'out').length, 2);
  assert.ok(a.log.some((l) => l[0] === 'out' && l[1].includes('Pixel')));

  const b = fakeCtx(KEYS);
  mountAuthErr(b.C, null);
  mountKeys(b.C);
  b.C.passkeyList();
  await settle();
  assert.ok(!b.log.some((l) => l[0] === 'withReauth'), '不跑旧 sudo root reauth');
  assert.deepEqual(b.sent, [['v6.passkeyList', 1000]]);
});

test('账号层 passkey rm：y 之后按服务端编号删（passkey-delete { n }），不碰 credId 旧接口', async () => {
  const a = fakeCtx((name) => (name === 'passkeyList' ? KEYS : { s: 200, j: { ok: true } }));
  mountAuthErr(a.C, null);
  mountKeys(a.C);
  a.C.passkeyRm(2);
  await settle();
  a.pickY();
  await settle();
  assert.deepEqual(a.sent, [['v6.passkeyList', 1000], ['v6.passkeyDelete', 2, 1000]]);
  assert.ok(a.log.some((l) => l[0] === 'out' && l[1].includes('keys.passkey.deleted')));
});

test('账号层 passkey：服务端 401 → 「没有登录 · 先 su <用户>」并让身份重问；不走旧 authErr', async () => {
  const a = fakeCtx({ s: 401, j: { ok: false, error: 'unauthorized' } });
  const refreshed = [];
  mountAuthErr(a.C, { refresh: () => refreshed.push(1) });
  mountKeys(a.C);
  a.C.passkeyList();
  await settle();
  assert.deepEqual(a.log.find((l) => l[0] === 'err'), ['err', 'v6.notSignedIn', undefined]);
  assert.equal(refreshed.length, 1);
  assert.ok(!a.log.some((l) => l[0] === 'authErr'));
});

test('账号层 passkey add：challenge 的 user.id 随 passkey-add 带回；加完不问名字（v6 没有改名接口）', async () => {
  const g = /** @type {any} */ (globalThis);
  const had = { window: g.window, nav: Object.getOwnPropertyDescriptor(g, 'navigator') };
  const buf = (n) => new Uint8Array([n, n, n]).buffer;
  g.window = g.window || g;
  g.window.PublicKeyCredential = g.window.PublicKeyCredential || function () {};
  Object.defineProperty(g, 'navigator', { configurable: true, value: { userAgent: 'test', credentials: { create: () => Promise.resolve({ id: 'K', rawId: buf(1), type: 'public-key', response: { clientDataJSON: buf(2), attestationObject: buf(3) } }) } } });
  try {
    const a = fakeCtx((name) => (name === 'passkeyAddChallenge'
      ? { s: 200, j: { ok: true, cid: 'c1', challenge: 'AAAA', rpId: 'styrigx.com', rp: { id: 'styrigx.com', name: 'Styrigx' }, user: { id: 'SEFORExF', name: 'styrigx', displayName: 'styrigx' }, excludeCredentials: [] } }
      : { s: 200, j: { ok: true, credId: 'K' } }));
    mountAuthErr(a.C, null);
    mountKeys(a.C);
    a.C.cmdPasskeyAdd(true);
    await settle();
    assert.equal(a.sent[0][0], 'v6.passkeyAddChallenge');
    assert.equal(a.sent[1][0], 'v6.passkeyAdd');
    assert.equal(a.sent[1][2], 'SEFORExF', 'handle = challenge 的 user.id');
    assert.equal(a.sent[1][1].cid, 'c1');
    assert.ok(a.log.some((l) => l[0] === 'ok' && l[1].includes('keys.passkey.registered')));
    assert.ok(!a.log.some((l) => l[0] === 'ask'), '不问名字');
    assert.ok(!a.log.some((l) => l[0] === 'withReauth'));
    assert.equal(a.C.status.configured.passkey, false, '不碰旧账号状态');
  } finally {
    if (had.nav) Object.defineProperty(g, 'navigator', had.nav); else delete g.navigator;
  }
});

test('authErr：409 identity（提示符上的身份和服务端认定的对不上）→ 不执行、切到服务端回的身份、按原因选文案（超时 / 失效），{r}{u}{x} 套名字', () => {
  for (const [lapsed, key] of [['timeout', 'v6.layerTimeout'], ['gone', 'v6.layerGone'], ['', 'v6.layerGone']]) {
    const a = fakeCtx(KEYS);
    const seen = [];
    a.C.tf = (k, v) => k + '|' + v.r + '|' + v.u;
    let cur = { uid: 0, name: 'root' };
    mountAuthErr(a.C, { v6: () => cur, setV6: (u) => { seen.push(u); cur = u; }, refresh: () => seen.push('refresh') });
    const styrigx = { uid: 1000, name: 'styrigx' };
    assert.equal(a.C.authErr({ s: 409, j: { ok: false, error: 'identity', user: styrigx, lapsed } }), true);
    assert.deepEqual(seen, [styrigx], '切到服务端回的身份，不再另问');
    assert.deepEqual(a.log, [['err', key + '|root|styrigx', 'su root']]);
  }
});

test('api.v6keys：都打 POST /api/identity；列表 passkeys → keys；add 带 handle；delete 带 n', async () => {
  const g = /** @type {any} */ (globalThis);
  const prev = g.fetch;
  const got = [];
  g.fetch = (url, init) => { const b = JSON.parse(init.body); got.push([url, b]); return Promise.resolve({ status: 200, json: () => Promise.resolve(b.action === 'passkey-list' ? { ok: true, passkeys: [{ n: 1, credId: 'A' }] } : { ok: true }) }); };
  try {
    const l = await accountApi.v6keys.passkeyList(0);
    assert.deepEqual(l, { s: 200, j: { ok: true, keys: [{ n: 1, credId: 'A' }] } });
    await accountApi.v6keys.passkeyAddChallenge(0);
    await accountApi.v6keys.passkeyAdd({ cid: 'c', name: 'S25', credential: {} }, 'H', 0);
    await accountApi.v6keys.passkeyDelete(3, 0);
    assert.deepEqual(got, [
      ['/api/identity', { action: 'passkey-list', as: 0 }],
      ['/api/identity', { action: 'passkey-add-challenge', as: 0 }],
      ['/api/identity', { action: 'passkey-add', cid: 'c', name: 'S25', credential: {}, handle: 'H', as: 0 }],
      ['/api/identity', { action: 'passkey-delete', n: 3, as: 0 }],
    ]);
  } finally { g.fetch = prev; }
});
