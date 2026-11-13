/**
 * 2b（v6 割接后续）：前端按 v6 身份——
 * - 守卫 shell/space/guard.js：v6 登录标记 / whoami（旧进站会话 401 时 v6 还在就不重载）
 * - 终端 share（cmds/keys/share.js）：v6 root 直接做（不跑旧锁侧复验），v6 普通用户提示先 su root、不进流程；man 给 root6 列 share
 * - 403 forbidden（有 v6 身份但档不够）的文案：分享磁贴、AI 窗口、钥匙层错误码表、服务状态页、奇趣 / 日刻
 * v6 P4：终端 share、分享磁贴的短链、钥匙层错误码表删了。
 * 运行：node --test tests/space/ui/shell/v6-session-pages.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { createShell, TERM_EN } from '../../../../space/web/assets/shell/js/term/terminal.js';

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
  const G = await import('../../../../space/web/assets/shell/js/auth/guard.js');
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
  const src = rd('space/web/assets/shell/js/auth/guard.js');
  assert.match(src, /if \(!hasV6Marker\(\)\) \{ sgxReload\(\); return; \}/);
  assert.match(src, /if \(on === false\) sgxReload\(\)/);
});

test('v6 P4：终端 share 命令删了（定稿 §二 分享短链整套删除）；man 不列', async () => {
  const L = layers();
  const r = createShell({ act, storage: mem(), who: fixedWho('u:root') }).exec('share', L.v);
  assert.match(text(r.out[0]), /command not found: share/);
  assert.deepEqual(L.calls, []);
  const names = async (w) => (await createShell({ act, storage: mem(), who: fixedWho(w) }).exec('man')).out.slice(1).map((o) => o.seg[0][1]);
  assert.ok(!(await names('u:root')).includes('share'));
  assert.equal(TERM_EN.needRoot6, 'permission denied · run {x} first');
});

test('403 forbidden 文案：AI 窗口有自己的一句，不再落到「会话过期」或「服务不可用」（v6 P4：分享磁贴不再生成短链、钥匙层删了）', async () => {
  assert.equal(existsSync(path.join(REPO, 'space/web/assets/shell/js/shell/share-button.js')), false, 'v6 P4：分享磁贴拿掉（Gray 11-11 17:47）');
  const AI = await import('../../../../space/web/assets/shell/js/ai/ai-panel.js');
  assert.equal(AI.errKey(403, { error: 'forbidden' }), 'forbidden');
  assert.equal(AI.errKey(401, {}), 'unauthorized');
  for (const lang of ['en', 'zh']) {
    const t = yaml.load(rd('space/web/data/sgx-shell-i18n/' + lang + '.yaml'));
    assert.ok(t.ai.forbidden && t.term.needRoot6, lang);
    assert.equal(t.share, undefined, lang + ' 分享磁贴的文案整节删了');
    const st = yaml.load(rd('space/web/data/i18n/' + lang + '.yaml'));
    assert.ok(JSON.stringify(st).includes('auditErrPerm'), lang + ' 服务状态页 auditErrPerm');
  }
  const status = rd('space/web/assets/shell/js/apps/space-status.js');
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
