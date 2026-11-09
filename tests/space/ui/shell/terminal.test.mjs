/**
 * 站内终端引擎（2026-11 UI 重设计 PR-2，space/web/assets/js/shell/terminal.js）：解析、tab 补全、补全影子、cd 目标、提示符、历史、各命令的输出与动作。
 * 运行：node --test tests/space/ui/shell/terminal.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { parse, complete, ghost, normDir, cwdPath, fill, createShell, COMMANDS, ARGS, DIRS, TERM_EN } from '../../../../space/web/assets/js/shell/terminal.js';

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
    sudo: (w, sub) => { calls.push(sub ? ['sudo', w, sub] : ['sudo', w]); return { href: w === 'root' ? '~/account' : '/' + w + '/', go: () => calls.push(['go', w]) }; },
    theme: (m) => calls.push(['theme', m]),
    lock: () => calls.push(['lock']),
    ask: (q) => calls.push(['ask', q]),
    today: o.today || (() => Promise.resolve({ text: 'a line', by: '— someone' })),
    daymarkHref: () => '/daymark/',
  };
  return { act, calls };
}
/** 一行输出 → 纯文字 */
const text = (o) => (o.t === 'help' ? o.head.map((s) => s[1]).join('') + ' | ' + o.rows.map((r) => r[0]).join(',') : o.seg.map((s) => s[1]).join(''));

test('parse：空行 null；命令名小写；参数按空白切；rest 保留原文', () => {
  assert.equal(parse(''), null);
  assert.equal(parse('   '), null);
  assert.deepEqual(parse('  CD   blog  '), { cmd: 'cd', args: ['blog'], rest: 'blog' });
  assert.deepEqual(parse('ask what is  this?'), { cmd: 'ask', args: ['what', 'is', 'this?'], rest: 'what is  this?' });
  assert.deepEqual(parse('help'), { cmd: 'help', args: [], rest: '' });
});

test('complete：命令名补全（唯一 → 补全，带参数的命令加空格；多个 → 公共前缀 + 候选）', () => {
  assert.deepEqual(complete('he'), { line: 'help', options: [] });
  assert.deepEqual(complete('cl'), { line: 'clear', options: [] });
  assert.deepEqual(complete('the'), { line: 'theme ', options: [] });
  assert.deepEqual(complete('as'), { line: 'ask ', options: [] });
  assert.deepEqual(complete('c'), { line: 'c', options: ['cd', 'cat', 'clear'] });
  assert.deepEqual(complete('l'), { line: 'l', options: ['ls', 'lock'] });
  assert.deepEqual(complete('zz'), { line: 'zz', options: [] });
});

test('complete：参数补全（sudo r → sudo root；cd 目录；theme；cat daymark/today；第三个词不补）', () => {
  assert.deepEqual(complete('sudo r'), { line: 'sudo root', options: [] });
  assert.deepEqual(complete('sudo s'), { line: 'sudo styrigx', options: [] }, '进站 v3 L1：sudo security → sudo styrigx');
  assert.deepEqual(complete('sudo '), { line: 'sudo ', options: ['root', 'styrigx'] });
  assert.deepEqual(complete('cd b'), { line: 'cd blog', options: [] });
  assert.deepEqual(complete('cd d'), { line: 'cd daymark', options: [] });
  assert.deepEqual(complete('theme d'), { line: 'theme dark', options: [] });
  assert.deepEqual(complete('cat d'), { line: 'cat daymark/today', options: [] });
  assert.deepEqual(complete('cd blog x'), { line: 'cd blog x', options: [] });
  assert.deepEqual(ARGS.cd, ['blog', 'curio', 'daymark', 'wild', '~', '..']);
});

test('ghost：唯一候选时给出没打的那一截（sudo ro_ot；2026-11-08 sudo account → sudo root），多个 / 已完整 / 空行不给', () => {
  assert.equal(ghost('sudo ro'), 'ot');
  assert.equal(ghost('he'), 'lp');
  assert.equal(ghost('the'), 'me');
  assert.equal(ghost('c'), '');
  assert.equal(ghost('help'), '');
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

test('提示符 / 标题（环境提示符规则，进站 v3 L1）：账号没登录 styrigx@space:~$、已登录 root@account:~#；cd blog 后 ~/blog$ / ~/blog#；初始 cwd 可以是子站目录', () => {
  const { act } = fakeAct({ scroll: ['blog'] });
  let inAcct = false;
  const sh = createShell({ act, storage: mem(), signedIn: () => inAcct });
  assert.equal(sh.ps1(), 'styrigx@space:~$');
  assert.equal(sh.title(), 'styrigx@space: ~');
  sh.exec('cd blog');
  assert.equal(sh.ps1(), 'styrigx@space:~/blog$');
  inAcct = true;
  assert.equal(sh.ps1(), 'root@account:~/blog#', '登录后立刻换（每次现读）');
  assert.equal(sh.title(), 'root@account: ~/blog');
  sh.exec('cd ..');
  assert.equal(sh.ps1(), 'root@account:~#');
  assert.equal(createShell({ act, cwd: 'curio', storage: mem(), signedIn: () => false }).ps1(), 'styrigx@space:~/curio$');
  assert.equal(createShell({ act, cwd: 'nope', storage: mem(), signedIn: () => false }).ps1(), 'styrigx@space:~$');
  /* 没传 signedIn：读 <html data-sgx-account-session>；node 里没有 document → 没登录 */
  assert.equal(createShell({ act, storage: mem() }).ps1(), 'styrigx@space:~$');
});

test('help：cd 一行 + 八条命令（顺序同设计稿）；clear 清屏；未知命令 command not found · try help', () => {
  const { act } = fakeAct();
  const sh = createShell({ act, storage: mem() });
  const h = sh.exec('help');
  assert.equal(h.out.length, 1);
  assert.equal(text(h.out[0]), 'cd blog · curio · daymark · wild · ~ | ls,cat,sudo root,sudo styrigx,theme,lock,ask,clear');
  assert.equal(h.out[0].rows[0][1], TERM_EN.dLs);
  assert.deepEqual(sh.exec('clear'), { out: [], clear: true });
  const nf = sh.exec('foo bar');
  assert.equal(text(nf.out[0]), 'command not found: foo · try help');
  assert.equal(nf.out[0].cls, 'err');
  assert.deepEqual(COMMANDS, ['help', 'cd', 'ls', 'cat', 'sudo', 'theme', 'lock', 'ask', 'clear', 'man']);
});

test('cd：主页有这一节 → 滚动提示；没有 → 打开提示 + after 去跳转；坏目录报错、cwd 不变', () => {
  const { act, calls } = fakeAct({ scroll: ['blog'] });
  const sh = createShell({ act, storage: mem() });
  const r = sh.exec('cd blog');
  assert.equal(text(r.out[0]), '→ scrolled to [01] blog');
  assert.equal(r.after, undefined);
  const n = sh.exec('cd curio');
  assert.equal(text(n.out[0]), '→ opening /curio/ …');
  n.after();
  assert.deepEqual(calls, [['cd', 'blog'], ['cd', 'curio'], ['go', 'curio']]);
  const bad = sh.exec('cd nowhere');
  assert.equal(text(bad.out[0]), 'cd: no such directory: nowhere');
  assert.equal(sh.cwd(), 'curio');
});

test('ls：~ 下列 blog/ curio/ daymark/ wild/；daymark 下 today；坏目录报错', () => {
  const { act } = fakeAct();
  const sh = createShell({ act, storage: mem() });
  assert.equal(text(sh.exec('ls').out[0]).trim(), 'blog/  curio/  daymark/  wild/');
  assert.equal(text(sh.exec('ls daymark').out[0]), 'today');
  assert.equal(text(sh.exec('ls x').out[0]), 'ls: no such directory: x');
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

test('sudo / theme / lock / ask：输出一行提示，动作放在 after（先打印再动）；theme 设定立即生效', () => {
  const { act, calls } = fakeAct();
  const sh = createShell({ act, storage: mem() });
  /* 2026-11-08 账号命令体系 v3：sudo root [reauth|reset] 打开账号终端；sudo account 不再认 */
  const a = sh.exec('sudo root');
  assert.equal(text(a.out[0]), '→ opening ~/account …');
  a.after();
  sh.exec('sudo root reauth').after();
  sh.exec('sudo root reset').after();
  assert.equal(text(sh.exec('sudo rm').out[0]), TERM_EN.usageSudo);
  assert.equal(text(sh.exec('sudo account').out[0]), TERM_EN.usageSudo);
  assert.equal(text(sh.exec('sudo root rm').out[0]), TERM_EN.usageSudo);
  assert.equal(text(sh.exec('sudo security').out[0]), TERM_EN.usageSudo, '进站 v3 L1：旧 sudo security 不认');
  assert.equal(text(sh.exec('sudo styrigx now').out[0]), TERM_EN.usageSudo);
  sh.exec('theme').after();
  sh.exec('theme dark');
  assert.equal(text(sh.exec('theme pink').out[0]), TERM_EN.usageTheme);
  sh.exec('lock').after();
  sh.exec('ask  how is this site built?').after();
  sh.exec('ask').after();
  assert.deepEqual(calls, [['sudo', 'root'], ['go', 'root'], ['sudo', 'root', 'reauth'], ['go', 'root'], ['sudo', 'root', 'reset'], ['go', 'root'], ['theme', ''], ['theme', 'dark'], ['lock'], ['ask', 'how is this site built?'], ['ask', '']]);
});

test('sudo styrigx（进站 v3 L1）：打开盾牌（act.sudo(styrigx)），先打印再动', () => {
  const { act, calls } = fakeAct();
  const sh = createShell({ act, storage: mem() });
  const r = sh.exec('sudo styrigx');
  assert.match(text(r.out[0]), /^→ opening /);
  r.after();
  assert.deepEqual(calls[0].slice(0, 2), ['sudo', 'styrigx']);
});

test('历史：↑ 从最近一条往前，↓ 回到正在打的草稿；连续重复只记一次；存 sessionStorage（跨页保留，最多 50 条）', () => {
  const store = mem();
  const { act } = fakeAct({ scroll: ['blog'] });
  const sh = createShell({ act, storage: store });
  sh.exec('help');
  sh.exec('help');
  sh.exec('cd blog');
  sh.exec('ls');
  assert.deepEqual(sh.history(), ['help', 'cd blog', 'ls']);
  assert.equal(sh.prev('dra'), 'ls');
  assert.equal(sh.prev(''), 'cd blog');
  assert.equal(sh.prev(''), 'help');
  assert.equal(sh.prev(''), 'help', '到顶停住');
  assert.equal(sh.next(), 'cd blog');
  assert.equal(sh.next(), 'ls');
  assert.equal(sh.next(), 'dra', '回到草稿');
  assert.equal(sh.next(), null);
  const again = createShell({ act, storage: store });
  assert.deepEqual(again.history(), ['help', 'cd blog', 'ls']);
  for (let i = 0; i < 60; i++) again.exec('echo ' + i);
  assert.equal(JSON.parse(store.getItem('sgx-term-hist')).length, 50);
});

test('文案：外壳字符串表 en / zh 都有 term 节，键和引擎英文底一一对应；中文 help 说明照设计稿', () => {
  const en = yaml.load(readFileSync(path.join(REPO, 'space/web/data/sgx-shell-i18n/en.yaml'), 'utf8')).term;
  const zh = yaml.load(readFileSync(path.join(REPO, 'space/web/data/sgx-shell-i18n/zh.yaml'), 'utf8')).term;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(TERM_EN).sort());
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(TERM_EN).sort());
  for (const k of Object.keys(TERM_EN)) assert.equal(en[k], TERM_EN[k], 'en.' + k + ' 同引擎英文底');
  assert.equal(zh.hint, 'tab 补全 · ↑ 历史 · Ctrl K 全站呼出');
  assert.deepEqual([zh.dLs, zh.dAccount, zh.dSecurity, zh.dLock, zh.dAsk, zh.dClear], ['列出目录', '登录账号', '网站安全', '立即锁屏', '问 Gray AI', '清屏']);
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

test('man（终端统一 T5）：索引列出每条命令；man cd 一页（NAME / SYNOPSIS / (END)）进 pager；别名能查；没有的报错；help 不变', async () => {
  const { act } = fakeAct();
  const sh = createShell({ act, storage: mem() });
  const idx = await sh.exec('man');
  assert.equal(text(idx.out[0]), TERM_EN.manIndex);
  assert.deepEqual(idx.out.slice(1).map((o) => o.seg[0][1]), COMMANDS);
  for (const o of idx.out.slice(1)) assert.ok(!/undefined/.test(text(o)), text(o));
  const cd = await sh.exec('man cd');
  assert.equal(cd.pager, true);
  assert.deepEqual(cd.out.map(text), ['CD(1)', 'NAME', '    cd — move to a directory (on the home page, scroll to it)', 'SYNOPSIS', '    cd [blog | curio | daymark | wild | ~ | ..]', '(END)']);
  assert.equal(text((await sh.exec('man cls')).out[0]), 'CLEAR(1)');
  const no = await sh.exec('man nope');
  assert.equal(text(no.out[0]), 'No manual entry for nope');
  assert.equal(no.pager, undefined);
  for (const c of COMMANDS) assert.equal(text((await sh.exec('man ' + c)).out[0]), c.toUpperCase() + '(1)', '每条命令都有 man 页：' + c);
  assert.equal(sh.exec('help').out[0].rows.length, 8, 'help 不加 man 那一行（主页首屏自动 help 在视觉基线里）');
  assert.deepEqual(complete('man c'), { line: 'man c', options: ['cd', 'cat', 'clear'] });
  assert.deepEqual(complete('m'), { line: 'man ', options: [] });
});

test('man 节（en / zh）：键 = man 页的命令；英文表 = pages.js 英文底', async () => {
  const { PAGES } = await import('../../../../space/web/assets/js/shell/term/man/pages.js');
  const en = yaml.load(readFileSync(path.join(REPO, 'space/web/data/sgx-shell-i18n/en.yaml'), 'utf8')).man;
  const zh = yaml.load(readFileSync(path.join(REPO, 'space/web/data/sgx-shell-i18n/zh.yaml'), 'utf8')).man;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(PAGES).sort());
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(PAGES).sort());
  for (const k of Object.keys(PAGES)) assert.equal(en[k], PAGES[k].d, 'en.man.' + k);
});
