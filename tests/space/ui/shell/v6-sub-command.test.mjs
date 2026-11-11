/**
 * 割接：终端 sub / app 接 v6（v6-commands「授权与订阅（root，或 sudo）」；路由表 /api/account/proxy、/grants = root 档，#401）——
 * - v6 root：直接做（{ direct: true }；不查旧账号会话，show / key / token、app allow 不跑旧的 sudo root reauth）
 * - v6 普通用户：「当前用户没有这个权限 · 先 su root」（同 #402 share），不进流程
 * - 访客：「没有登录 · 先 su <用户>」（同身份层 notSignedIn；门槛 gate.js 对所有命令一样）
 * - v6 P4（定稿 v5.2 §十三 P4）：旧会话（root / styrigx 两种旧身份）、share 命令、sudo styrigx 删了；旧身份字符串一律按访客
 * - man：sub / app 只给 root6 列；子站 / 博客终端挂 v6 身份层；子站首帧不再清主站的 sgx-theme-mode
 * 运行：node --test tests/space/ui/shell/v6-sub-command.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { createShell, TERM_EN } from '../../../../space/web/assets/js/shell/terminal.js';
import { mountV6Direct } from '../../../../space/web/assets/js/shell/account/cmd/v6-direct.js';
import { mountProxy } from '../../../../space/web/assets/js/shell/account/proxy.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const rd = (p) => readFileSync(path.join(REPO, p), 'utf8');

function mem() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
function fixedWho(w) { return { get: () => w, on() {} }; }
const act = { cd: () => ({ kind: 'scroll', label: '' }), theme() {}, ask() {}, find: () => Promise.resolve({ ok: true, results: [] }), today: () => Promise.resolve(null), daymarkHref: () => '/daymark/', close() {} };
const text = (o) => o.seg.map((s) => s[1]).join('');
function layers() {
  const calls = [];
  const rec = (n) => (...a) => calls.push([n, ...a]);
  const acct = { inReset: false, cmdSub: rec('cmdSub'), appList: rec('appList'), appAllow: rec('appAllow'), appDeny: rec('appDeny') };
  return { v: { space: { inReset: false }, acct, ident: { hasSession: () => true } }, calls };
}
const sh = (w) => createShell({ act, storage: mem(), who: fixedWho(w) });

test('sub / app：v6 root 直接做（direct: true），原样的一行照传', () => {
  const L = layers();
  const r = sh('u:root');
  for (const l of ['sub', 'sub show', 'sub token reset', 'sub key', 'sub mv Linkcube LinkCube2', 'app', 'app allow 2', 'app deny 1']) assert.equal(r.exec(l, L.v).flow, true, l);
  assert.deepEqual(L.calls, [
    ['cmdSub', 'sub', { direct: true }], ['cmdSub', 'sub show', { direct: true }], ['cmdSub', 'sub token reset', { direct: true }], ['cmdSub', 'sub key', { direct: true }],
    ['cmdSub', 'sub mv Linkcube LinkCube2', { direct: true }], ['appList', { direct: true }], ['appAllow', 2, { direct: true }], ['appDeny', 1, { direct: true }],
  ]);
});

test('sub / app：v6 普通用户提示先 su root（同 share 的 needRoot6），不说「还没登录账号」、不进流程', () => {
  const L = layers();
  for (const w of ['u:styrigx', 'u:alice']) {
    for (const l of ['sub', 'sub show', 'sub add x', 'sub token reset', 'app', 'app allow 1']) {
      const o = sh(w).exec(l, L.v).out[0];
      assert.equal(text(o), 'permission denied · run su root first', w + ' ' + l);
      assert.deepEqual(o.seg.filter((s) => s[0] === 'k').map((s) => s[1]), ['su root']);
    }
  }
  assert.deepEqual(L.calls, []);
});

test('访客：所有要身份的命令提示先 su <用户>（同身份层 notSignedIn），中英文都有', () => {
  const L = layers();
  for (const l of ['sub', 'sub show', 'app', 'device', 'passkey']) assert.equal(text(sh('nobody').exec(l, L.v).out[0]), 'not signed in · su <user> first', l);
  assert.deepEqual(L.calls, []);
  assert.equal(TERM_EN.needSu, 'not signed in · {x} first');
  for (const lang of ['en', 'zh']) {
    const t = yaml.load(rd('space/web/data/sgx-shell-i18n/' + lang + '.yaml'));
    assert.equal(t.term.needSu.replace('{x}', 'su ' + t.term.suUser), t.identity.notSignedIn, lang + '：终端访客提示 = 身份层 notSignedIn');
    assert.equal(t.account.v6.notSignedIn, t.identity.notSignedIn, lang);
    assert.equal(t.account.v6.forbidden, t.term.needRoot6, lang);
    assert.equal(t.term.exitFirst.replace('{x}', 'exit'), t.identity.exitFirst, lang);
  }
});

test('v6 P4：旧会话删了——旧身份字符串（root / styrigx）按访客；share、sudo styrigx 不再是命令（定稿 §十三 P4）', () => {
  const L = layers();
  for (const w of ['root', 'styrigx']) for (const l of ['sub show', 'app allow 1']) assert.equal(text(sh(w).exec(l, L.v).out[0]), 'not signed in · su <user> first', w + ' ' + l);
  assert.deepEqual(L.calls, []);
  assert.equal(text(sh('u:styrigx').exec('share', L.v).out[0]), 'command not found: share · try man');
  for (const w of ['nobody', 'u:styrigx', 'u:root']) assert.match(text(sh(w).exec('sudo styrigx', L.v).out[0]), /^usage: sudo /, w);
});

test('man：sub / app 只给 root6 列，v6 普通用户与访客不列', async () => {
  const names = async (w) => (await sh(w).exec('man')).out.slice(1).map((o) => o.seg[0][1]);
  for (const c of ['sub', 'app']) {
    assert.ok((await names('u:root')).includes(c), 'root6 ' + c);
    assert.ok(!(await names('nobody')).includes(c), 'nobody ' + c);
    assert.ok(!(await names('u:styrigx')).includes(c), 'user ' + c);
  }
});

/** 账号层的假上下文：记输出和请求 */
function fakeCtx(reply, st) {
  const log = [];
  const sent = [];
  const res = (a) => () => { sent.push(a); return Promise.resolve(typeof reply === 'function' ? reply(a) : reply); };
  const C = {
    t: (k) => k, tf: (k) => k, esc: (s) => String(s), st: st || 'guest', inReset: false, reauthExp: 0,
    k: (x) => '[' + x + ']',
    api: { proxy: { status: res('status'), show: res('show'), rotate: res('rotate'), key: res('key') }, isErr: (r, c) => !!(r && r.j && r.j.error === c), ERR: { reauth: 'reauth' } },
    out: (s) => log.push(['out', s]), err: (s, x) => log.push(['err', s, x]), ok: (s) => log.push(['ok', s]), setMode() {}, toCmd() {}, apiErr: (r) => log.push(['apiErr', r.s]), netErr() {},
    withReauth: (run, lead) => { log.push(['withReauth', lead]); },
    authErr: (r) => { log.push(['authErr', r.s]); return true; },
    opts() {}, pick() {}, focusIn() {}, echoPick() {}, ask() {},
  };
  return { C, log, sent };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('账号层 sub：不看旧账号会话、show 不跑旧 reauth（v6 P4 旧路径删了）', async () => {
  const status = { s: 200, j: { ok: true, token: 'sealed', sources: [{ name: 'a' }] } };
  const a = fakeCtx((x) => (x === 'show' ? { s: 200, j: { ok: true, token: 'T', base: 'https://p/s/' } } : status));
  const refreshed = [];
  mountV6Direct(a.C, { refresh: () => refreshed.push(1) });
  mountProxy(a.C);
  a.C.cmdSub('sub show', { direct: true });
  await tick(); await tick();
  assert.deepEqual(a.sent, ['status', 'show'], 'status → show，中间没有 reauth');
  assert.ok(!a.log.some((l) => l[0] === 'withReauth'));
  assert.ok(a.log.some((l) => l[0] === 'out' && String(l[1]).includes('https://p/s/T/a')));

  /* v6 P4：旧路径（没有 direct 的旧账号会话 + sudo root reauth）删了——不带 direct 也直接做 */
  const b = fakeCtx(status);
  mountV6Direct(b.C, null);
  mountProxy(b.C);
  b.C.cmdSub('sub show');
  await tick(); await tick();
  assert.ok(!b.log.some((l) => l[0] === 'withReauth'), '没有 reauth');
  assert.ok(!b.log.some((l) => l[0] === 'err' && l[2] === 'sudo root'), '不再提示 sudo root');
});

test('账号层 sub（direct）：服务端 401 → 先 su <用户>；403 forbidden → 先 su root；都让身份重问；不走旧 authErr', async () => {
  for (const [r, want] of [[{ s: 401, j: { ok: false, error: 'session' } }, ['err', 'v6.notSignedIn', undefined]], [{ s: 403, j: { ok: false, error: 'forbidden' } }, ['err', 'v6.forbidden', 'su root']]]) {
    const x = fakeCtx(r);
    const refreshed = [];
    mountV6Direct(x.C, { refresh: () => refreshed.push(1) });
    mountProxy(x.C);
    x.C.cmdSub('sub', { direct: true });
    await tick(); await tick();
    assert.deepEqual(x.log.find((l) => l[0] === 'err'), want, r.s);
    assert.equal(refreshed.length, 1);
    assert.ok(!x.log.some((l) => l[0] === 'authErr'));
  }
  /* v6 P4：不带 direct 也一样（旧 C.authErr 路径删了，authErr = authErrFor） */
  const y = fakeCtx({ s: 401, j: { ok: false, error: 'session' } }, 'in');
  mountV6Direct(y.C, null);
  mountProxy(y.C);
  y.C.cmdSub('sub');
  await tick(); await tick();
  assert.deepEqual(y.log.find((l) => l[0] === 'err'), ['err', 'v6.notSignedIn', undefined]);
});

test('子站 / 博客终端挂 v6 身份层（全站一个终端：su / su root / exit / lock 在奇趣、日刻、博客也能用）', () => {
  for (const f of ['space/web/assets/curio/js/sgx/topbar-host.js', 'space/web/assets/daymark/js/sgx/topbar-host.js', 'space/web/assets/blog/js/entries/topnav.ts', 'space/web/assets/js/shell/quick-panel.js']) {
    const s = rd(f);
    assert.match(s, /\n\s+identityTerm: mountIdentityLayer,\n/, f);
    assert.match(s, /\n\s+identityWhoami: identityWhoami,\n/, f);
    assert.match(s, /\n\s+identityMarker: identityMarker,\n/, f);
  }
});

test('子站首帧不再清 sgx-theme-mode（#310 起四站同源，它就是主站的深浅色偏好；SGX-SPEC-003 §2.2）', () => {
  for (const s of ['curio', 'daymark']) {
    const src = rd(`space/web/assets/${s}/js/sgx/ui-inherit-run.js`);
    assert.doesNotMatch(src, /removeItem\('sgx-theme-mode'\)/, s);
    assert.match(src, /removeItem\('sgx-theme-at'\)/, s);
  }
});

test('冒烟 smoke2（已登录、无组、非 root）：sub show / sub 不再回旧的「not signed in to the account · run sudo root first」', () => {
  const L = layers();
  for (const l of ['sub show', 'sub', 'app']) {
    const o = text(sh('u:smoke2').exec(l, L.v).out[0]);
    assert.equal(o, 'permission denied · run su root first', l);
    assert.notEqual(o, 'not signed in to the account · run sudo root first', l);
  }
  assert.deepEqual(L.calls, []);
});

test('旷野状态卡 403（已登录不在 status 组）留着凭据记录区（展开回已上线的 auditErrPerm）；401 访客照旧藏起来', () => {
  const src = rd('space/web/assets/js/apps/space-status.js');
  assert.match(src, /root\.toggleAttribute\('data-lock-perm', status === 403\)/);
  assert.match(src, /setState\('locked'\);\n\s+root\.removeAttribute\('data-lock-perm'\);/, 'exit / lock 回访客清掉');
  const css = rd('space/web/assets/css/input.css');
  assert.match(css, /\.st-wrap\[data-state="locked"\]:not\(\[data-lock-perm\]\) \.st-audit-wrap \{ display: none; \}/);
  assert.doesNotMatch(css, /\.st-wrap\[data-state="locked"\] \.st-audit-wrap \{ display: none; \}/);
});

test('奇趣 / 日刻：已以 v6 登录但不能编辑 → 命令仍 su，文字是已上线的 noPermission；没登录照旧「su 登录后可编辑」', () => {
  for (const f of ['space/web/assets/curio/js/curio.js', 'space/web/assets/daymark/js/daymark.js']) {
    const s = rd(f);
    assert.match(s, /if \(v6SignedIn\(\) && T\.noPermission\) return \{ text: T\.noPermission, open: '', app: '', su: true \};/, f);
    assert.match(s, /return \{ text: T\.signin, open: '', app: '', su: true \};/, f);
    assert.match(s, /sgx-id=1/, f);
  }
});
