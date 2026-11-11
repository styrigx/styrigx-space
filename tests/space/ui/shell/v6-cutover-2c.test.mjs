/**
 * 2c（v6 割接后续）：当前页 su / exit / lock 之后页面标记就地切——前端这一侧。
 * - 终端身份 term/core/who.js：pageStateFor（同网关 pageStateOf：旧进站会话或非救援 v6 身份 → valid）；setV6 之后通知 onV6 订阅者（refresh 不通知）
 * - 顶栏 topbar-panel.js switchPageSession：只在网关注入过标记时切，变了才发 window 'sgx:session' { ok, live: true }
 * - 各处接住 live 事件：守卫补绑自动回锁、AI 窗口解锁 / 上锁、服务状态卡重取 / 锁卡（源码约定）
 * - 奇趣 / 日刻「su 登录后可编辑」入口指向 su（data-sec-open，退路 #sec），中英文 i18n
 * 运行：node --test tests/space/ui/shell/v6-cutover-2c.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { pageStateFor, createWho } from '../../../../space/web/assets/js/shell/term/core/who.js';
import { switchPageSession, SESSION_EVENT } from '../../../../space/web/assets/js/shell/topbar-panel.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const rd = (p) => readFileSync(path.join(REPO, p), 'utf8');
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

test('pageStateFor：旧进站会话或非救援 v6 身份 → valid；救援 / 没有 → locked', () => {
  assert.equal(pageStateFor(true, null), 'valid');
  assert.equal(pageStateFor(false, { name: 'styrigx' }), 'valid');
  assert.equal(pageStateFor(false, { name: 'root', root: true }), 'valid');
  assert.equal(pageStateFor(false, { name: 'alice' }), 'valid', 'su 成任何 v6 用户都算');
  assert.equal(pageStateFor(false, { name: 'root', root: true, rescue: true }), 'locked', '救援会话不算登录');
  assert.equal(pageStateFor(false, null), 'locked');
  assert.equal(pageStateFor(false, { name: '' }), 'locked');
  assert.equal(pageStateFor(true, { name: 'root', rescue: true }), 'valid', '旧进站会话在就还是 valid');
});

test('createWho：setV6（su / exit / lock）之后通知 onV6；有旧进站会话时 exit 回去仍 valid；refresh 不通知（网络错不误锁）', async () => {
  let lock = null;
  const who = createWho({ check: () => Promise.resolve(lock), page: () => 'locked' });
  const seen = [];
  who.onV6((s) => seen.push(s));
  who.setV6({ name: 'styrigx', uid: 1000 });
  who.setV6({ name: 'root', root: true, uid: 0 });
  who.setV6(null);
  assert.deepEqual(seen, ['valid', 'valid', 'locked']);
  lock = { ok: true, by: 'password' };
  await who.refresh();
  assert.deepEqual(seen, ['valid', 'valid', 'locked'], 'refresh 不通知');
  who.setV6({ name: 'styrigx' });
  who.setV6(null);
  assert.deepEqual(seen.slice(3), ['valid', 'valid'], '旧进站会话还在：exit 回去仍 valid');
});

function fakeDoc(state) {
  const attrs = state === undefined ? {} : { 'data-sgx-lock-session': state };
  const events = [];
  const win = { dispatchEvent: (e) => { events.push(e); return true; } };
  return {
    events,
    documentElement: { getAttribute: (n) => (n in attrs ? attrs[n] : null), setAttribute: (n, v) => { attrs[n] = String(v); } },
    defaultView: win,
    get state() { return attrs['data-sgx-lock-session']; },
  };
}

test('switchPageSession：locked → valid 就地切并发 live 事件；没变不发；没有网关标记（本地 / 测试构建）不动；不认识的值不动', () => {
  assert.equal(SESSION_EVENT, 'sgx:session');
  const d = fakeDoc('locked');
  assert.equal(switchPageSession(d, 'valid'), true);
  assert.equal(d.state, 'valid');
  assert.equal(d.events.length, 1);
  assert.equal(d.events[0].type, 'sgx:session');
  assert.deepEqual(d.events[0].detail, { ok: true, live: true });
  assert.equal(switchPageSession(d, 'valid'), false, '没变');
  assert.equal(d.events.length, 1);
  assert.equal(switchPageSession(d, 'locked'), true);
  assert.deepEqual(d.events[1].detail, { ok: false, live: true });
  const u = fakeDoc(undefined);
  assert.equal(switchPageSession(u, 'valid'), false);
  assert.equal(u.state, undefined);
  assert.equal(u.events.length, 0);
  assert.equal(switchPageSession(fakeDoc('locked'), 'x'), false);
});

test('源码约定：顶栏订阅 who.onV6 → switchPageSession（登录了重取 NAVIGATE STATUS）；守卫 / AI 窗口 / 服务状态页 / 云同步接 live 事件', () => {
  const tp = rd('space/web/assets/js/shell/topbar-panel.js');
  assert.match(tp, /who\.onV6\(function \(\/\*\* @type \{'valid'\|'locked'\} \*\/ st\) \{\s*if \(switchPageSession\(doc, st\) && st === 'valid' && status\) status\(\);/);
  const g = rd('space/web/assets/js/shell/space/guard.js');
  assert.match(g, /addEventListener\(SESSION_EVENT, function \(\/\*\* @type \{any\} \*\/ e\) \{ if \(e && e\.detail && e\.detail\.live && e\.detail\.ok\) bindAutoLock\(\); \}\)/);
  assert.match(g, /function checkSessionForAutoLock\(\) \{[\s\S]{0,120}if \(pageState\(\) !== 'valid'\) return;/);
  const ai = rd('space/web/assets/js/shell/ai-panel.js');
  assert.match(ai, /if \(d\.ok\) \{ setLocked\(false\); loadModels\(\); \} else setLocked\(true\);/);
  const st = rd('space/web/assets/js/apps/space-status.js');
  assert.match(st, /window\.addEventListener\('sgx:session'[\s\S]{0,260}if \(d\.ok\) \{ load\(\); return; \}\s*dropCache\(\);\s*data = null;\s*setState\('locked'\);/);
  const core = rd('space/web/assets/js/shell/core.js');
  assert.match(core, /bindSessionSync\(\);/);
});

test('守卫：页面标记就地切成 valid（live）→ 补绑自动回锁；首帧事件不重复绑', async () => {
  const winL = {};
  globalThis.window = {
    addEventListener: (t, f) => { (winL[t] = winL[t] || []).push(f); },
    dispatchEvent: (e) => { (winL[e.type] || []).forEach((f) => f(e)); return true; },
    innerWidth: 1000, location: { search: '', hostname: 'styrigx.com' },
  };
  const docL = {};
  globalThis.document = { documentElement: { dataset: { sgxLockSession: 'locked' } }, addEventListener: (t, f) => { (docL[t] = docL[t] || []).push(f); }, cookie: '', visibilityState: 'visible' };
  globalThis.SGX_TEST_NO_LOCK = false;
  globalThis.SGX_FEAT_LOCK_GATE = true;
  const G = await import('../../../../space/web/assets/js/shell/space/guard.js?2c');
  G.initLock();
  assert.equal((docL.visibilitychange || []).length, 0, '访客页不绑');
  document.documentElement.dataset.sgxLockSession = 'valid';
  window.dispatchEvent({ type: 'sgx:session', detail: { ok: true, live: true } });
  assert.equal((docL.visibilitychange || []).length, 1, '切成 valid 补绑');
  window.dispatchEvent({ type: 'sgx:session', detail: { ok: true, live: true } });
  assert.equal((docL.visibilitychange || []).length, 1, '只绑一次');
  /* 就地切回 locked：切回前台不查（不白刷一次） */
  let fetched = 0;
  globalThis.fetch = () => { fetched++; return Promise.resolve({ status: 401 }); };
  document.documentElement.dataset.sgxLockSession = 'locked';
  docL.visibilitychange[0]();
  await settle();
  assert.equal(fetched, 0);
});

test('奇趣 / 日刻：「登录账号后可编辑」改指向 su（中英文 i18n）；模板入口 su + data-sec-open + #sec；JS 的 su 分支同一套', () => {
  for (const site of ['curio', 'daymark']) {
    const zh = rd(`space/web/data/${site}/i18n/zh.yaml`);
    const en = rd(`space/web/data/${site}/i18n/en.yaml`);
    assert.doesNotMatch(zh, /登录账号后可编辑/, site);
    assert.doesNotMatch(en, /Sign in to your account to edit/, site);
    const z = yaml.load(zh);
    const e = yaml.load(en);
    const flat = (o, out = []) => { for (const v of Object.values(o || {})) { if (v && typeof v === 'object') flat(v, out); else out.push(String(v)); } return out; };
    assert.ok(flat(z).includes('su 登录后可编辑'), site);
    assert.ok(flat(z).includes('su 登录后可编辑。'), site);
    assert.ok(flat(e).includes('Sign in with su to edit'), site);
    assert.ok(flat(e).includes('Sign in with su to edit.'), site);
  }
  const cuT = rd('space/web/layouts/partials/curio/signin.html');
  assert.match(cuT, /<a id="cu-signin" class="sgx-cmd hidden" data-sec-open="" href="\{\{ \$home \}\}#sec"><span class="sgx-cmd-k" translate="no">su<\/span>/);
  const dmT = rd('space/web/layouts/daymark/section.html');
  assert.equal((dmT.match(/data-dm-signin class="sgx-cmd hidden" data-sec-open="" href="\{\{ partial [^}]*\}\}#sec"><span class="sgx-cmd-k" translate="no">su<\/span>/g) || []).length, 2);
  assert.doesNotMatch(dmT, /data-acct-app="daymark"/);
  for (const f of ['space/web/assets/curio/js/curio.js', 'space/web/assets/daymark/js/daymark.js']) {
    const s = rd(f);
    assert.match(s, /return \{ text: T\.signin, open: '', app: '', su: true \};/, f);
    assert.match(s, /a\.setAttribute\('data-sec-open', ''\);\s*a\.setAttribute\('href', base \+ '#sec'\);\s*if \(k\) k\.textContent = 'su';/, f);
  }
});
