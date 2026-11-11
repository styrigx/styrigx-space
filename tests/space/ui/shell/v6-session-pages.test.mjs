/**
 * 2b（v6 割接后续）：前端按 v6 身份——
 * - 守卫 shell/space/guard.js：v6 登录标记 / whoami（旧进站会话 401 时 v6 还在就不重载）
 * - 终端 share（cmds/keys/share.js）：v6 root 直接做（不跑旧锁侧复验），v6 普通用户提示先 su root、不进流程；man 给 root6 列 share
 * - 403 forbidden（有 v6 身份但档不够）的文案：分享磁贴、AI 窗口、钥匙层错误码表、服务状态页、奇趣 / 日刻
 * 运行：node --test tests/space/ui/shell/v6-session-pages.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { createShell, TERM_EN } from '../../../../space/web/assets/js/shell/terminal.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const rd = (p) => readFileSync(path.join(REPO, p), 'utf8');

function mem() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
function fixedWho(w) { return { get: () => w, on() {} }; }
const act = { cd: () => ({ kind: 'scroll', label: '' }), theme() {}, ask() {}, find: () => Promise.resolve({ ok: true, results: [] }), today: () => Promise.resolve(null), daymarkHref: () => '/daymark/', close() {} };
const text = (o) => o.seg.map((s) => s[1]).join('');
function layers() {
  const calls = [];
  const rec = (n) => (...a) => calls.push([n, ...a]);
  const space = { inReset: false, shareList: rec('shareList'), shareAdd: rec('shareAdd'), shareRm: rec('shareRm'), shareRmAll: rec('shareRmAll') };
  return { v: { space, acct: {}, ident: { hasSession: () => true } }, calls };
}

test('守卫：hasV6Marker 只认 sgx-id=1；v6SignedIn 按 whoami（有身份 true / 没有 false / 网络错 null）', async () => {
  globalThis.document = { cookie: 'x=1; sgx-id=1' };
  const G = await import('../../../../space/web/assets/js/shell/space/guard.js');
  assert.equal(G.hasV6Marker(), true);
  document.cookie = 'sgx-id=0';
  assert.equal(G.hasV6Marker(), false);
  const sent = [];
  let reply = { ok: true, user: { name: 'styrigx' } };
  globalThis.fetch = (u, init) => { sent.push([u, init.method, init.body]); return Promise.resolve({ ok: true, json: () => Promise.resolve(reply) }); };
  assert.equal(await G.v6SignedIn(), true);
  assert.deepEqual(sent[0], ['/api/identity', 'POST', JSON.stringify({ action: 'whoami' })]);
  reply = { ok: true, user: null };
  assert.equal(await G.v6SignedIn(), false);
  globalThis.fetch = () => Promise.reject(new Error('offline'));
  assert.equal(await G.v6SignedIn(), null, '网络错不当没有（不重载）');
  const src = rd('space/web/assets/js/shell/space/guard.js');
  assert.match(src, /if \(!hasV6Marker\(\)\) \{ sgxReload\(\); return; \}/);
  assert.match(src, /if \(on === false\) sgxReload\(\)/);
});

test('share：v6 root 直接做（direct，不跑旧锁侧复验）；v6 普通用户提示先 su root、不进流程；旧身份照旧', () => {
  const L = layers();
  const root6 = createShell({ act, storage: mem(), who: fixedWho('u:root') });
  root6.exec('share', L.v);
  root6.exec('share rm 2', L.v);
  root6.exec('share rm --all', L.v);
  root6.exec('share add', L.v);
  assert.deepEqual(L.calls, [['shareList', { direct: true }], ['shareRm', 2, { direct: true }], ['shareRmAll', { direct: true }], ['shareAdd']]);
  const L2 = layers();
  const u = createShell({ act, storage: mem(), who: fixedWho('u:styrigx') });
  for (const l of ['share', 'share add', 'share rm 1']) assert.equal(text(u.exec(l, L2.v).out[0]), 'permission denied · run su root first', l);
  assert.deepEqual(L2.calls, []);
  const L3 = layers();
  createShell({ act, storage: mem(), who: fixedWho('styrigx') }).exec('share', L3.v);
  assert.deepEqual(L3.calls, [['shareList', { direct: false }]], '旧进站身份照旧走锁侧复验');
  assert.equal(TERM_EN.needRoot6, 'permission denied · run {x} first');
});

test('man：root6 列 share，v6 普通用户不列', async () => {
  const names = async (w) => (await createShell({ act, storage: mem(), who: fixedWho(w) }).exec('man')).out.slice(1).map((o) => o.seg[0][1]);
  assert.ok((await names('u:root')).includes('share'));
  assert.ok(!(await names('u:alice')).includes('share'));
});

test('403 forbidden 文案：分享磁贴 / AI 窗口 / 钥匙层错误码表各有自己的一句，不再落到「会话过期」或「服务不可用」', async () => {
  const SB = await import('../../../../space/web/assets/js/shell/share-button.js');
  assert.equal(SB.errKey(403, { error: 'forbidden' }), 'forbidden');
  assert.equal(SB.errKey(401, {}), 'session');
  const AI = await import('../../../../space/web/assets/js/shell/ai-panel.js');
  assert.equal(AI.errKey(403, { error: 'forbidden' }), 'forbidden');
  assert.equal(AI.errKey(401, {}), 'unauthorized');
  const API = rd('space/web/assets/js/shell/space/api.js');
  assert.match(API, /'forbidden': 'errForbidden'/);
  for (const lang of ['en', 'zh']) {
    const t = yaml.load(rd('space/web/data/sgx-shell-i18n/' + lang + '.yaml'));
    assert.ok(t.share.forbidden && t.ai.forbidden && t.space.common.errForbidden && t.term.needRoot6, lang);
    const st = yaml.load(rd('space/web/data/i18n/' + lang + '.yaml'));
    assert.ok(JSON.stringify(st).includes('auditErrPerm'), lang + ' 服务状态页 auditErrPerm');
  }
  const status = rd('space/web/assets/js/apps/space-status.js');
  assert.match(status, /status === 401 \|\| status === 403/, '状态卡 403 → 锁卡（不是错误卡）');
  assert.match(status, /perm \? 'auditErrPerm'/);
});

test('奇趣 / 日刻：403 forbidden → noPermission（四处错误文案 + 两种语言）', () => {
  assert.match(rd('space/web/assets/curio/js/curio.js'), /c === 'forbidden' \? \(T\.noPermission/);
  assert.match(rd('space/web/assets/curio/js/curio-items.js'), /c === 'forbidden'\) return T\.noPermission/);
  assert.match(rd('space/web/assets/curio/js/curio-music.js'), /e\.code === 'forbidden' && T\.noPermission/);
  assert.match(rd('space/web/assets/daymark/js/daymark.js'), /c === 'forbidden' && T\.noPermission/);
  for (const lang of ['en', 'zh']) {
    const c = yaml.load(rd('space/web/data/curio/i18n/' + lang + '.yaml')).js;
    for (const s of ['curio', 'curioItems', 'curioMusic']) assert.ok(c[s].noPermission, lang + ' curio.' + s);
    assert.ok(yaml.load(rd('space/web/data/daymark/i18n/' + lang + '.yaml')).js.daymark.noPermission, lang + ' daymark');
  }
});
