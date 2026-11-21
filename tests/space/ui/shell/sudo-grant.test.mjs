/**
 * D-3 a′「先验后发票」前端（偏离收尾定稿 v4 第 9 节）：
 * - term/core/sudo-grant.js takeSudoGrant：页面登记的待办，终端回车原样那一行才取走；过期作废；改过的行不动它
 * - sudo 命令：预填行 → 身份层 sudoGrant(grant, 去掉 sudo 的标签, done)；改过的行按普通 sudo 解析；没有身份层（AI 窗口）→ notHere
 * - 身份层 C.sudoGrant：root 直接 done('')；非 sudoers 报找不到命令（sudo）、不发请求；sudoers 先验自己的凭据（sudo-challenge）再 POST sudo-grant，票只交回 done
 * 后端（发票、验票）见 tests/workers/account/sudo-ticket.test.mjs。
 * 运行：node --test tests/space/ui/shell/sudo-grant.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShell } from '../../../../space/web/assets/common/js/frame/term/terminal.js';
import { takeSudoGrant, SUDO_GRANT_KEY, SUDO_GRANT_WAIT_MS } from '../../../../space/web/assets/common/js/frame/term/core/sudo-grant.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const rd = (p) => readFileSync(path.join(REPO, p), 'utf8');

function mem() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
function fixedWho(w) { return { get: () => w, on() {} }; }
const act = { cd: () => ({ kind: 'scroll', label: '' }), theme() {}, ask() {}, find: () => Promise.resolve({ ok: true, results: [] }), today: () => Promise.resolve(null), daymarkHref: () => '/daymark/', close() {} };
const run = async (sh, line, v) => { const r = sh.exec(line, v); return r && typeof r.then === 'function' ? await r : r; };
function layers() {
  const calls = [];
  const rec = (n) => (...a) => { calls.push([n, ...a]); };
  const ident = { hasSession: () => true, cmdSudo: rec('cmdSudo'), sudoGrant: rec('sudoGrant'), sudoProof: rec('sudoProof') };
  return { v: { acct: {}, ident }, calls };
}
const LINE = 'sudo curio music rm 3';
const GRANT = { method: 'POST', path: '/music/api/music', action: 'album.del' };
function pend(w, extra) { const done = () => {}; w[SUDO_GRANT_KEY] = Object.assign({ line: LINE, grant: GRANT, done, at: 1000 }, extra || {}); return done; }

test('takeSudoGrant：原样那一行才取走（前后空白不计），取走后键删掉；grant 规范成字符串', () => {
  const w = {};
  const done = pend(w);
  assert.equal(takeSudoGrant('sudo curio music rm 4', w, 2000), null, '改过的行不取');
  assert.ok(w[SUDO_GRANT_KEY], '改过的行不动待办');
  const r = takeSudoGrant('  ' + LINE + ' ', w, 2000);
  assert.ok(r);
  assert.equal(r.line, LINE);
  assert.deepEqual(r.grant, GRANT);
  assert.equal(r.done, done);
  assert.equal(w[SUDO_GRANT_KEY], undefined, '取走后删掉，只能用一次');
  assert.equal(takeSudoGrant(LINE, w, 2000), null, '第二次回车没有待办');
  const w2 = {};
  pend(w2, { grant: { method: 'GET', path: '/curio/api/export' } });
  assert.equal(takeSudoGrant(LINE, w2, 2000).grant.action, undefined, '没有 action 就不带');
});

test('takeSudoGrant：过期（≥ 等待时长）作废并删掉；没有待办 / 缺字段 → null', () => {
  const w = {};
  pend(w);
  assert.ok(takeSudoGrant(LINE, Object.assign({}, w), 1000 + SUDO_GRANT_WAIT_MS - 1), '差 1 ms 仍有效');
  assert.equal(takeSudoGrant(LINE, w, 1000 + SUDO_GRANT_WAIT_MS), null);
  assert.equal(w[SUDO_GRANT_KEY], undefined, '过期的删掉');
  assert.equal(takeSudoGrant(LINE, {}, 0), null);
  for (const bad of [null, 'x', { line: LINE, grant: GRANT }, { line: LINE, done() {} }, { line: 3, grant: GRANT, done() {} }]) {
    assert.equal(takeSudoGrant(LINE, { [SUDO_GRANT_KEY]: bad }, 0), null, JSON.stringify(bad));
  }
  assert.equal(takeSudoGrant(LINE, null, 0), null);
});

test('sudo 命令：预填行 → 身份层 sudoGrant（标签去掉 sudo）；改过的行走普通 sudo；没有身份层 → notHere', async () => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const old = globalThis.window;
  globalThis.window = {};
  try {
    const sh = createShell({ act, storage: mem(), who: fixedWho('u:styrigx') });
    const L = layers();
    const done = pend(globalThis.window, { at: Date.now() });
    const r = await run(sh, LINE, L.v);
    assert.equal(r.flow, true);
    const call = L.calls.find((c) => c[0] === 'sudoGrant');
    assert.ok(call, '调了 sudoGrant');
    assert.deepEqual(call[1], GRANT);
    assert.equal(call[2], 'curio music rm 3');
    assert.equal(call[3], done);
    assert.equal(globalThis.window[SUDO_GRANT_KEY], undefined, '待办已取走');

    const L2 = layers();
    pend(globalThis.window, { at: Date.now() });
    await run(sh, 'sudo who', L2.v);
    assert.ok(!L2.calls.some((c) => c[0] === 'sudoGrant'), '别的 sudo 行不领票');
    assert.deepEqual(L2.calls.at(-1), ['cmdSudo', ['who']]);
    assert.ok(globalThis.window[SUDO_GRANT_KEY], '待办留着等原样那一行');

    const r3 = await run(sh, LINE);
    assert.ok(!r3.flow && r3.out.length, '没有身份层（AI 窗口）→ 提示去终端');
  } finally {
    if (had) globalThis.window = old; else delete globalThis.window;
  }
});

test('身份层 C.sudoGrant：root 直接 done("")；非 sudoers 找不到命令；sudoers 先 sudo-challenge 验凭据再 POST sudo-grant，票只交 done', () => {
  const src = rd('space/web/assets/common/js/frame/account/identity/layer.js');
  const i = src.indexOf('C.sudoGrant = function (grant, label, done) {');
  assert.ok(i > 0, '有 C.sudoGrant');
  const body = src.slice(i, src.indexOf('\n  };', i));
  const at = (re) => { const m = re.exec(body); assert.ok(m, String(re)); return m.index; };
  const signed = at(/if \(!u\) \{ C\.err\(t\('notSignedIn'\)\); return; \}/);
  const root = at(/if \(u\.root\) \{ done\(''\); C\.ok\(t\('sudoGranted'\)\); return; \}/);
  /* 不在 sudoers = 没有 sudo 这条命令 → 找不到命令（v1.1 §九，Gray 2026-11-21 02:23） */
  const sudoers = at(/if \(!u\.sudoers\) \{ notFound\('sudo'\); return; \}/);
  const proof = at(/proofOf\(t\('pwFor', \{ u: u\.name \}\), 'sudo-challenge', function \(proof\) \{/);
  const post = at(/api\.post\('sudo-grant', Object\.assign\(\{ command: grant \}, proof\)\)/);
  assert.ok(signed < root && root < sudoers && sudoers < proof && proof < post, '顺序：未登录 → root → sudoers → 验凭据 → 领票');
  assert.match(body, /typeof r\.j\.ticket === 'string'\) \{ done\(r\.j\.ticket\);/, '拿到票才 done');
  assert.match(body, /fail\(r, label\); C\.toCmd\(\);/, '失败按标签报错、不 done');
  assert.ok(!/C\.(?:out|ok|err|note)\([^)]*ticket/.test(body), '票不打印');
  for (const f of ['zh', 'en']) assert.match(rd('space/web/data/common/frame/i18n/' + f + '.yaml'), /\n\s+sudoGranted: "/, f + ' 有 sudoGranted');
});
