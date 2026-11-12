/**
 * 终端引擎（v5 S5 终端合一，space/web/assets/js/shell/terminal.js）：一张命令表、一份历史、提示符按身份（v6 P4 起：访客 nobody / v6 用户 u:<名> / v6 root u:root，服务端说了算）。
 * 测行为：解析、补全、影子、目录、各身份的 man / 提示符 / 门槛、要输入验证的命令交给两层上下文（账号 acct / v6 身份 ident）、exit、历史、文案。
 * 运行：node --test tests/space/ui/shell/terminal.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { parse, complete, ghost, normDir, cwdPath, fill, createShell, createWho, COMMANDS, ARGS, DIRS, TERM_EN } from '../../../../space/web/assets/js/shell/terminal.js';

/* theme 的参数 = 调色板 id（2026-11-12 调色板 v4）：页面上来自共享读端 window.SgxUI.PRESETS，这里按 palettes.json 挂一个（取值时现读，import 之后挂也行） */
const PAL = JSON.parse(readFileSync(new URL('../../../../space/web/data/shell/palettes.json', import.meta.url), 'utf8')).presets.map((p) => p.id);
/** @type {any} */ (globalThis).SgxUI = { PRESETS: Object.fromEntries(PAL.map((id) => [id, '#000000'])) };

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
  const acct = { passkeyList: rec('acct.passkeyList'), cmdPasskeyAdd: rec('acct.cmdPasskeyAdd'), passkeyRm: rec('acct.passkeyRm'),
    deviceList: rec('acct.deviceList'), deviceRm: rec('acct.deviceRm'), deviceRmAll: rec('acct.deviceRmAll'), 
    profileShow: rec('acct.profileShow'), profileSet: rec('acct.profileSet'), profileAvatar: rec('acct.profileAvatar'), cmdSub: rec('acct.cmdSub') };
  const ident = { hasSession: () => true, cmdExit: (...a) => { calls.push(['ident.cmdExit', ...a]); return ident.session; }, session: false, cmdLock: rec('ident.cmdLock'), cmdPasswd: rec('ident.cmdPasswd'), cmdSudo: rec('ident.cmdSudo') };
  return { v: { acct, ident }, calls };
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
  assert.deepEqual(COMMANDS, ['man', 'open', 'cd', 'ls', 'cat', 'clear', 'history', 'exit', 'pwd', 'theme', 'find', 'ask', 'sudo', 'lock', 'passwd', 'passkey', 'device', 'profile', 'sub',
    'whoami', 'su', 'groups', 'who', 'useradd', 'userdel', 'usermod', 'rescue'], 'v6 身份命令（P2b）排最后；P3 救援入口 rescue；v6 P4 删 share；应用授权删 app（定稿 v5.3 §十二）');
  for (const gone of ['help', 'tty', 'tempkey', 'sub-key', 'sub-link', 'sub-refresh', 'sub-mv', 'share', 'app']) assert.ok(!COMMANDS.includes(gone), gone);
  assert.deepEqual(ARGS.sub, ['show', 'add', 'upload', 'mv', 'rm', 'enable', 'disable', 'key', 'token']);
  assert.equal(ARGS.app, undefined);
  assert.deepEqual(ARGS.profile, ['set', 'avatar']);
  assert.deepEqual(ARGS.sudo, [], 'v6 P4：旧写法 styrigx / root / -v 的补全删了（v6 写法的补全不在本 PR 加）');
  assert.equal(ARGS.lock, undefined, 'v6 P4：lock 没有参数了');
  assert.deepEqual(ARGS.passkey, ['add', 'rm']);
  assert.deepEqual(ARGS.cd, ['blog', 'curio', 'daymark', 'account', 'proxy', '~', '..'], '没有 shield/、wild/ 了（旷野 2026-11-12 删除）');
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

test('complete：参数补全（passkey；第三个词不补；v6 P4 起 sudo styrigx / sudo root / sudo -v / lock passwd / share 没有了）', () => {
  assert.deepEqual(complete('sud'), { line: 'sudo ', options: [] });
  assert.deepEqual(complete('sudo '), { line: 'sudo ', options: [] });
  assert.deepEqual(complete('sudo r'), { line: 'sudo r', options: [] });
  assert.deepEqual(complete('sudo s'), { line: 'sudo s', options: [] });
  assert.deepEqual(complete('lock p'), { line: 'lock p', options: [] });
  assert.deepEqual(complete('passkey a'), { line: 'passkey add', options: [] });
  assert.deepEqual(complete('device '), { line: 'device rm', options: [] });
  assert.deepEqual(complete('cd b'), { line: 'cd blog', options: [] });
  assert.deepEqual(complete('theme du'), { line: 'theme dusty', options: ['dustyrose', 'dustyblue'] });
  assert.deepEqual(complete('theme te'), { line: 'theme te', options: ['terra', 'teal'] });
  assert.deepEqual(complete('theme gr'), { line: 'theme graphite', options: [] });
  assert.deepEqual(ARGS.theme, PAL, 'theme 补全 = 22 个调色板 id');
  assert.equal(PAL.length, 25);
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
  assert.deepEqual(complete('passkey add x'), { line: 'passkey add x', options: [] });
});

test('ghost：唯一候选时给出没打的那一截（passkey a_dd），多个 / 已完整 / 空行不给', () => {
  assert.equal(ghost('passkey a'), 'dd');
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
  assert.equal(normDir('~', './curio'), 'curio');
  assert.equal(normDir('~', 'wild'), null, '旷野 2026-11-12 删除');
  assert.equal(normDir('blog', '.'), 'blog');
  assert.equal(normDir('~', 'nope'), null);
  assert.equal(cwdPath('~'), '~');
  assert.equal(cwdPath('blog'), '~/blog');
  assert.deepEqual(DIRS, ['blog', 'curio', 'daymark']);
});

test('fill：占位换成片段，其余原样', () => {
  assert.deepEqual(fill('a {x} b', { x: ['k', 'X'] }), [['', 'a '], ['k', 'X'], ['', ' b']]);
  assert.deepEqual(fill('{y}', {}), [['', '{y}']]);
});

test('fill：占位换成片段，其余原样', () => {
  assert.deepEqual(fill('a {x} b', { x: ['k', 'X'] }), [['', 'a '], ['k', 'X'], ['', ' b']]);
  assert.deepEqual(fill('{y}', {}), [['', '{y}']]);
});

test('提示符 / 标题（定稿 v5.2 §二：<用户>@space:<路径>，未登录 nobody@space 不变）：nobody@space:~$ · styrigx@space:~$ · root@space:~#；身份一变立刻换；cd 后带路径', () => {
  const { act } = fakeAct();
  const who = fixedWho('nobody');
  const sh = createShell({ act, storage: mem(), who });
  let changed = 0;
  sh.onChange(() => changed++);
  assert.equal(sh.ps1(), 'nobody@space:~$');
  assert.equal(sh.title(), 'nobody@space: ~');
  sh.exec('cd blog');
  assert.equal(sh.ps1(), 'nobody@space:~/blog$');
  who.set('u:styrigx');
  assert.equal(sh.ps1(), 'styrigx@space:~/blog$');
  who.set('u:root');
  assert.equal(sh.ps1(), 'root@space:~/blog#');
  assert.equal(sh.title(), 'root@space: ~/blog');
  assert.ok(changed >= 3, '身份 / cwd 变了都通知重画');
  assert.equal(createShell({ act, cwd: 'curio', storage: mem() }).ps1(), 'nobody@space:~/curio$', '没有身份来源 = nobody');
  assert.equal(createShell({ act, cwd: 'nope', storage: mem() }).ps1(), 'nobody@space:~$');
});

test('createWho（v6 P4）：只看 v6 whoami；没有旧进站 / 账号身份；drop 回 nobody', async () => {
  let ans = null;
  const w = createWho({ whoami: () => Promise.resolve(ans) });
  assert.equal(w.get(), 'nobody');
  ans = { name: 'styrigx', root: false };
  assert.equal(await w.refresh(), 'u:styrigx');
  assert.equal(w.setAccount, undefined, '旧账号身份 setAccount 删了');
  w.drop();
  assert.equal(w.get(), 'nobody');
});

test('man 按身份列（P4-3，定稿 v5.5 §四：root → 站长 → 普通用户 → 访客分段，各人看自己这一层及以下，root 看全部）', async () => {
  const { act } = fakeAct();
  const names = async (w) => (await run(createShell({ act, storage: mem(), who: fixedWho(w) }), 'man')).out.slice(1).map((o) => o.seg[0][1]);
  const base = ['man', 'open', 'cd', 'ls', 'cat', 'clear', 'history', 'exit', 'pwd', 'theme'];
  assert.deepEqual(await names('nobody'), base.concat(['find']));
  /* 普通用户（没有 whoami 回答 = 不知道组：ask / sudo 不列） */
  assert.deepEqual(await names('u:alice'), ['lock', 'passwd', 'profile', 'whoami', 'su', 'groups', 'who', ''].concat(base, ['find']));
  /* 站长（按保留名 styrigx 认）：站长层 passkey / device 在前 */
  assert.deepEqual(await names('u:styrigx'), ['passkey', 'device', '', 'lock', 'passwd', 'profile', 'whoami', 'su', 'groups', 'who', ''].concat(base, ['find']));
  assert.deepEqual(await names('u:root'), ['sub', 'useradd', 'userdel', 'usermod', '', 'sudo', 'passkey', 'device', '', 'ask', 'lock', 'passwd', 'profile', 'whoami', 'su', 'groups', 'who', ''].concat(base, ['find']));
  /* Tab 补全也只补这个身份列出的命令 */
  assert.deepEqual(createShell({ act, storage: mem(), who: fixedWho('nobody') }).complete('a'), { line: 'a', options: [] });
  assert.deepEqual(createShell({ act, storage: mem(), who: fixedWho('u:root') }).complete('a'), { line: 'ask ', options: [] });
  assert.deepEqual(createShell({ act, storage: mem(), who: fixedWho('nobody') }).complete('pr'), { line: 'pr', options: [] }, 'profile 访客不列');
  /* su 的参数按身份：访客往上是进站（styrigx），已登录往上是 root（Gray 11-12 00:32） */
  assert.deepEqual(createShell({ act, storage: mem(), who: fixedWho('nobody') }).complete('su '), { line: 'su styrigx', options: [] }, '访客 su → styrigx');
  assert.deepEqual(createShell({ act, storage: mem(), who: fixedWho('u:styrigx') }).complete('su '), { line: 'su root', options: [] }, '站长 su → root');
  assert.deepEqual(createShell({ act, storage: mem(), who: fixedWho('u:alice') }).complete('su '), { line: 'su root', options: [] }, '普通用户 su → root');
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

test('ls：~ 下列 blog/ curio/ daymark/ account/ proxy/（没有 shield/、wild/ 了）；daymark 下 today；坏目录报错', () => {
  const sh = createShell({ act: fakeAct().act, storage: mem() });
  assert.equal(text(sh.exec('ls').out[0]).trim(), 'blog/  curio/  daymark/  account/  proxy/');
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
  sh.exec('theme lake');
  assert.deepEqual(calls.at(-1), ['theme', 'lake']);
  assert.equal(text(sh.exec('theme dark').out[0]), TERM_EN.usageTheme, 'v4：dark / light / auto 不再是参数');
  assert.deepEqual(calls.at(-1), ['theme', 'lake']);
  const a = sh.exec('ask what is this?');
  assert.equal(text(a.out[0]), '→ asking Gray AI …');
  assert.deepEqual(calls.at(-1), ['theme', 'lake'], 'ask 先打印');
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
  assert.equal(text(g.out[0]), 'AI is locked · run su first; use find to search by keyword', '割接：入口是 su');
  assert.equal(g.after, undefined);
});

test('门槛（cmds/keys/gate.js，只是提示，真拦截在服务端）：访客要先 su <用户>；非 root 的 root 档命令（sub、device rm）提示先 su root（文案同 main；sudoers 另可 sudo <命令>，keys/sudo.js）', () => {
  const { act } = fakeAct();
  const { v, calls } = fakeLayers();
  const sh = (w) => createShell({ act, storage: mem(), who: fixedWho(w) });
  const need = 'not signed in · su <user> first';
  for (const l of ['lock', 'passkey', 'device', 'profile', 'sub']) assert.equal(text(sh('nobody').exec(l, v).out[0]), need, l);
  for (const l of ['sub mv a b', 'sub show']) assert.equal(text(sh('u:alice').exec(l, v).out[0]), 'permission denied · run su root first', l);
  /* P4-3：站长（sudoers）的 sub 与 device rm（root 档，定稿 v5.5 §五）提示同 main 的「先 su root」，不另出 sudo <这一行> 提示 */
  const owner = () => createShell({ act, storage: mem(), who: Object.assign(fixedWho('u:styrigx'), { v6: () => ({ name: 'styrigx', owner: true, sudoers: true, groups: ['sudoers'] }) }) });
  for (const l of ['sub mv a b', 'sub show', 'device rm 2', 'device rm --all']) assert.equal(text(owner().exec(l, v).out[0]), 'permission denied · run su root first', l);
  assert.deepEqual(calls, [], '没过门槛的不进流程');
});

test('要输入 / 验证的命令交给两层上下文（flow，输出和输入模式归那一层）；没有那一层（AI 窗口里的 $ 命令）提示去终端跑', () => {
  const { act } = fakeAct();
  const { v, calls } = fakeLayers();
  const sh = (w) => createShell({ act, storage: mem(), who: fixedWho(w) });
  const flow = (w, l) => { const r = sh(w).exec(l, v); assert.equal(r.flow, true, w + ' ' + l); };
  flow('u:root', 'passwd');
  flow('u:root', 'passkey');
  flow('u:root', 'passkey add');
  flow('u:root', 'passkey rm 2');
  flow('u:root', 'device');
  flow('u:root', 'device rm 3');
  flow('u:root', 'device rm --all');
  flow('u:root', 'profile');
  flow('u:root', 'profile set sign  Stay  Hungry ');
  flow('u:root', 'profile SET Nick Styrigx');
  flow('u:root', 'profile avatar');
  flow('u:root', 'sub mv Linkcube LinkCube2');
  flow('u:root', 'SUB show Linkcube');
  assert.deepEqual(calls.splice(0), [['ident.cmdPasswd', ''], ['acct.passkeyList'], ['acct.cmdPasskeyAdd', true], ['acct.passkeyRm', 2], ['acct.deviceList'], ['acct.deviceRm', 3], ['acct.deviceRmAll'],
    ['acct.profileShow'], ['acct.profileSet', 'sign', 'Stay  Hungry'], ['acct.profileSet', 'nick', 'Styrigx'], ['acct.profileAvatar'],
    ['acct.cmdSub', 'sub mv Linkcube LinkCube2'], ['acct.cmdSub', 'SUB show Linkcube']], 'sub 传原样的一行（来源名大小写不变）；profile set 的值原样');
  assert.equal(text(sh('u:root').exec('device rm x', v).out[0]), TERM_EN.usageDevice);
  /* 应用授权删了（定稿 v5.3 §十二）：app 不再是命令 */
  assert.equal(TERM_EN.usageApp, undefined);
  for (const l of ['app', 'app allow 1', 'app deny 1']) assert.equal(text(sh('u:root').exec(l, v).out[0]), 'command not found: app · try man', l);
  for (const l of ['profile set', 'profile set name', 'profile set age 3', 'profile avatar x', 'profile x']) assert.equal(text(sh('u:root').exec(l, v).out[0]), TERM_EN.usageProfile, l);
  assert.deepEqual(calls, []);
  assert.equal(text(sh('nobody').exec('sudo nope', v).out[0]), TERM_EN.usageSudo);
  /* AI 窗口（tty4）里的 $ 命令没有两层上下文 */
  assert.equal(text(sh('u:root').exec('sudo who').out[0]), 'sudo who: run it in the terminal (Ctrl K)');
  assert.equal(text(sh('u:root').exec('device').out[0]), 'device: run it in the terminal (Ctrl K)');
});

test('exit（v6 P4）：有 v6 会话交给身份层弹一层；没有就关掉终端窗口（旧 reset 层 / root@account 退出删了）', () => {
  const { act, calls: acts } = fakeAct();
  const { v, calls } = fakeLayers();
  const sh = (w) => createShell({ act, storage: mem(), who: fixedWho(w) });
  v.ident.session = true;
  assert.equal(sh('u:root').exec('exit', v).flow, true);
  v.ident.session = false;
  const r = sh('nobody').exec('exit', v);
  assert.deepEqual(calls, [['ident.cmdExit'], ['ident.cmdExit']]);
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
  const sh = createShell({ act, storage: mem(), who: fixedWho('u:root') });
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
