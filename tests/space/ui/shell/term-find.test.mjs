/**
 * 终端 find / ask 按进站状态（v5 S4，space/web/assets/js/shell/term/cmds/ui/find.js、ask.js、term/core/registry.js listedFor）：
 * - 访客（nobody）：man 索引列 find、不列 ask；敲 ask 不开 AI，提示「AI 已上锁，先 sudo styrigx；搜关键词用 find」
 * - 进站后：man 列 ask、不列 find；ask 照常开 AI 代发；find 仍然能跑
 * - find 输出：每条一行 标题 · 站 · 路径（链接，href = 结果地址）；没结果 / 降级 / 429 / 网络错各一行；没参数给用法
 * - v5 S5：身份来自 term/core/who.js（nobody / link / styrigx / root），help 删了（man 取代）
 * - 文案 en / zh：键齐；中文 ask 提示照 Gray 定的句子
 * 运行：node --test tests/space/ui/shell/term-find.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { createShell, createWho, complete, COMMANDS, TERM_EN } from '../../../../space/web/assets/js/shell/terminal.js';
import { listedFor } from '../../../../space/web/assets/js/shell/term/core/registry.js';
import { pathOf } from '../../../../space/web/assets/js/shell/term/cmds/ui/find.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ZH = yaml.load(readFileSync(path.join(REPO, 'space/web/data/sgx-shell-i18n/zh.yaml'), 'utf8')).term;

function mem() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const text = (o) => (o.t === 'help' ? o.head.map((s) => s[1]).join('') + ' | ' + o.rows.map((r) => r[0]).join(',') : o.seg.map((s) => s[1]).join(''));

function shell({ nobody = true, find, str } = {}) {
  const calls = [];
  const act = {
    ask: (q) => calls.push(['ask', q]),
    find: find || ((q) => { calls.push(['find', q]); return Promise.resolve({ ok: true, q, results: [] }); }),
    cd: () => ({ kind: 'scroll', label: '' }), theme() {},
    today: () => Promise.resolve(null), daymarkHref: () => '/daymark/',
  };
  const who = { get: () => (nobody ? 'nobody' : 'styrigx'), on() {} };
  return { sh: createShell({ act, storage: mem(), who, str }), calls };
}
const manNames = async (sh) => (await sh.exec('man')).out.slice(1).map((o) => o.seg[0][1]);

test('listedFor：唯一判断点（audience 是身份数组；缺省都列）', () => {
  const find = { name: 'find', audience: ['nobody'] };
  const ask = { name: 'ask', audience: ['link', 'styrigx', 'root'] };
  assert.equal(listedFor(find, 'nobody'), true);
  for (const w of ['link', 'styrigx', 'root']) { assert.equal(listedFor(find, w), false, w); assert.equal(listedFor(ask, w), true, w); }
  assert.equal(listedFor(ask, 'nobody'), false);
  for (const w of ['nobody', 'link', 'styrigx', 'root']) assert.equal(listedFor({ name: 'cd' }, w), true, w);
});

test('访客（nobody）：man 列 find 不列 ask；进站后列 ask 不列 find；其余命令两边一样', async () => {
  const guest = await manNames(shell({ nobody: true }).sh);
  const entered = await manNames(shell({ nobody: false }).sh);
  assert.ok(guest.includes('find') && !guest.includes('ask'), guest.join(','));
  assert.ok(entered.includes('ask') && !entered.includes('find'), entered.join(','));
  /* 进站后多钥匙命令（lock / share），访客只有 sudo；其余通用命令两边一样 */
  const common = ['man', 'open', 'cd', 'ls', 'cat', 'clear', 'history', 'exit', 'pwd', 'theme'];
  assert.deepEqual(guest, common.concat(['find', 'sudo']));
  assert.deepEqual(entered, common.concat(['ask', 'sudo', 'lock', 'share']));
  for (const n of guest.concat(entered)) assert.ok(COMMANDS.includes(n), n);
  /* man find 一页 */
  const pg = await shell().sh.exec('man find');
  assert.deepEqual(pg.out.map(text), ['FIND(1)', 'NAME', '    find — search the four sites’ public pages by keyword', 'SYNOPSIS', '    find <keyword>', '(END)']);
});

test('访客敲 ask：不开 AI，提示先 sudo styrigx、搜关键词用 find（中文照 Gray 定的句子）', () => {
  const { sh, calls } = shell({ nobody: true });
  const r = sh.exec('ask 博客写了什么');
  assert.equal(r.after, undefined);
  assert.equal(text(r.out[0]), 'AI is locked · run sudo styrigx first; use find to search by keyword');
  assert.deepEqual(r.out[0].seg.filter((s) => s[0] === 'k').map((s) => s[1]), ['sudo styrigx', 'find']);
  assert.deepEqual(calls, []);
  const zh = shell({ nobody: true, str: ZH }).sh.exec('ask');
  assert.equal(text(zh.out[0]), 'AI 已上锁，先 sudo styrigx；搜关键词用 find');
});

test('进站后 ask：照常开 AI 代发（先打印再动）', () => {
  const { sh, calls } = shell({ nobody: false });
  const r = sh.exec('ask what is muse');
  assert.equal(text(r.out[0]), '→ ' + TERM_EN.asking);
  r.after();
  assert.deepEqual(calls, [['ask', 'what is muse']]);
});

test('find 输出：每条一行 标题 · 站 · 路径链接；pending = 搜的词；进站后也能跑', async () => {
  for (const nobody of [true, false]) {
    const results = [
      { title: 'Muse 使用技巧', url: 'https://styrigx.com/blog/zh/post/muse/', site: 'blog', snippet: '博客' },
      { title: 'Galaxy Buds', url: 'https://styrigx.com/curio/finds/#c/audio', site: 'curio', snippet: 'Finds' },
    ];
    const seen = [];
    const { sh } = shell({ nobody, find: (q) => { seen.push(q); return Promise.resolve({ ok: true, q, results }); } });
    const p = sh.exec('find  Muse 技巧 ');
    assert.equal(p.pending, 'Muse 技巧');
    const r = await p;
    assert.deepEqual(seen, ['Muse 技巧']);
    assert.equal(r.out.length, 2);
    assert.deepEqual(r.out[0].seg, [['k', 'Muse 使用技巧'], ['', '  blog  '], ['a', '/blog/zh/post/muse/', 'https://styrigx.com/blog/zh/post/muse/']]);
    assert.deepEqual(r.out[1].seg[2], ['a', '/curio/finds/#c/audio', 'https://styrigx.com/curio/finds/#c/audio']);
    for (const o of r.out) assert.ok(['k', '', 'a'].includes(o.seg[0][0]) && o.t === 'line', '只用现有的输出片段类');
  }
});

test('find：没参数给用法；没结果 / 降级 / 429 / 网络错各一行', async () => {
  assert.equal(text(shell().sh.exec('find').out[0]), TERM_EN.usageFind);
  const one = async (res) => (await shell({ find: () => res }).sh.exec('find muse')).out.map(text);
  assert.deepEqual(await one(Promise.resolve({ ok: true, results: [] })), ['find: no matches for muse']);
  assert.deepEqual(await one(Promise.resolve({ ok: true, results: [], degraded: true })), [TERM_EN.findDown]);
  assert.deepEqual(await one(Promise.resolve({ limited: true })), [TERM_EN.findLimited]);
  assert.deepEqual(await one(Promise.reject(new Error('net'))), [TERM_EN.findDown]);
  assert.deepEqual(await one(Promise.resolve(null)), [TERM_EN.findDown]);
});

test('help 删了（v5 S5，man 取代）；补全认得 find', () => {
  for (const nobody of [true, false]) assert.equal(text(shell({ nobody }).sh.exec('help').out[0]), 'command not found: help · try man');
  assert.deepEqual(complete('fi'), { line: 'find ', options: [] });
});

test('pathOf：绝对地址 → 站内路径（保留 #）；相对地址原样', () => {
  assert.equal(pathOf('https://styrigx.com/blog/post/x/'), '/blog/post/x/');
  assert.equal(pathOf('https://styrigx.com'), '/');
  assert.equal(pathOf('https://styrigx.com/curio/finds/?a=1#c/x'), '/curio/finds/#c/x');
  assert.equal(pathOf('/wild/'), '/wild/');
});

test('访客判断只看服务端（v5 S5 core/who.js）：页面标记 locked / 没回答 = nobody；进站会话 = styrigx', async () => {
  assert.equal(createWho({ check: () => Promise.resolve(null), page: () => 'locked' }).get(), 'nobody');
  assert.equal(createWho({ check: () => Promise.resolve(null), page: () => 'unknown' }).get(), 'nobody');
  const w = createWho({ check: () => Promise.resolve({ ok: true, by: 'password' }), page: () => 'locked' });
  assert.equal(await w.refresh(), 'styrigx');
});

test('文案：en / zh 都有 find / ask 提示的键', () => {
  const en = yaml.load(readFileSync(path.join(REPO, 'space/web/data/sgx-shell-i18n/en.yaml'), 'utf8')).term;
  for (const k of ['usageFind', 'findNone', 'findDown', 'findLimited', 'askLocked']) {
    assert.equal(en[k], TERM_EN[k], 'en.' + k);
    assert.ok(typeof ZH[k] === 'string' && ZH[k] && ZH[k] !== TERM_EN[k], 'zh.' + k);
  }
});
