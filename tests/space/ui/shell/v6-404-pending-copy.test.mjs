/**
 * 割接 2f：#404 未决项文案（Gray 11-11 15:37 / 15:39 定稿，Muse 草稿 v6-404-pending-copy；Hark 调整：lock passkey 指向 passkey 命令、device / profile 不在本 PR）——
 * - 第 2 项：sudo sub（P4-3 起 sudo sub / sudo device 接通，定稿 v5.5 §四；没有调用的 sudoNotYet 键与文案删除，Gray 11-11 22:46；sudo app 随 app 命令删除，落到 sudo 用法行）
 * - 第 3 项：v6 身份输 sudo -v / sudo root reauth / lock passwd | passkey | --all → 「已移除 · v6 做法」一行（不落 notHere）；旧身份照旧（P4 删）
 * - 第 4 项：man lock / share / passwd / sub 的 AUTH 行（app 页随应用授权删除）按 v6 改写（pages.js / zh / en 同步）
 * - 第 7 项：ask 进 root6 的 man，不进普通用户（user）的
 * - #406 未决 3：v6 路径的 passkey 用法行带 ls（v6-commands「passkey ls / add / rm <n>」）
 * v6 P4：旧身份和旧命令本身删了——「已移除」那几行对所有身份都印；share 的 man 页删了；device / profile 的 AUTH 改成「已登录」。
 * 运行：node --test tests/space/ui/shell/v6-404-pending-copy.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { createShell, TERM_EN } from '../../../../space/web/assets/shell/js/term/terminal.js';
import { PAGES } from '../../../../space/web/assets/shell/js/term/man/pages.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const Y = (p) => yaml.load(readFileSync(path.join(REPO, p), 'utf8'));
const ZH = Y('space/web/data/shell/sgx-shell-i18n/zh.yaml');
const EN = Y('space/web/data/shell/sgx-shell-i18n/en.yaml');

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
  for (const k of ['usagePasskey6']) {
    assert.equal(EN.term[k], TERM_EN[k], 'en.' + k);
    assert.ok(typeof ZH.term[k] === 'string' && ZH.term[k] && ZH.term[k] !== TERM_EN[k], 'zh.' + k);
  }
});

test('第 2 项（P4-3）：sudo sub 接通——交给身份层先验自己的凭据，再在账号层借 root 跑这一行；sudoNotYet 键与文案删除（Gray 11-11 22:46）；sudo app 落到用法行', () => {
  assert.equal('sudoNotYet' in TERM_EN, false);
  assert.equal('sudoNotYet' in ZH.term, false);
  assert.equal('sudoNotYet' in EN.term, false);
  for (const w of ['u:styrigx', 'u:root']) {
    const calls = [];
    const v = { ident: { hasSession: () => true, sudoProof: (done) => { calls.push('proof'); done(null); } }, acct: { sudo: (via) => calls.push(['sudo', via]), cmdSub: (l, g) => calls.push(['sub', l, g]) } };
    assert.equal(sh(w).exec('sudo sub show Foo', v).flow, true, w);
    assert.deepEqual(calls, ['proof', ['sudo', null], ['sub', 'sub show Foo', undefined]], w + '：来源名大小写原样');
    const L = layers();
    assert.equal(text(sh(w).exec('sudo app allow 1', L.v).out[0]), TERM_EN.usageSudo, w);
  }
});

test('旧命令 sudo -v / sudo root reauth / lock passwd | passkey | --all 删干净（Gray 2026-11-12 15:59「命令不需要」）：不留「已移除」提示，落到用法行，不跑任何层', () => {
  for (const k of ['goneSudoV', 'goneSudoReauth', 'goneLockPasswd', 'goneLockPasskey', 'goneLockAll']) {
    assert.equal(k in TERM_EN, false, k);
    assert.equal(k in EN.term, false, 'en.' + k);
    assert.equal(k in ZH.term, false, 'zh.' + k);
  }
  const want = { 'sudo -v': TERM_EN.usageSudo, 'sudo root reauth': TERM_EN.usageSudo, 'lock passwd': TERM_EN.usageLock, 'lock passkey': TERM_EN.usageLock, 'lock passkey add': TERM_EN.usageLock, 'lock --all': TERM_EN.usageLock };
  for (const w of ['u:styrigx', 'u:root']) {
    for (const [l, u] of Object.entries(want)) {
      const L = layers();
      const o = sh(w).exec(l, L.v).out;
      assert.equal(o.length, 1, w + ' ' + l);
      assert.equal(text(o[0]), u, w + ' ' + l);
      assert.equal(L.calls.length, 0, w + ' ' + l + ' 不跑任何层');
    }
  }
});

test('第 3 项：lock（不带参数）清 v6 身份栈；带参数一律用法行', () => {
  const L = layers();
  assert.equal(sh('u:styrigx').exec('lock', L.v).flow, true);
  assert.deepEqual(L.calls, [['ident.cmdLock']]);
  assert.equal(text(sh('u:styrigx').exec('lock --all', {}).out[0]), 'usage: lock');
  assert.equal(text(sh('u:styrigx').exec('lock', {}).out[0]), 'lock: run it in the terminal (Ctrl K)');
  assert.equal(text(sh('u:styrigx').exec('lock x', L.v).out[0]), 'usage: lock');
});

test('#406 未决 3：passkey 用法行带 ls（v6 P4 起只有这一种）', () => {
  const v6 = { v: { acct: { inReset: false } } };
  assert.equal(text(sh('u:styrigx').exec('passkey rm x', v6.v).out[0]), 'usage: passkey [ls | add | rm <n>]');
  assert.equal(text(sh('u:styrigx', ZH.term).exec('passkey foo', v6.v).out[0]), '用法：passkey [ls | add | rm <n>]');
  assert.equal(TERM_EN.usagePasskey, undefined, '旧用法行删了');
});

test('第 4 项：man lock / passwd / sub 的 AUTH 行按 v6 改写（pages.js / en / zh 同步）；v6 P4：share 页删了，device / profile = 已登录；app 页随应用授权删了', () => {
  const want = {
    lock: ['no verification', '不用验证'],
    passwd: ['signed in; asks your current password first', '已登录；先输当前密码'],
    sub: ['root only; show, key and token reset need no reauth', '只有 root；show、key 和 token reset 不用再验证'],
  };
  for (const [c, [en, zh]] of Object.entries(want)) {
    assert.equal(PAGES[c].auth, en, 'pages.' + c);
    assert.equal(EN.manBody[c].auth, en, 'en.' + c);
    assert.equal(ZH.manBody[c].auth, zh, 'zh.' + c);
  }
  assert.equal(PAGES.passkey.auth, 'signed in');
  assert.equal(PAGES.share, undefined);
  assert.equal(PAGES.app, undefined);
  assert.equal(EN.manBody.app, undefined);
  assert.equal(ZH.manBody.app, undefined);
  assert.equal(EN.manBody.share, undefined);
  assert.equal(ZH.manBody.share, undefined);
  for (const c of ['device', 'profile']) {
    assert.equal(PAGES[c].auth, 'signed in', c);
    assert.equal(EN.manBody[c].auth, 'signed in', c);
    assert.equal(ZH.manBody[c].auth, '已登录', c);
  }
});

test('第 7 项：ask 进 root6 的 man（带一行 Gray AI 权限说明），不进普通用户的', async () => {
  const names = async (w) => (await run(sh(w), 'man')).out.slice(1).map((o) => o.seg[0][1]);
  assert.ok((await names('u:root')).includes('ask'), 'root6 列 ask');
  assert.ok(!(await names('u:alice')).includes('ask'), 'user 不列 ask');
  assert.ok(!(await names('nobody')).includes('ask'), '访客不列 ask');
  assert.equal(PAGES.ask.desc.length, 1);
  assert.equal(EN.manBody.ask.desc[0], PAGES.ask.desc[0]);
  assert.equal(ZH.manBody.ask.desc[0], 'ask <问题>：开 AI 窗口，把问题发给 Gray AI；Gray AI 只对 ai 组开放。');
});
