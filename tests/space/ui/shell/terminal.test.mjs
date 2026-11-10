/**
 * 终端引擎（v5 S5 终端合一，space/web/assets/js/shell/terminal.js）：一张命令表、一份历史、提示符按身份（nobody / link / styrigx / root，服务端说了算）。
 * 测行为：解析、补全、影子、目录、各身份的 man / 提示符 / 门槛、要输入验证的命令交给两层上下文（钥匙 space / 账号 acct）、exit、历史、文案。
 * 运行：node --test tests/space/ui/shell/terminal.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { parse, complete, ghost, normDir, cwdPath, fill, createShell, createWho, COMMANDS, ARGS, DIRS, TERM_EN } from '../../../../space/web/assets/js/shell/terminal.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** 内存 Storage */
function mem() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
/** 记录动作的假 act */
function fakeAct(o = {}) {
  const calls = [];
  const act = {
    cd: (d) => { calls.push(['cd', d]); return o.scroll && o.scroll.includes(d) ? { kind: 'scroll', label: '[01] ' + d } : { kind: 'nav', href: '/' + d + '/', go: () => calls.push(['go', d]) }; },
    theme: (m) => calls.push(['theme', m]),
    ask: (q) => calls.push(['ask', q]),
    find: () => Promise.resolve({ ok: true, hits: [] }),
    today: o.today || (() => Promise.resolve({ text: 'a line', by: '— someone' })),
    daymarkHref: () => '/daymark/',
    close: () => calls.push(['close']),
  };
  return { act, calls };
}
/** 固定身份（可改） */
function fixedWho(w) {
  let cur = w;
  const subs = [];
  return { get: () => cur, on: (f) => subs.push(f), set: (x) => { cur = x; subs.forEach((f) => f(x)); } };
}
/** 假的两层上下文：记下被调的流程 */
function fakeLayers() {
  const calls = [];
  const rec = (n) => (...a) => calls.push([n, ...a]);
  const space = { inReset: false, unlock: rec('space.unlock'), cmdReset: rec('space.cmdReset'), cmdReauth: rec('space.cmdReauth'), leaveReset: rec('space.leaveReset'),
    lockNow: rec('space.lockNow'), lockAll: rec('space.lockAll'), lockPasswd: rec('space.lockPasswd'), lockPasskeyList: rec('space.lockPasskeyList'), lockPasskeyAdd: rec('space.lockPasskeyAdd'), lockPasskeyRm: rec('space.lockPasskeyRm'),
    shareList: rec('space.shareList'), shareAdd: rec('space.shareAdd'), shareRm: rec('space.shareRm'), shareRmAll: rec('space.shareRmAll') };
  const acct = { inReset: false, cmdSession: rec('acct.cmdSession'), cmdReauth: rec('acct.cmdReauth'), cmdReset: rec('acct.cmdReset'), cmdExit: rec('acct.cmdExit'), leaveReset: rec('acct.leaveReset'),
    cmdPasswd: rec('acct.cmdPasswd'), passkeyList: rec('acct.passkeyList'), cmdPasskeyAdd: rec('acct.cmdPasskeyAdd'), passkeyRm: rec('acct.passkeyRm'),
    deviceList: rec('acct.deviceList'), deviceRm: rec('acct.deviceRm'), deviceRmAll: rec('acct.deviceRmAll'), appList: rec('acct.appList'), appAllow: rec('acct.appAllow'), appDeny: rec('acct.appDeny'),
    profileShow: rec('acct.profileShow'), profileSet: rec('acct.profileSet'), profileAvatar: rec('acct.profileAvatar'), cmdSub: rec('acct.cmdSub') };
  return { v: { space, acct }, calls };
}
/** 一行输出 → 纯文字 */
const text = (o) => o.seg.map((s) => s[1]).join('');
/** 跑一行（异步命令等完） */
const run = async (sh, line, v) => { const r = sh.exec(line, v); return r && typeof r.then === 'function' ? await r : r; };

test('parse：空行 null；命令名小写；参数按空白切；rest 保留原文', () => {
  assert.equal(parse(''), null);
  assert.equal(parse('   '), null);
  assert.deepEqual(parse('  CD   blog  '), { cmd: 'cd', args: ['blog'], rest: 'blog' });
  assert.deepEqual(parse('ask what is  this?'), { cmd: 'ask', args: ['what', 'is', 'this?'], rest: 'what is  this?' });
  assert.deepEqual(parse('man'), { cmd: 'man', args: [], rest: '' });
});


test('命令表（v5 S5 + sub v3.1 + S9 profile）：一张表；help / tty / tempkey / sub-* 没有了；sub 一条带子命令', () => {
  assert.deepEqual(COMMANDS, ['man', 'open', 'cd', 'ls', 'cat', 'clear', 'history', 'exit', 'pwd', 'theme', 'find', 'ask', 'sudo', 'lock', 'share', 'passwd', 'passkey', 'device', 'app', 'profile', 'sub']);
  for (const gone of ['help', 'tty', 'tempkey', 'sub-key', 'sub-link', 'sub-refresh', 'sub-mv']) assert.ok(!COMMANDS.includes(gone), gone);
  assert.deepEqual(ARGS.sub, ['show', 'add', 'upload', 'mv', 'rm', 'enable', 'disable', 'key', 'token']);
  assert.deepEqual(ARGS.app, ['allow', 'deny']);
  assert.deepEqual(ARGS.profile, ['set', 'avatar']);
  assert.deepEqual(ARGS.sudo, ['styrigx', 'root', '-v']);
  assert.deepEqual(ARGS.lock, ['passwd', 'passkey', '--all']);
  assert.deepEqual(ARGS.share, ['add', 'rm']);
  assert.deepEqual(ARGS.cd, ['blog', 'curio', 'daymark', 'wild', 'account', 'proxy', '~', '..'], '没有 shield/ 了');
});

test('complete：命令名补全（唯一 → 补全，带参数的命令加空格；多个 → 公共前缀 + 候选）', () => {
  assert.deepEqual(complete('cl'), { line: 'clear', options: [] });
  assert.deepEqual(complete('h'), { line: 'history', options: [] });
  assert.deepEqual(complete('the'), { line: 'theme ', options: [] });
  assert.deepEqual(complete('as'), { line: 'ask ', options: [] });
  assert.deepEqual(complete('c'), { line: 'c', options: ['cd', 'cat', 'clear'] });
  assert.deepEqual(complete('l'), { line: 'l', options: ['ls', 'lock'] });
  assert.deepEqual(complete('zz'), { line: 'zz', options: [] });
});

test('complete：参数补全（sudo r → sudo root；sudo s → sudo styrigx；lock / share；第三个词不补）', () => {
  assert.deepEqual(complete('sudo r'), { line: 'sudo root', options: [] });
  assert.deepEqual(complete('sudo s'), { line: 'sudo styrigx', options: [] });
  assert.deepEqual(complete('sudo '), { line: 'sudo ', options: ['styrigx', 'root', '-v'] });
  assert.deepEqual(complete('lock p'), { line: 'lock pass', options: ['passwd', 'passkey'] });
  assert.deepEqual(complete('share a'), { line: 'share add', options: [] });
  assert.deepEqual(complete('device '), { line: 'device rm', options: [] });
  assert.deepEqual(complete('cd b'), { line: 'cd blog', options: [] });
  assert.deepEqual(complete('theme d'), { line: 'theme dark', options: [] });
  assert.deepEqual(complete('cat d'), { line: 'cat daymark/today', options: [] });
  assert.deepEqual(complete('cd blog x'), { line: 'cd blog x', options: [] });
});

test('complete：第三个词（S9）：sub token → reset、profile set → 字段名；其余命令第三个词不补', () => {
  assert.deepEqual(complete('sub t'), { line: 'sub token ', options: [] }, 'token 还有第三个词：补完加空格');
  assert.deepEqual(complete('sub token '), { line: 'sub token reset', options: [] });
  assert.deepEqual(complete('sub token r'), { line: 'sub token reset', options: [] });
  assert.deepEqual(complete('sub e'), { line: 'sub enable', options: [] });
  assert.deepEqual(complete('sub d'), { line: 'sub disable', options: [] });
  assert.deepEqual(complete('profile s'), { line: 'profile set ', options: [] });
  assert.deepEqual(complete('profile set n'), { line: 'profile set n', options: ['name', 'nick'] });
  assert.deepEqual(complete('profile set e'), { line: 'profile set email', options: [] });
  assert.deepEqual(complete('app a'), { line: 'app allow', options: [] });
  assert.deepEqual(complete('app d'), { line: 'app deny', options: [] });
  assert.deepEqual(complete('lock passkey a'), { line: 'lock passkey a', options: [] });
});

test('ghost：唯一候选时给出没打的那一截（sudo ro_ot），多个 / 已完整 / 空行不给', () => {
  assert.equal(ghost('sudo ro'), 'ot');
  assert.equal(ghost('the'), 'me');
  assert.equal(ghost('hist'), 'ory');
  assert.equal(ghost('c'), '');
  assert.equal(ghost('man'), '');
  assert.equal(ghost(''), '');
});

test('normDir / cwdPath：~ / .. / 相对路径 / 尾斜杠；不认识 → null', () => {
  assert.equal(normDir('~', ''), '~');
  assert.equal(normDir('~', '~'), '~');
  assert.equal(normDir('blog', '..'), '~');
  assert.equal(normDir('~', '..'), '~');
  assert.equal(normDir('blog', '../curio'), 'curio');
  assert.equal(normDir('~', 'blog/'), 'blog');
  assert.equal(normDir('~', '~/Daymark'), 'daymark');
  assert.equal(normDir('~', './wild'), 'wild');
  assert.equal(normDir('blog', '.'), 'blog');
  assert.equal(normDir('~', 'nope'), null);
  assert.equal(cwdPath('~'), '~');
  assert.equal(cwdPath('blog'), '~/blog');
  assert.deepEqual(DIRS, ['blog', 'curio', 'daymark', 'wild']);
});

test('fill：占位换成片段，其余原样', () => {
  assert.deepEqual(fill('a {x} b', { x: ['k', 'X'] }), [['', 'a '], ['k', 'X'], ['', ' b']]);
  assert.deepEqual(fill('{y}', {}), [['', '{y}']]);
});

test('fill：占位换成片段，其余原样', () => {
  assert.deepEqual(fill('a {x} b', { x: ['k', 'X'] }), [['', 'a '], ['k', 'X'], ['', ' b']]);
  assert.deepEqual(fill('{y}', {}), [['', '{y}']]);
});

test('提示符 / 标题（term-design-v5「提示符」）：nobody@space:~$ · nobody@space:~#（分享链接）· styrigx@space:~# · root@account:~#；身份一变立刻换；cd 后带路径', () => {
  const { act } = fakeAct();
  const who = fixedWho('nobody');
  const sh = createShell({ act, storage: mem(), who });
  let changed = 0;
  sh.onChange(() => changed++);
  assert.equal(sh.ps1(), 'nobody@space:~$');
  assert.equal(sh.title(), 'nobody@space: ~');
  sh.exec('cd blog');
  assert.equal(sh.ps1(), 'nobody@space:~/blog$');
  who.set('link');
  assert.equal(sh.ps1(), 'nobody@space:~/blog#');
  who.set('styrigx');
  assert.equal(sh.ps1(), 'styrigx@space:~/blog#');
  who.set('root');
  assert.equal(sh.ps1(), 'root@account:~/blog#');
  assert.equal(sh.title(), 'root@account: ~/blog');
  assert.ok(changed >= 4, '身份 / cwd 变了都通知重画');
  assert.equal(createShell({ act, cwd: 'curio', storage: mem() }).ps1(), 'nobody@space:~/curio$', '没有身份来源 = nobody');
  assert.equal(createShell({ act, cwd: 'nope', storage: mem() }).ps1(), 'nobody@space:~$');
});

test('createWho：首帧按页面标记，问服务端后以回答为准；分享链接 by=link；账号回答只在进站后算 root；drop 回 nobody', async () => {
  let ans = null;
  const w = createWho({ check: () => Promise.resolve(ans), page: () => 'locked', accountHint: () => false });
  assert.equal(w.get(), 'nobody');
  ans = { ok: true, by: 'link' };
  assert.equal(await w.refresh(), 'link');
  ans = { ok: true, by: 'passkey' };
  assert.equal(await w.refresh(), 'styrigx');
  w.setAccount(true);
  assert.equal(w.get(), 'root');
  w.setAccount(false);
  assert.equal(w.get(), 'styrigx');
  w.drop();
  assert.equal(w.get(), 'nobody');
  assert.equal(createWho({ check: () => Promise.resolve(null), page: () => 'valid' }).get(), 'styrigx', '页面标记 valid = 已进站');
});

test('man 按身份列（唯一判断点 listedFor）：nobody 列 find 不列 ask、没有钥匙 / 账号命令；进站列 ask、lock、share；root 多账号命令和 sub', async () => {
  const { act } = fakeAct();
  const names = async (w) => (await run(createShell({ act, storage: mem(), who: fixedWho(w) }), 'man')).out.slice(1).map((o) => o.seg[0][1]);
  const base = ['man', 'open', 'cd', 'ls', 'cat', 'clear', 'history', 'exit', 'pwd', 'theme'];
  assert.deepEqual(await names('nobody'), base.concat(['find', 'sudo']));
  assert.deepEqual(await names('link'), base.concat(['ask', 'sudo', 'lock']), '分享链接进来的不列 share');
  assert.deepEqual(await names('styrigx'), base.concat(['ask', 'sudo', 'lock', 'share']));
  const root = await names('root');
  assert.deepEqual(root.slice(0, 19), base.concat(['ask', 'sudo', 'lock', 'share', 'passwd', 'passkey', 'device', 'app', 'profile']));
  assert.deepEqual(root.slice(19), ['sub'], 'sub 只给 root 列，只有一条');
  /* Tab 补全也只补这个身份列出的命令 */
  assert.deepEqual(createShell({ act, storage: mem(), who: fixedWho('nobody') }).complete('a'), { line: 'a', options: [] });
  assert.deepEqual(createShell({ act, storage: mem(), who: fixedWho('root') }).complete('a'), { line: 'a', options: ['ask', 'app'] });
  assert.deepEqual(createShell({ act, storage: mem(), who: fixedWho('styrigx') }).complete('pr'), { line: 'pr', options: [] }, 'profile 只给 root');
});

test('man / man <命令>：交给全屏阅读页（S9：pager = 页名，不进滚动区；没有 (END) / q 那一行了）；别名能查；没有的报错（进滚动区）；每条命令都有页', async () => {
  const sh = createShell({ act: fakeAct().act, storage: mem() });
  const idx = await run(sh, 'man');
  assert.equal(idx.pager, 'MAN(1)', '索引也进阅读页');
  assert.equal(text(idx.out[0]), TERM_EN.manIndex);
  for (const o of idx.out.slice(1)) assert.ok(!/undefined/.test(text(o)), text(o));
  const cd = await run(sh, 'man cd');
  assert.equal(cd.pager, 'CD(1)');
  assert.deepEqual(cd.out.map(text).slice(0, 2), ['NAME', '    cd — change the current directory (use open to go there)']);
  assert.ok(!cd.out.map(text).some((l) => /\(END\)|CD\(1\)/.test(l)), '页名在状态栏，不在正文里');
  assert.equal((await run(sh, 'man cls')).pager, 'CLEAR(1)');
  const no = await run(sh, 'man nope');
  assert.equal(text(no.out[0]), 'No manual entry for nope');
  assert.equal(no.pager, undefined);
  for (const c of COMMANDS) assert.equal((await run(sh, 'man ' + c)).pager, c.toUpperCase() + '(1)', '每条命令都有 man 页：' + c);
  assert.equal(text((await run(sh, 'man help')).out[0]), 'No manual entry for help', 'help 删了（man 取代）');
  assert.deepEqual(complete('m'), { line: 'man ', options: [] });
});

test('help / tty 没有了：command not found · try man；打错给 did you mean', () => {
  const sh = createShell({ act: fakeAct().act, storage: mem() });
  assert.equal(text(sh.exec('help').out[0]), 'command not found: help · try man');
  assert.equal(text(sh.exec('tty').out[0]), 'command not found: tty · try man');
  const r = sh.exec('hsitory').out[0];
  assert.equal(text(r), 'command not found: hsitory — did you mean history?');
  assert.equal(r.cls, 'err');
});

test('cd（T6b）：只改 cwd / 提示符，不调动作、没有输出（滚动 / 跳转交给 open）；坏目录报错、cwd 不变', () => {
  const { act, calls } = fakeAct({ scroll: ['blog'] });
  const sh = createShell({ act, storage: mem() });
  assert.deepEqual(sh.exec('cd blog'), { out: [] });
  assert.equal(sh.cwd(), 'blog');
  assert.deepEqual(sh.exec('cd curio'), { out: [] });
  assert.equal(sh.cwd(), 'curio');
  assert.deepEqual(calls, []);
  const bad = sh.exec('cd nowhere');
  assert.equal(text(bad.out[0]), 'cd: no such directory: nowhere');
  assert.equal(sh.cwd(), 'curio');
});

test('ls：~ 下列 blog/ curio/ daymark/ wild/ account/ proxy/（没有 shield/ 了）；daymark 下 today；坏目录报错', () => {
  const sh = createShell({ act: fakeAct().act, storage: mem() });
  assert.equal(text(sh.exec('ls').out[0]).trim(), 'blog/  curio/  daymark/  wild/  account/  proxy/');
  assert.equal(text(sh.exec('ls daymark').out[0]), 'today');
  assert.equal(text(sh.exec('ls account').out[0]), TERM_EN.lsEmpty, 'S9：账号卡片没有层了');
  assert.equal(text(sh.exec('ls x').out[0]), 'ls: no such directory: x');
  assert.equal(text(sh.exec('ls shield').out[0]), 'ls: no such directory: shield');
  assert.equal(text(sh.exec('pwd').out[0]), '~');
});

test('cat daymark/today：异步取今日一句；没有句子 / 失败 → 给日刻链接；别的文件报错；没参数给用法', async () => {
  const { act } = fakeAct();
  const sh = createShell({ act, storage: mem() });
  const ok = await sh.exec('cat daymark/today');
  assert.deepEqual(ok.out.map(text), ['“a line”', '— someone']);
  const none = await createShell({ act: fakeAct({ today: () => Promise.resolve(null) }).act, storage: mem() }).exec('cat daymark/today');
  assert.equal(text(none.out[0]), 'no line for today yet · /daymark/');
  assert.deepEqual(none.out[0].seg.find((s) => s[0] === 'a'), ['a', '/daymark/', '/daymark/']);
  const fail = await createShell({ act: fakeAct({ today: () => Promise.reject(new Error('x')) }).act, storage: mem() }).exec('cat daymark/today');
  assert.equal(text(fail.out[0]), 'couldn’t load today’s line · /daymark/');
  assert.equal(text(sh.exec('cat secrets').out[0]), 'cat: secrets: no such file');
  assert.equal(text(sh.exec('cat').out[0]), TERM_EN.usageCat);
});

test('theme / ask / open：先打印再动（after）；访客 ask 不开 AI；open ~/account 开账号卡片（S9 起没有层）', () => {
  const { act, calls } = fakeAct({ scroll: ['blog'] });
  act.account = () => { calls.push(['account']); return { href: '~/account', go: () => calls.push(['go-acct']) }; };
  const sh = createShell({ act, storage: mem(), who: fixedWho('styrigx') });
  sh.exec('theme dark');
  assert.deepEqual(calls.at(-1), ['theme', 'dark']);
  const a = sh.exec('ask what is this?');
  assert.equal(text(a.out[0]), '→ asking Gray AI …');
  assert.deepEqual(calls.at(-1), ['theme', 'dark'], 'ask 先打印');
  a.after();
  assert.deepEqual(calls.at(-1), ['ask', 'what is this?']);
  assert.equal(text(sh.exec('open blog').out[0]), '→ scrolled to [01] blog');
  const o = sh.exec('open ~/account');
  assert.equal(text(o.out[0]), '→ opening ~/account …');
  o.after();
  assert.deepEqual(calls.slice(-2), [['account'], ['go-acct']]);
  assert.equal(text(sh.exec('open ~/account/security').out[0]), 'open: no such directory: ~/account/security');
  assert.equal(text(sh.exec('open shield').out[0]), 'open: no such directory: shield', '盾牌没有窗口了');
  const g = createShell({ act, storage: mem(), who: fixedWho('nobody') }).exec('ask hi');
  assert.equal(text(g.out[0]), 'AI is locked · run sudo styrigx first; use find to search by keyword');
  assert.equal(g.after, undefined);
});

test('门槛（cmds/keys/gate.js，只是提示，真拦截在服务端）：访客要先 sudo styrigx；分享链接不能管分享 / reauth；账号命令要 sudo root', () => {
  const { act } = fakeAct();
  const { v, calls } = fakeLayers();
  const sh = (w) => createShell({ act, storage: mem(), who: fixedWho(w) });
  const need = 'not entered · run sudo styrigx first';
  for (const l of ['sudo root', 'sudo -v', 'lock', 'share', 'passwd', 'device', 'app deny 1', 'profile', 'sub']) assert.equal(text(sh('nobody').exec(l, v).out[0]), need, l);
  for (const l of ['share', 'share add', 'sudo -v']) assert.equal(text(sh('link').exec(l, v).out[0]), TERM_EN.linkDenied, l);
  for (const l of ['passwd', 'passkey', 'device', 'app', 'profile set name x', 'sub mv a b', 'sub show']) assert.equal(text(sh('styrigx').exec(l, v).out[0]), 'not signed in to the account · run sudo root first', l);
  assert.deepEqual(calls, [], '没过门槛的不进流程');
  assert.equal(text(sh('styrigx').exec('sudo styrigx', v).out[0]), 'already entered · sudo -v to verify again');
});

test('要输入 / 验证的命令交给两层上下文（flow，输出和输入模式归那一层）；没有那一层（AI 窗口里的 $ 命令）提示去终端跑', () => {
  const { act } = fakeAct();
  const { v, calls } = fakeLayers();
  const sh = (w) => createShell({ act, storage: mem(), who: fixedWho(w) });
  const flow = (w, l) => { const r = sh(w).exec(l, v); assert.equal(r.flow, true, w + ' ' + l); };
  flow('nobody', 'sudo styrigx');
  flow('nobody', 'sudo styrigx reset');
  flow('styrigx', 'sudo -v');
  flow('styrigx', 'sudo root');
  flow('styrigx', 'sudo root reauth');
  flow('styrigx', 'sudo root reset');
  flow('root', 'sudo -v');
  assert.deepEqual(calls.splice(0), [['space.unlock'], ['space.cmdReset'], ['space.cmdReauth'], ['acct.cmdSession'], ['acct.cmdReauth'], ['acct.cmdReset'], ['acct.cmdReauth']],
    'sudo -v 再验证当前这一层：styrigx → 钥匙，root → 账号');
  flow('root', 'passwd');
  flow('root', 'passkey');
  flow('root', 'passkey add');
  flow('root', 'passkey rm 2');
  flow('root', 'device');
  flow('root', 'device rm 3');
  flow('root', 'device rm --all');
  flow('root', 'app');
  flow('root', 'app allow 2');
  flow('root', 'app deny 1');
  flow('root', 'profile');
  flow('root', 'profile set sign  Stay  Hungry ');
  flow('root', 'profile SET Nick Styrigx');
  flow('root', 'profile avatar');
  flow('root', 'sub mv Linkcube LinkCube2');
  flow('root', 'SUB show Linkcube');
  assert.deepEqual(calls.splice(0), [['acct.cmdPasswd', true], ['acct.passkeyList'], ['acct.cmdPasskeyAdd', true], ['acct.passkeyRm', 2], ['acct.deviceList'], ['acct.deviceRm', 3], ['acct.deviceRmAll'],
    ['acct.appList'], ['acct.appAllow', 2], ['acct.appDeny', 1], ['acct.profileShow'], ['acct.profileSet', 'sign', 'Stay  Hungry'], ['acct.profileSet', 'nick', 'Styrigx'], ['acct.profileAvatar'],
    ['acct.cmdSub', 'sub mv Linkcube LinkCube2'], ['acct.cmdSub', 'SUB show Linkcube']], 'sub 传原样的一行（来源名大小写不变）；profile set 的值原样');
  assert.equal(text(sh('root').exec('device rm x', v).out[0]), TERM_EN.usageDevice);
  /* S9：app rm 换成 deny，没有兼容 */
  for (const l of ['app rm 1', 'app rm --all', 'app allow', 'app deny x']) assert.equal(text(sh('root').exec(l, v).out[0]), TERM_EN.usageApp, l);
  for (const l of ['profile set', 'profile set name', 'profile set age 3', 'profile avatar x', 'profile x']) assert.equal(text(sh('root').exec(l, v).out[0]), TERM_EN.usageProfile, l);
  assert.deepEqual(calls, []);
  assert.equal(text(sh('nobody').exec('sudo nope', v).out[0]), TERM_EN.usageSudo);
  /* AI 窗口（tty4）里的 $ 命令没有两层上下文 */
  assert.equal(text(sh('nobody').exec('sudo styrigx').out[0]), 'sudo styrigx: run it in the terminal (Ctrl K)');
  assert.equal(text(sh('root').exec('device').out[0]), 'device: run it in the terminal (Ctrl K)');
});

test('exit：reset 层里离开 reset；root 退出账号登录（那一层的 exit）；其余关掉终端窗口', () => {
  const { act, calls: acts } = fakeAct();
  const { v, calls } = fakeLayers();
  const sh = (w) => createShell({ act, storage: mem(), who: fixedWho(w) });
  v.space.inReset = true;
  assert.equal(sh('nobody').exec('exit', v).flow, true);
  v.space.inReset = false;
  v.acct.inReset = true;
  assert.equal(sh('styrigx').exec('exit', v).flow, true);
  v.acct.inReset = false;
  assert.equal(sh('root').exec('exit', v).flow, true);
  assert.deepEqual(calls, [['space.leaveReset'], ['acct.leaveReset'], ['acct.cmdExit']]);
  const r = sh('styrigx').exec('exit', v);
  assert.deepEqual(r.out, []);
  r.after();
  assert.deepEqual(acts.at(-1), ['close']);
});

test('历史：↑ 从最近一条往前，↓ 回到正在打的草稿；连续重复只记一次；存 sessionStorage（跨页保留，最多 50 条）', () => {
  const store = mem();
  const { act } = fakeAct({ scroll: ['blog'] });
  const sh = createShell({ act, storage: store });
  sh.exec('man');
  sh.exec('man');
  sh.exec('cd blog');
  sh.exec('ls');
  assert.deepEqual(sh.history(), ['man', 'cd blog', 'ls']);
  assert.equal(sh.prev('dra'), 'ls');
  assert.equal(sh.prev(''), 'cd blog');
  assert.equal(sh.prev(''), 'man');
  assert.equal(sh.prev(''), 'man', '到顶停住');
  assert.equal(sh.next(), 'cd blog');
  assert.equal(sh.next(), 'ls');
  assert.equal(sh.next(), 'dra', '回到草稿');
  assert.equal(sh.next(), null);
  const again = createShell({ act, storage: store });
  assert.deepEqual(again.history(), ['man', 'cd blog', 'ls']);
  for (let i = 0; i < 60; i++) again.exec('echo ' + i);
  assert.equal(JSON.parse(store.getItem('sgx-term-hist')).length, 50);
});

test('一个会话一份历史：缺省键 sgx-term-hist；AI 窗口里的 $ 命令换自己的键（sgx-term-hist-4）；history 列出本会话的命令', () => {
  const st = mem();
  const { act } = fakeAct();
  const a = createShell({ act, storage: st });
  a.exec('pwd');
  const b = createShell({ act, storage: st });
  assert.deepEqual(b.history(), ['pwd'], '同一份历史（跨页 / 主页首屏和终端窗口）');
  assert.deepEqual(b.exec('history').out.map(text), ['1  pwd', '2  history']);
  const t4 = createShell({ act, storage: st, histKey: 'sgx-term-hist-4' });
  t4.exec('ls');
  assert.deepEqual(JSON.parse(st.getItem('sgx-term-hist-4')), ['ls']);
  assert.deepEqual(JSON.parse(st.getItem('sgx-term-hist')), ['pwd', 'history']);
});

test('文案：外壳字符串表 en / zh 都有 term 节，键和引擎英文底一一对应', () => {
  const en = yaml.load(readFileSync(path.join(REPO, 'space/web/data/sgx-shell-i18n/en.yaml'), 'utf8')).term;
  const zh = yaml.load(readFileSync(path.join(REPO, 'space/web/data/sgx-shell-i18n/zh.yaml'), 'utf8')).term;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(TERM_EN).sort());
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(TERM_EN).sort());
  for (const k of Object.keys(TERM_EN)) assert.equal(en[k], TERM_EN[k], 'en.' + k + ' 同引擎英文底');
  assert.equal(zh.hint, 'tab 补全 · ↑ 历史 · Ctrl K 全站呼出');
  const sh = createShell({ act: fakeAct().act, str: zh, storage: mem() });
  assert.equal(text(sh.exec('cd x').out[0]), 'cd: 没有这个目录：x');
});

test('共享外壳约束：terminal.js 只 import shell/term/**（终端统一 T1）、不写 innerHTML；四个顶栏入口都把它传给 mountTopbar', () => {
  const src = readFileSync(path.join(REPO, 'space/web/assets/js/shell/terminal.js'), 'utf8');
  const imports = src.match(/^\s*import\s[^;]*;/gm) || [];
  assert.ok(imports.length > 0);
  for (const l of imports) assert.match(l.trim(), /from '\.\/term\/[a-z0-9/-]+\.js';$/, l);
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /\bimport\s*\(/);
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /innerHTML/);
  for (const f of ['space/web/assets/js/shell/quick-panel.js', 'space/web/assets/curio/js/sgx/topbar-host.js', 'space/web/assets/daymark/js/sgx/topbar-host.js', 'space/web/assets/blog/js/entries/topnav.ts']) {
    const s = readFileSync(path.join(REPO, f), 'utf8');
    assert.match(s, /import \* as terminal from '[./]+(js\/shell\/)?terminal\.js';/, f);
    assert.match(s, /\n\s+terminal,\n/, f);
  }
});

test('man 节（en / zh）：键 = man 页的命令；英文表 = pages.js 英文底', async () => {
  const { PAGES } = await import('../../../../space/web/assets/js/shell/term/man/pages.js');
  const en = yaml.load(readFileSync(path.join(REPO, 'space/web/data/sgx-shell-i18n/en.yaml'), 'utf8')).man;
  const zh = yaml.load(readFileSync(path.join(REPO, 'space/web/data/sgx-shell-i18n/zh.yaml'), 'utf8')).man;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(PAGES).sort());
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(PAGES).sort());
  for (const k of Object.keys(PAGES)) assert.equal(en[k], PAGES[k].d, 'en.man.' + k);
});

test('代理订阅：open ~/proxy = sub；ls ~/proxy 列来源 / 没登录提示；man sub 一页列全部子命令、有 AUTH 节；man sub-mv 没有了', async () => {
  const { act } = fakeAct();
  act.proxyList = () => Promise.resolve([{ name: 'Linkcube', type: 'airport', host: 'sub.example.com', nodes: 3, enabled: true, error: '' }, { name: 'Cloady', type: 'file', host: '', nodes: 1, enabled: false, error: '' }]);
  const { v, calls } = fakeLayers();
  const sh = createShell({ act, storage: mem(), who: fixedWho('root') });
  assert.equal(sh.exec('open ~/proxy', v).flow, true);
  assert.deepEqual(calls.at(-1), ['acct.cmdSub', 'sub']);
  const ls = await run(sh, 'ls ~/proxy');
  assert.deepEqual(ls.out.map(text), ['Linkcube  sub.example.com  3  enabled', 'Cloady  file  1  disabled']);
  act.proxyList = () => Promise.resolve(null);
  assert.equal(text((await run(sh, 'ls proxy')).out[0]), '# sub · ~/account');
  const man = await run(sh, 'man sub');
  assert.equal(man.pager, 'SUB(1)');
  assert.deepEqual(man.out.map(text).slice(0, 13), ['NAME', '    sub — proxy subscription: status, urls, sources, key and token', '', 'SYNOPSIS',
    '    sub', '    sub show [name]', '    sub add <name>', '    sub upload <name>', '    sub mv <old> <new>', '    sub rm <name>', '    sub enable | disable <name>', '    sub key', '    sub token reset']);
  assert.ok(!man.out.map(text).some((l) => /sub on|sub off|on \/ off/.test(l)), 'on / off 改名 enable / disable，没有旧名');
  assert.ok(man.out.map(text).includes('AUTH'));
  assert.ok(!man.out.map(text).some((l) => /sub-refresh|sub-link|only this once/.test(l)), '没有旧命令、没有「只显示一次」');
  assert.equal((await run(sh, 'man sub-mv')).out[0].cls, 'err');
});
