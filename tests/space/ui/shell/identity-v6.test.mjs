/**
 * v6 身份统一 P2b（终端）：提示符 user@space:path、身份合成（v6 先于旧身份）、man 只给 v6 身份列新命令、命令分流
 * （sudo <管理命令> / exit / lock / passwd 有 v6 会话时转身份层，旧写法原样）、参数解析、前台空闲计时、头像 = whoami 的接线。
 * v6 P4（定稿 v5.2 §十三）起旧身份（link / styrigx / root@account）和旧写法（sudo styrigx / sudo root / sudo -v、lock passwd …）删了，只剩 v6。
 * 运行：node --test tests/space/ui/shell/identity-v6.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShell, createWho, ps1 } from '../../../../space/web/assets/js/shell/terminal.js';
import { kindOf, isV6, title } from '../../../../space/web/assets/js/shell/term/core/who.js';
import { parseUseradd, parseUsermod, sudoCommand, USER_NAME_RE } from '../../../../space/web/assets/js/shell/term/core/ident-args.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const rd = (p) => readFileSync(path.join(REPO, p), 'utf8');

function mem() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
function fixedWho(w) { let cur = w; const subs = []; return { get: () => cur, on: (f) => subs.push(f), set: (x) => { cur = x; subs.forEach((f) => f(x)); } }; }
const act = { cd: () => ({ kind: 'scroll', label: '' }), theme() {}, ask() {}, find: () => Promise.resolve({ ok: true, results: [] }), today: () => Promise.resolve(null), daymarkHref: () => '/daymark/', close() {} };
function layers(session) {
  const calls = [];
  const rec = (n, ret) => (...a) => { calls.push([n, ...a]); return ret; };
  const ident = { hasSession: () => session, cmdWhoami: rec('whoami'), cmdSu: rec('su'), cmdGroups: rec('groups'), cmdWho: rec('who'), cmdAdmin: rec('admin'),
    cmdSudo: rec('sudo'), cmdExit: rec('exit', session), cmdLock: rec('lock'), cmdPasswd: rec('passwd'), cmdRescue: rec('rescue') };
  const acct = {};
  return { v: { acct, ident }, calls };
}
const run = async (sh, line, v) => { const r = sh.exec(line, v); return r && typeof r.then === 'function' ? await r : r; };

test('提示符（定稿 v4 §七）：v6 普通用户 <名>@space:<路径>$，v6 root root@space:<路径>#；访客 nobody@space:~$（v6 P4 起旧身份删了）', () => {
  assert.equal(ps1('u:styrigx', '~'), 'styrigx@space:~$');
  assert.equal(ps1('u:alice', 'blog'), 'alice@space:~/blog$');
  assert.equal(ps1('u:root', 'curio'), 'root@space:~/curio#');
  assert.equal(title('u:root', '~'), 'root@space: ~');
  assert.equal(ps1('nobody', '~'), 'nobody@space:~$');
  assert.equal(kindOf('u:alice'), 'user');
  assert.equal(kindOf('u:root'), 'root6');
  assert.equal(kindOf('nobody'), 'nobody');
  assert.ok(isV6('u:x') && !isV6('root'));
});

test('createWho（v6 P4：只有 v6）：首帧访客，refresh 问 whoami 以回答为准；setV6(null) 回访客；whoami 出错不改；首帧标记 v6Hinted', async () => {
  let user = { name: 'styrigx', root: false };
  const w = createWho({ whoami: () => Promise.resolve(user), v6Hint: () => true });
  assert.equal(w.get(), 'nobody', '首帧不猜，等 refresh');
  assert.equal(w.v6Hinted(), true);
  assert.equal(await w.refresh(), 'u:styrigx');
  w.setV6({ name: 'root', root: true, via: 'styrigx' });
  assert.equal(w.get(), 'u:root');
  w.setV6(null);
  assert.equal(w.get(), 'nobody', '没有 v6 会话 → 访客');
  user = null;
  assert.equal(await w.refresh(), 'nobody');
  /* whoami 出错（undefined）不改 v6 状态 */
  w.setV6({ name: 'alice' });
  const w2 = createWho({ whoami: () => Promise.reject(new Error('x')) });
  assert.equal(await w2.refresh(), 'nobody');
  const w3 = createWho({ whoami: () => Promise.resolve(undefined) });
  w3.setV6({ name: 'alice' });
  assert.equal(await w3.refresh(), 'u:alice', '没问到不改');
  assert.equal(createWho({}).v6Hinted(), false);
  w.drop();
  assert.equal(w.get(), 'nobody', 'drop 回访客');
});

test('man（P4-3，定稿 v5.5 §四）：按 root → 站长 → 普通用户 → 访客分段、各人只看到自己这一层及以下，root 看全部；ask 按 ai 组、sudo 按 sudoers 组', async () => {
  const out = async (w, u) => (await run(createShell({ act, storage: mem(), who: Object.assign(fixedWho(w), { v6: () => u || null }) }), 'man')).out.slice(1).map((o) => o.seg[0][1]);
  const names = async (w, u) => (await out(w, u)).filter(Boolean);
  const n0 = await names('nobody');
  for (const c of ['whoami', 'su', 'groups', 'who', 'useradd', 'userdel', 'usermod', 'lock', 'passwd', 'passkey', 'device', 'profile', 'sub', 'sudo', 'ask']) assert.ok(!n0.includes(c), 'nobody 不列 ' + c);
  assert.ok(n0.includes('find') && n0.includes('man'));
  const alice = { name: 'alice', owner: false, groups: ['listen', 'ai'] };
  const u = await names('u:alice', alice);
  for (const c of ['whoami', 'su', 'groups', 'who', 'lock', 'passwd', 'profile', 'exit', 'ask', 'find']) assert.ok(u.includes(c), 'user 列 ' + c);
  for (const c of ['passkey', 'device', 'sudo', 'useradd', 'userdel', 'usermod', 'sub', 'app', 'share']) assert.ok(!u.includes(c), 'user 不列 ' + c);
  assert.ok(!(await names('u:alice', { name: 'alice', owner: false, groups: ['listen'] })).includes('ask'), '不在 ai 组不列 ask');
  const sty = { name: 'styrigx', owner: true, groups: ['wheel', 'sudoers', 'listen', 'ai', 'status', 'curio-write', 'daymark-write'] };
  const o = await names('u:styrigx', sty);
  for (const c of ['passkey', 'device', 'sudo', 'ask', 'passwd', 'whoami', 'find', 'man']) assert.ok(o.includes(c), '站长列 ' + c);
  for (const c of ['useradd', 'userdel', 'usermod', 'sub']) assert.ok(!o.includes(c), '站长不列 root 层 ' + c);
  const ol = await out('u:styrigx', sty);
  assert.ok(ol.indexOf('passkey') < ol.indexOf('passwd') && ol.indexOf('passwd') < ol.indexOf('man'), '站长层在前、普通用户层其次、访客层最后');
  assert.ok(ol.includes(''), '段与段之间空一行');
  const r = await names('u:root', { name: 'root', root: true, groups: [] });
  for (const c of ['whoami', 'groups', 'who', 'useradd', 'userdel', 'usermod', 'passwd', 'lock', 'sub', 'device', 'profile', 'passkey', 'sudo', 'ask', 'su', 'find']) assert.ok(r.includes(c), 'root6 看全部：' + c);
  const rl = await out('u:root', { name: 'root', root: true, groups: [] });
  assert.deepEqual(rl.slice(0, rl.indexOf('')), ['sub', 'useradd', 'userdel', 'usermod'], 'root 层在最前');
  assert.ok(!r.includes('app'), '应用授权删了（定稿 v5.3 §十二）：root6 也不列 app');
  assert.ok(!r.includes('rescue'), 'rescue 不进索引（audience 空）');
  assert.ok(!r.includes('share'), 'v6 P4：share 删了');
});

test('命令分流：sudo <管理命令> → 身份层（每次验自己的凭据）；v6 P4：sudo styrigx / sudo root 旧写法删了 → 用法', async () => {
  const sh = createShell({ act, storage: mem(), who: fixedWho('u:styrigx') });
  const L = layers(true);
  assert.equal((await run(sh, 'sudo useradd bob -e 2099-12-01 -G listen', L.v)).flow, true);
  assert.deepEqual(L.calls.at(-1), ['sudo', ['useradd', 'bob', '-e', '2099-12-01', '-G', 'listen']]);
  await run(sh, 'sudo passwd alice', L.v);
  assert.deepEqual(L.calls.at(-1), ['sudo', ['passwd', 'alice']]);
  await run(sh, 'sudo who', L.v);
  assert.deepEqual(L.calls.at(-1), ['sudo', ['who']]);
  const old = createShell({ act, storage: mem(), who: fixedWho('nobody') });
  const L2 = layers(false);
  for (const line of ['sudo styrigx', 'sudo styrigx reset', 'sudo']) {
    const r = await run(old, line, L2.v);
    assert.ok(r.out.length && !r.flow, line + ' → 用法');
    assert.match(r.out[0].seg.map((x) => x[1]).join(''), /sudo useradd/, line + ' 的用法行是 v6 写法');
  }
  /* 访客输 sudo root …：同 main 的门，先提示 su */
  for (const line of ['sudo root', 'sudo root reset']) {
    const r = await run(old, line, L2.v);
    assert.match(r.out[0].seg.map((x) => x[1]).join(''), /^not signed in · su <user> first$/, line);
  }
  assert.equal(L2.calls.length, 0, '旧写法不进任何层');
  /* AI 窗口（没有层）：要在终端里跑 */
  assert.equal((await run(sh, 'sudo who')).flow, undefined);
});

test('命令分流：exit / lock / passwd 转身份层；su / whoami / groups / who / useradd / userdel / usermod 查参数', async () => {
  const sh = createShell({ act, storage: mem(), who: fixedWho('u:alice') });
  const L = layers(true);
  await run(sh, 'exit', L.v);
  assert.deepEqual(L.calls.at(-1), ['exit']);
  await run(sh, 'lock', L.v);
  assert.deepEqual(L.calls.at(-1), ['lock']);
  await run(sh, 'passwd', L.v);
  assert.deepEqual(L.calls.at(-1), ['passwd', '']);
  await run(sh, 'passwd bob', L.v);
  assert.deepEqual(L.calls.at(-1), ['passwd', 'bob']);
  await run(sh, 'su root', L.v);
  assert.deepEqual(L.calls.at(-1), ['su', 'root']);
  await run(sh, 'whoami', L.v);
  assert.deepEqual(L.calls.at(-1), ['whoami']);
  await run(sh, 'groups styrigx', L.v);
  assert.deepEqual(L.calls.at(-1), ['groups', 'styrigx']);
  await run(sh, 'usermod -aG listen,ai bob', L.v);
  assert.deepEqual(L.calls.at(-1), ['admin', { action: 'usermod', op: '-aG', groups: ['listen', 'ai'], name: 'bob' }, 'usermod -aG listen,ai bob']);
  await run(sh, 'userdel bob', L.v);
  assert.deepEqual(L.calls.at(-1), ['admin', { action: 'userdel', name: 'bob' }, 'userdel bob']);
  const n = L.calls.length;
  for (const bad of ['su', 'su a b', 'usermod -xG a b', 'useradd', 'useradd -e 2099 bob', 'userdel', 'who x']) {
    const r = await run(sh, bad, L.v);
    assert.ok(r.out.length && !r.flow, bad + ' → usage');
  }
  assert.equal(L.calls.length, n, '参数不对不进身份层');
  /* 访客：exit 关终端；lock 提示先 su；passwd 交给身份层（身份层回没有登录） */
  const old = createShell({ act, storage: mem(), who: fixedWho('nobody') });
  const L2 = layers(false);
  const ex = await run(old, 'exit', L2.v);
  assert.deepEqual(L2.calls.slice(-1)[0], ['exit'], '先问身份层');
  assert.equal(typeof ex.after, 'function', '没有 v6 会话 → 关终端');
  const lk = await run(old, 'lock', L2.v);
  assert.ok(!lk.flow && lk.out.length, 'lock：访客先 su');
  await run(old, 'passwd', L2.v);
  assert.deepEqual(L2.calls.at(-1), ['passwd', '']);
});

test('P3 rescue（定稿 v5.2 §九）：访客敲 rescue → 身份层（输恢复钥匙由身份层问、判断在服务端）；带参数 → 用法；man rescue 有页、索引不列', async () => {
  const sh = createShell({ act, storage: mem(), who: fixedWho('nobody') });
  const L = layers(false);
  const r = await run(sh, 'rescue', L.v);
  assert.ok(r.flow, '交给身份层');
  assert.deepEqual(L.calls.at(-1), ['rescue']);
  const bad = await run(sh, 'rescue x', L.v);
  assert.ok(bad.out.length && !bad.flow);
  assert.equal(L.calls.length, 1, '参数不对不进身份层');
  const pg = await run(sh, 'man rescue');
  assert.equal(pg.pager, 'RESCUE(1)');
  for (const w of ['nobody', 'u:alice', 'u:root']) {
    const n = (await run(createShell({ act, storage: mem(), who: fixedWho(w) }), 'man')).out.slice(1).map((o) => o.seg[0][1]);
    assert.ok(!n.includes('rescue'), w + ' 索引不列 rescue');
  }
  /* 身份层：已登录先 exit；成功后提示 15 分钟、去 Cloudflare 换新值（文案只取 v6 命令手册「救援」节） */
  const src = rd('space/web/assets/js/shell/identity/layer.js');
  assert.match(src, /C\.cmdRescue = function \(\) \{\n\s+if \(me\(\)\) \{ C\.err\(t\('exitFirst'/);
  assert.match(src, /api\.post\('rescue', \{ key: key \}\)/);
  assert.match(src, /C\.ok\(t\('rootOn'\), t\('rescueLimit'\)\); C\.note\(t\('rescueRotate'\)\)/);
});

test('参数解析（ident-args，与服务端同写法）', () => {
  assert.deepEqual(parseUseradd(['bob']), { name: 'bob' });
  assert.deepEqual(parseUseradd(['-G', 'listen,ai', 'bob', '-e', '2099-01-02']), { name: 'bob', groups: ['listen', 'ai'], expire: '2099-01-02' });
  assert.equal(parseUseradd(['bob', 'carl']), null);
  assert.equal(parseUseradd(['-e', 'tomorrow', 'bob']), null);
  assert.deepEqual(parseUsermod(['-rG', 'wheel', 'styrigx']), { op: '-rG', groups: ['wheel'], name: 'styrigx' });
  assert.equal(parseUsermod(['-aG', 'wheel']), null);
  assert.deepEqual(sudoCommand(['passwd', 'root']), { action: 'passwd-user', name: 'root' }, 'sudo passwd root 交给服务端回 root-creds');
  assert.deepEqual(sudoCommand(['passwd']), { action: 'passwd' });
  assert.deepEqual(sudoCommand(['groups']), { action: 'groups', user: '' });
  assert.equal(sudoCommand(['su', 'root']), null, 'sudo 不能 su');
  assert.equal(sudoCommand(['rm', '-rf']), null);
  assert.ok(USER_NAME_RE.test('alice') && !USER_NAME_RE.test('A') && !USER_NAME_RE.test('1ab'));
});

test('前台空闲计时（Page Visibility）：可见时累计、隐藏不计、有操作清零、到 15 分钟只触发一次', async () => {
  globalThis.window = globalThis.window || globalThis;
  const { createIdleClock, ROOT_IDLE_MS } = await import('../../../../space/web/assets/js/shell/identity/layer.js');
  assert.equal(ROOT_IDLE_MS, 15 * 60 * 1000);
  let vis = true;
  let fired = 0;
  const c = createIdleClock({ idleMs: 60000, visible: () => vis, onIdle: () => fired++ });
  c.tick(30000);
  vis = false;
  c.tick(600000);
  assert.equal(c.idle(), 30000, '隐藏不计');
  vis = true;
  c.activity();
  c.tick(45000);
  assert.equal(fired, 0);
  c.tick(15000);
  assert.equal(fired, 1);
  c.tick(60000);
  assert.equal(fired, 1, '只触发一次');
  c.activity();
  c.tick(60000);
  assert.equal(fired, 2);
});

test('接线：头像 = whoami（访客 → su ；站长 / root → 账号页；普通用户只作装饰，定稿 v5.5 §七；root 叠 # 标记）；身份层进终端的 layers；登录标记首帧问 whoami', () => {
  const tp = rd('space/web/assets/js/shell/topbar-panel.js');
  assert.match(tp, /if \(!u\) return avGuest\(\) \? GUEST_LINE : '';\n\s*return '';/);
  assert.doesNotMatch(tp, /return u\.wheel \? 'su root' : 'profile'/);
  assert.doesNotMatch(tp, /'\/avatar\/u' \+ u\.uid/, 'P4-3：头像一份，归站长（定稿 v5.5 §七），不再按 uid 取');
  assert.match(tp, /return !!\(u && !u\.root && u\.owner !== true\);/, '普通用户 = 不是 root、不是站长');
  assert.match(tp, /mark\.className = 'sgx-tb-av-root';/);
  assert.match(tp, /return \{ acct: acctTerm, ident: ident \};/);
  assert.match(tp, /if \(who && who\.v6Hinted\(\)\) who\.refresh\(\);/);
  const qp = rd('space/web/assets/js/shell/quick-panel.js');
  assert.match(qp, /identityTerm: mountIdentityLayer,/);
  assert.match(rd('space/web/assets/css/input.css'), /\.sgx-tb-av-root \{/);
  /* 身份层只经 ./api.js 发请求；不写 Domain、不读密码之外的东西 */
  const layer = rd('space/web/assets/js/shell/identity/layer.js');
  assert.doesNotMatch(layer, /fetch\(/);
  assert.match(rd('space/web/assets/js/shell/identity/api.js'), /export const IDENTITY_API = '\/api\/identity';/);
});
