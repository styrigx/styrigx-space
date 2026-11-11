/**
 * 割接 2f：#404 未决项文案（Gray 11-11 15:37 / 15:39 定稿，Muse 草稿 v6-404-pending-copy；Hark 调整：lock passkey 指向 passkey 命令、device / profile 不在本 PR）——
 * - 第 2 项：sudo sub / sudo app → sudoNotYet「sudo {x} 暂不支持 · 先 su root，再直接用 {x}」
 * - 第 3 项：v6 身份输 sudo -v / sudo root reauth / lock passwd | passkey | --all → 「已移除 · v6 做法」一行（不落 notHere）；旧身份照旧（P4 删）
 * - 第 4 项：man lock / share / passwd / app / sub 的 AUTH 行按 v6 改写（pages.js / zh / en 同步）
 * - 第 7 项：ask 进 root6 的 man，不进普通用户（user）的
 * - #406 未决 3：v6 路径的 passkey 用法行带 ls（v6-commands「passkey ls / add / rm <n>」）
 * 运行：node --test tests/space/ui/shell/v6-404-pending-copy.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { createShell, TERM_EN } from '../../../../space/web/assets/js/shell/terminal.js';
import { PAGES } from '../../../../space/web/assets/js/shell/term/man/pages.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const Y = (p) => yaml.load(readFileSync(path.join(REPO, p), 'utf8'));
const ZH = Y('space/web/data/sgx-shell-i18n/zh.yaml');
const EN = Y('space/web/data/sgx-shell-i18n/en.yaml');

function mem() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
function fixedWho(w) { return { get: () => w, on() {} }; }
const act = { cd: () => ({ kind: 'scroll', label: '' }), theme() {}, ask() {}, find: () => Promise.resolve({ ok: true, results: [] }), today: () => Promise.resolve(null), daymarkHref: () => '/daymark/', close() {} };
const text = (o) => o.seg.map((s) => s[1]).join('');
const sh = (w, str) => createShell({ act, storage: mem(), who: fixedWho(w), str });
const run = async (s, line, v) => { const r = s.exec(line, v); return r && typeof r.then === 'function' ? await r : r; };
function layers() {
  const calls = [];
  const rec = (n) => (...a) => calls.push([n, ...a]);
  const space = { inReset: false, lockAll: rec('lockAll'), cmdPasswd: rec('cmdPasswd'), passkeyList: rec('lockPasskeyList'), passkeyAdd: rec('lockPasskeyAdd'), cmdReauth: rec('spaceReauth') };
  const acct = { inReset: false, cmdReauth: rec('acctReauth') };
  const ident = { hasSession: () => true, cmdSudo: rec('ident.cmdSudo'), cmdLock: rec('ident.cmdLock') };
  return { v: { space, acct, ident }, calls };
}

test('文案：新键 en / zh / TERM_EN 都有，en 与 TERM_EN 一致', () => {
  for (const k of ['sudoNotYet', 'goneSudoV', 'goneSudoReauth', 'goneLockPasswd', 'goneLockPasskey', 'goneLockAll', 'usagePasskey6']) {
    assert.equal(EN.term[k], TERM_EN[k], 'en.' + k);
    assert.ok(typeof ZH.term[k] === 'string' && ZH.term[k] && ZH.term[k] !== TERM_EN[k], 'zh.' + k);
  }
});

test('第 2 项：sudo sub / sudo app → 暂不支持 · 先 su root，再直接用（中英；不落 usage）', () => {
  for (const w of ['u:styrigx', 'u:root']) {
    const L = layers();
    assert.equal(text(sh(w).exec('sudo sub', L.v).out[0]), 'sudo sub isn’t supported yet · su root first, then run sub', w);
    assert.equal(text(sh(w).exec('sudo app allow 1', L.v).out[0]), 'sudo app isn’t supported yet · su root first, then run app', w);
    assert.equal(text(sh(w, ZH.term).exec('sudo sub', L.v).out[0]), 'sudo sub 暂不支持 · 先 su root，再直接用 sub', w);
    assert.equal(L.calls.length, 0);
  }
  assert.equal(text(sh('u:root', ZH.term).exec('sudo app', layers().v).out[0]), 'sudo app 暂不支持 · 先 su root，再直接用 app');
});

test('第 3 项：v6 身份输已移除的 sudo -v / sudo root reauth / lock passwd | passkey | --all → 一行 v6 做法，不跑旧层', () => {
  const want = {
    'sudo -v': ['sudo -v is gone · in v6 every sudo verifies again', 'sudo -v 已移除 · v6 里每次 sudo 都会重新验证'],
    'sudo root reauth': ['sudo root reauth is gone · to act as root, su root', 'sudo root reauth 已移除 · 需要 root 权限时直接 su root'],
    'lock passwd': ['lock passwd is gone · change your own password with passwd', 'lock passwd 已移除 · 改自己的密码用 passwd'],
    'lock passkey': ['lock passkey is gone · manage passkeys with passkey', 'lock passkey 已移除 · 通行密钥用 passkey 管理'],
    'lock passkey add': ['lock passkey is gone · manage passkeys with passkey', 'lock passkey 已移除 · 通行密钥用 passkey 管理'],
    'lock --all': ['lock --all is gone · sign out all devices on the account page', 'lock --all 已移除 · 所有设备在账号页退出'],
  };
  for (const w of ['u:styrigx', 'u:root']) {
    for (const [l, [en, zh]] of Object.entries(want)) {
      const L = layers();
      const o = sh(w).exec(l, L.v).out;
      assert.equal(o.length, 1, w + ' ' + l);
      assert.equal(text(o[0]), en, w + ' ' + l);
      assert.equal(o[0].cls, 'err');
      assert.equal(text(sh(w, ZH.term).exec(l, L.v).out[0]), zh, w + ' ' + l);
      assert.equal(L.calls.length, 0, w + ' ' + l + ' 不跑旧层');
    }
  }
});

test('第 3 项：lock（不带参数）照旧清 v6 身份栈；旧身份的 sudo -v / lock passwd 照旧（P4 删）', () => {
  const L = layers();
  assert.equal(sh('u:styrigx').exec('lock', L.v).flow, true);
  assert.deepEqual(L.calls, [['ident.cmdLock']]);
  const O = layers();
  O.v.ident = null;
  assert.equal(sh('styrigx').exec('sudo -v', O.v).flow, true);
  assert.equal(sh('styrigx').exec('lock passwd', O.v).flow, true);
  assert.equal(sh('root').exec('sudo root reauth', O.v).flow, true);
  assert.deepEqual(O.calls.map((c) => c[0]), ['spaceReauth', 'cmdPasswd', 'acctReauth']);
  /* 应用内终端（没有层）的 notHere 不动 */
  assert.equal(text(sh('styrigx').exec('lock --all', {}).out[0]), 'lock --all: run it in the terminal (Ctrl K)');
});

test('#406 未决 3：v6 路径的 passkey 用法行带 ls；旧路径的用法行不变', () => {
  const v6 = { v: { acct: { inReset: false } } };
  assert.equal(text(sh('u:styrigx').exec('passkey rm x', v6.v).out[0]), 'usage: passkey [ls | add | rm <n>]');
  assert.equal(text(sh('u:styrigx', ZH.term).exec('passkey foo', v6.v).out[0]), '用法：passkey [ls | add | rm <n>]');
  assert.equal(text(sh('root').exec('passkey rm x', { acct: { inReset: false } }).out[0]), 'usage: passkey [add | rm <n>]');
});

test('第 4 项：man lock / share / passwd / app / sub 的 AUTH 行按 v6 改写（pages.js / en / zh 同步）；passkey / device / profile 不动', () => {
  const want = {
    lock: ['no verification', '不用验证'],
    share: ['root only; listing and revoking need no reauth', '只有 root；列出和作废不用再验证'],
    passwd: ['signed in; asks your current password first', '已登录；先输当前密码'],
    app: ['root only; allow needs no reauth', '只有 root；allow 不用再验证'],
    sub: ['root only; show, key and token reset need no reauth', '只有 root；show、key 和 token reset 不用再验证'],
  };
  for (const [c, [en, zh]] of Object.entries(want)) {
    assert.equal(PAGES[c].auth, en, 'pages.' + c);
    assert.equal(EN.manBody[c].auth, en, 'en.' + c);
    assert.equal(ZH.manBody[c].auth, zh, 'zh.' + c);
  }
  assert.equal(PAGES.passkey.auth, 'signed in');
  assert.equal(PAGES.device.auth, 'signed in (sudo {root}); --all needs reauth');
  assert.equal(PAGES.profile.auth, 'signed in (sudo {root})');
  assert.equal(ZH.manBody.device.auth, '已登录账号（sudo {root}）；--all 要再验证');
});

test('第 7 项：ask 进 root6 的 man（带一行 Gray AI 权限说明），不进普通用户的', async () => {
  const names = async (w) => (await run(sh(w), 'man')).out.slice(1).map((o) => o.seg[0][1]);
  assert.ok((await names('u:root')).includes('ask'), 'root6 列 ask');
  assert.ok(!(await names('u:alice')).includes('ask'), 'user 不列 ask');
  for (const w of ['link', 'styrigx', 'root']) assert.ok((await names(w)).includes('ask'), w + ' 照旧列 ask');
  assert.equal(PAGES.ask.desc.length, 1);
  assert.equal(EN.manBody.ask.desc[0], PAGES.ask.desc[0]);
  assert.equal(ZH.manBody.ask.desc[0], 'ask <问题>：开 AI 窗口，把问题发给 Gray AI；Gray AI 只对 styrigx 和 root 开放。');
});
