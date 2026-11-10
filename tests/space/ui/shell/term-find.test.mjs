/**
 * 终端 find / ask 按进站状态（v5 S4，space/web/assets/js/shell/term/cmds/ui/find.js、ask.js、term/core/registry.js listedFor）：
 * - 访客（nobody）：man 索引列 find、不列 ask；敲 ask 不开 AI，提示「AI 已上锁，先 sudo styrigx；搜关键词用 find」
 * - 进站后：man 列 ask、不列 find；ask 照常开 AI 代发；find 仍然能跑
 * - find 输出：每条一行 标题 · 站 · 路径（链接，href = 结果地址）；没结果 / 降级 / 429 / 网络错各一行；没参数给用法
 * - help 不变（find 不进 help：主页首屏自动 help 在视觉基线里）
 * - 文案 en / zh：键齐；中文 ask 提示照 Gray 定的句子
 * 运行：node --test tests/space/ui/shell/term-find.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { createShell, complete, COMMANDS, TERM_EN, visitorPage } from '../../../../space/web/assets/js/shell/terminal.js';
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
    cd: () => ({ kind: 'scroll', label: '' }), sudo: () => ({ href: '', go() {} }), theme() {}, lock() {},
    today: () => Promise.resolve(null), daymarkHref: () => '/daymark/',
  };
  return { sh: createShell({ act, storage: mem(), visitor: () => nobody, str }), calls };
}
const manNames = async (sh) => (await sh.exec('man')).out.slice(1).map((o) => o.seg[0][1]);

test('listedFor：唯一判断点（nobody 只给访客、entered 只给进站后、缺省都列）', () => {
  assert.equal(listedFor({ name: 'find', audience: 'nobody' }, true), true);
  assert.equal(listedFor({ name: 'find', audience: 'nobody' }, false), false);
  assert.equal(listedFor({ name: 'ask', audience: 'entered' }, true), false);
  assert.equal(listedFor({ name: 'ask', audience: 'entered' }, false), true);
  assert.equal(listedFor({ name: 'cd' }, true), true);
  assert.equal(listedFor({ name: 'cd' }, false), true);
});

test('访客（nobody）：man 列 find 不列 ask；进站后列 ask 不列 find；其余命令两边一样', async () => {
  const guest = await manNames(shell({ nobody: true }).sh);
  const entered = await manNames(shell({ nobody: false }).sh);
  assert.ok(guest.includes('find') && !guest.includes('ask'), guest.join(','));
  assert.ok(entered.includes('ask') && !entered.includes('find'), entered.join(','));
  assert.deepEqual(guest.filter((n) => n !== 'find'), entered.filter((n) => n !== 'ask'));
  assert.deepEqual(guest, COMMANDS.filter((c) => c !== 'ask'));
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

test('help 不变（find 不进 help；主页首屏自动 help 在视觉基线里）；补全认得 find', () => {
  for (const nobody of [true, false]) {
    const h = shell({ nobody }).sh.exec('help');
    assert.equal(text(h.out[0]), 'cd blog · curio · daymark · wild · ~ | ls,cat,sudo root,sudo styrigx,theme,lock,ask,clear');
  }
  assert.deepEqual(complete('fi'), { line: 'find ', options: [] });
});

test('pathOf：绝对地址 → 站内路径（保留 #）；相对地址原样', () => {
  assert.equal(pathOf('https://styrigx.com/blog/post/x/'), '/blog/post/x/');
  assert.equal(pathOf('https://styrigx.com'), '/');
  assert.equal(pathOf('https://styrigx.com/curio/finds/?a=1#c/x'), '/curio/finds/#c/x');
  assert.equal(pathOf('/wild/'), '/wild/');
});

test('visitorPage：只认 data-sgx-lock-session="locked"；没有 document 不算访客', () => {
  const doc = (v) => ({ documentElement: { getAttribute: (k) => (k === 'data-sgx-lock-session' ? v : null) } });
  assert.equal(visitorPage(doc('locked')), true);
  assert.equal(visitorPage(doc('valid')), false);
  assert.equal(visitorPage(doc(null)), false);
  assert.equal(visitorPage(), false);
});

test('文案：en / zh 都有 find / ask 提示的键', () => {
  const en = yaml.load(readFileSync(path.join(REPO, 'space/web/data/sgx-shell-i18n/en.yaml'), 'utf8')).term;
  for (const k of ['usageFind', 'findNone', 'findDown', 'findLimited', 'askLocked']) {
    assert.equal(en[k], TERM_EN[k], 'en.' + k);
    assert.ok(typeof ZH[k] === 'string' && ZH[k] && ZH[k] !== TERM_EN[k], 'zh.' + k);
  }
});
