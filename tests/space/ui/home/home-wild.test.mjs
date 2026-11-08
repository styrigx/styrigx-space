/**
 * 2026-11 对齐 PR-B（设计稿 tb4.html）：主页四节 + 旷野页的纯函数。
 * - lib/wb-view.js：fmtShort（终端短时长）、charBar（字符条）、termRows（区域行：字符条 · 时长 · 占比 · 最常看的一项）、renderWbTerm（full / mini 画进骨架）
 * - apps/index.js：curioSummary（[02] 奇趣三个目录卡的计数和那一条）、statusSummary（[04] status 小卡：up/n、平均延迟、检查时间）
 * 运行：node --test tests/space/ui/home/home-wild.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installI18nDom, setI18nLang } from '../../../fixtures/i18n-dom.mjs';

installI18nDom('zh');
const { fmtShort, charBar, termRows, renderWbTerm } = await import('../../../../space/web/assets/js/lib/wb-view.js');
const { curioSummary, statusSummary } = await import('../../../../space/web/assets/js/apps/index.js');

const FULL = '\u2588';
const EMPTY = '\u2591';

test('fmtShort：<1m / 42m / 1h 19m', () => {
  assert.equal(fmtShort(59), '<1m');
  assert.equal(fmtShort(42 * 60 + 30), '42m');
  assert.equal(fmtShort(79 * 60), '1h 19m');
  assert.equal(fmtShort(/** @type {any} */ (undefined)), '<1m');
});

test('charBar：按最大值缩放、满格 n、有时长至少 1 格、没时长 0 格', () => {
  assert.deepEqual(charBar(100, 100, 16), [FULL.repeat(16), '']);
  assert.deepEqual(charBar(50, 100, 16), [FULL.repeat(8), EMPTY.repeat(8)]);
  assert.deepEqual(charBar(1, 1000, 8), [FULL, EMPTY.repeat(7)], '至少 1 格');
  assert.deepEqual(charBar(0, 100, 8), ['', EMPTY.repeat(8)]);
  assert.deepEqual(charBar(5, 0, 8), ['', EMPTY.repeat(8)], 'max 为 0');
  assert.deepEqual(charBar(300, 100, 8), [FULL.repeat(8), ''], '不超过满格');
});

const DATA = {
  total: 100 * 60,
  sections: [
    { k: 'blog', sec: 20 * 60 },
    { k: 'home', sec: 30 * 60 },
    { k: 'settings', sec: 30 * 60 },
    { k: 'book', sec: 15 * 60 },
    { k: 'files', sec: 30 },
  ],
  items: [
    { k: 'post:hello', t: 'Hello 世界', sec: 600 },
    { k: 'book:x', t: '一本书', sec: 500 },
  ],
};

test('termRows：旧键并进 space、不到 1 分钟的区域不列、按时长排序；占比按 total；blog / book 带最常看的一项', () => {
  const rows = termRows(DATA);
  assert.deepEqual(rows.map((r) => r.k), ['space', 'blog', 'book']);
  assert.deepEqual(rows.map((r) => r.dur), ['1h 0m', '20m', '15m']);
  assert.deepEqual(rows.map((r) => r.pct), ['60%', '20%', '15%']);
  assert.deepEqual(rows.map((r) => r.top), ['', 'Hello 世界', '一本书']);
  assert.equal(rows[0].bar[0], FULL.repeat(16), '最多的那个满格');
  assert.equal(rows[1].bar[0].length + rows[1].bar[1].length, 16);
  assert.equal(rows[1].bar[0].length, 5, '20 / 60 × 16 ≈ 5');
  const mini = termRows(DATA, { n: 8, limit: 2 });
  assert.equal(mini.length, 2);
  assert.equal(mini[0].bar[0], FULL.repeat(8));
  assert.deepEqual(termRows({ total: 0, sections: [] }), []);
  assert.deepEqual(termRows(/** @type {any} */ (null)), []);
  assert.equal(termRows({ total: 0, sections: [{ k: 'space', sec: 120 }] })[0].pct, '0%', 'total 为 0 时占比 0%');
});

/* ---- renderWbTerm：最小假 DOM ---- */
function fakeNode(attrs = {}) {
  /** @type {any} */
  const n = {
    attrs: { ...attrs }, children: /** @type {any[]} */ ([]), innerHTML: '', textContent: '', hidden: false, style: { visibility: '' },
    getAttribute: (/** @type {string} */ k) => (k in n.attrs ? n.attrs[k] : null),
    appendChild: (/** @type {any} */ c) => { n.children.push(c); return c; },
    cloneNode: () => fakeNode(n.attrs),
    querySelector: (/** @type {string} */ sel) => n.all().find((/** @type {any} */ x) => match(x, sel)) || null,
    querySelectorAll: (/** @type {string} */ sel) => n.all().filter((/** @type {any} */ x) => match(x, sel)),
    all: () => n.children.flatMap((/** @type {any} */ c) => [c, ...c.all()]),
  };
  return n;
}
/** @param {any} x @param {string} sel */
function match(x, sel) {
  const m = sel.match(/^\[([a-z-]+)(?:="([^"]+)")?\]$/);
  if (!m) return false;
  return m[2] === undefined ? m[1] in x.attrs : x.attrs[m[1]] === m[2];
}
function makeRoot(/** @type {'full'|'mini'} */ kind) {
  const root = fakeNode({ 'data-wb-term': kind });
  const rows = root.appendChild(fakeNode({ 'data-wb': 'rows' }));
  for (let i = 0; i < 3; i++) rows.appendChild(fakeNode({ 'data-wb-row': '' }));
  const none = root.appendChild(fakeNode({ 'data-wb': 'none' }));
  none.hidden = true;
  const total = root.appendChild(fakeNode({ 'data-wb': 'total' }));
  const scope = root.appendChild(fakeNode({ 'data-wb': 'scope' }));
  return { root, rows, none, total, scope };
}

test('renderWbTerm full：骨架不够就补行；每行 区域 · 字符条 · 时长 · 占比 (· 那一项)；total、scope 换上', () => {
  setI18nLang('zh');
  const big = { ...DATA, sections: [...DATA.sections, { k: 'browser', sec: 5 * 60 }] };
  const r = makeRoot('full');
  renderWbTerm(r.root, big, { scope: '今天 · 本机' });
  const slots = r.rows.children;
  assert.equal(slots.length, 4, '3 行骨架 + 补 1 行');
  assert.match(slots[0].innerHTML, /<span class="wb-k" translate="no">space<\/span><span class="wb-cbar" aria-hidden="true"><b>█{16}<\/b><i><\/i><\/span><span class="wb-t">1h 0m<\/span><span class="wb-p">60%<\/span>$/);
  assert.match(slots[1].innerHTML, /<span class="wb-it">Hello 世界<\/span>$/);
  assert.equal(r.total.textContent, '1h 40m');
  assert.equal(r.scope.textContent, '今天 · 本机');
  assert.equal(r.none.hidden, true);
  /* 不给 scope → 「今天 · 所有设备」字符串表 */
  const r2 = makeRoot('full');
  renderWbTerm(r2.root, DATA);
  assert.ok(r2.scope.textContent && r2.scope.textContent !== '今天 · 本机');
});

test('renderWbTerm mini：最多 3 行、8 格字符条、没有占比；名字转义', () => {
  const r = makeRoot('mini');
  renderWbTerm(r.root, { total: 600, sections: [{ k: '<x>', sec: 600 }] });
  const s = r.rows.children;
  assert.match(s[0].innerHTML, /^<span class="wb-k" translate="no">&lt;x&gt;<\/span> <span class="wb-cbar" aria-hidden="true"><b>█{8}<\/b><i><\/i><\/span> <span class="wb-t">10m<\/span>$/);
  assert.doesNotMatch(s[0].innerHTML, /wb-p/);
  /* 没数据的骨架行：mini 留高度（visibility hidden，不 hidden） */
  assert.equal(s[1].style.visibility, 'hidden');
  assert.equal(s[1].hidden, false);
});

test('renderWbTerm：没有记录 → full 骨架行收起、显示「没有记录」；mini 骨架留高度', () => {
  const r = makeRoot('full');
  renderWbTerm(r.root, { total: 0, sections: [] });
  assert.ok(r.rows.children.every((/** @type {any} */ x) => x.hidden));
  assert.equal(r.none.hidden, false);
  assert.equal(r.total.textContent, '<1m');
  const m = makeRoot('mini');
  renderWbTerm(m.root, { total: 0, sections: [] });
  assert.ok(m.rows.children.every((/** @type {any} */ x) => !x.hidden && x.style.visibility === 'hidden'));
  assert.equal(m.none.hidden, false);
});

test('curioSummary：finds = 全部链接数 + id 最大的那条（按语言取名，缺了回退 / 域名）；devices 在用 = 第一台没退役；games 在玩 = 第一个 playing', () => {
  const links = { ok: true, cats: [
    { links: [{ id: 3, name: { zh: '三', en: 'Three' }, url: 'https://a.com' }, { id: 9, name: { en: 'Nine' }, url: 'https://b.com' }] },
    { links: [{ id: 5, name: '', url: 'https://c.example.org/x' }, null] },
    null,
  ] };
  const items = { ok: true,
    devices: [{ name: 'Old', retired_at: '2024-01-01' }, { name: 'Galaxy S26', retired_at: null }, { name: 'Tab' }],
    games: [{ title: 'Zelda', status: 'done' }, { title: 'Hades II', status: 'playing' }] };
  const zh = curioSummary(links, items, 'zh');
  assert.deepEqual(zh.finds, { n: 3, latest: 'Nine' }, '缺中文回退英文');
  assert.deepEqual(zh.devices, { n: 3, latest: 'Galaxy S26' });
  assert.deepEqual(zh.games, { n: 2, latest: 'Hades II' });
  assert.deepEqual(curioSummary({ ok: true, cats: [{ links: [{ id: 1, name: null, url: 'https://c.example.org/x' }] }] }, null, 'en').finds, { n: 1, latest: 'c.example.org' }, '没名字用域名');
  assert.deepEqual(curioSummary({ ok: true, cats: [{ links: [{ id: 1, url: 'not a url' }] }] }, null, 'en').finds, { n: 1, latest: '' });
});

test('curioSummary：取不到 / ok:false → 对应项 null；空列表 → n 0 且那一条为空', () => {
  assert.deepEqual(curioSummary(null, null, 'zh'), { finds: null, devices: null, games: null });
  assert.deepEqual(curioSummary({ ok: false }, { ok: false }, 'zh'), { finds: null, devices: null, games: null });
  assert.deepEqual(curioSummary({ ok: true, cats: [] }, { ok: true }, 'en'), { finds: { n: 0, latest: '' }, devices: { n: 0, latest: '' }, games: { n: 0, latest: '' } });
  const all = curioSummary(null, { ok: true, devices: [{ name: 'A', retired_at: 'x' }], games: [{ title: 'B', status: 'done' }] }, 'en');
  assert.deepEqual([all.devices, all.games], [{ n: 1, latest: '' }, { n: 1, latest: '' }], '全退役 / 没在玩 → 那一条为空');
});

test('statusSummary：up / n、有数格子的平均延迟（四舍五入）、检查时间按北京时间 HH:MM', () => {
  const t = Date.parse('2026-11-08T04:05:00Z'); /* 北京 12:05 */
  const v = { t, cells: { space: { up: true, ms: 100 }, blog: { up: true, ms: 101 }, ai: { up: false, ms: null }, auth: { up: true, ms: 50 } } };
  assert.deepEqual(statusSummary(v), { up: 3, n: 4, avg: 84, at: '12:05' });
  const late = Date.parse('2026-11-08T16:30:00Z'); /* 北京次日 00:30 */
  assert.equal(statusSummary({ t: late, cells: {} }).at, '00:30');
  assert.deepEqual(statusSummary({ t: 0, cells: { a: { up: false, ms: null } } }), { up: 0, n: 1, avg: null, at: '' });
  assert.deepEqual(statusSummary(/** @type {any} */ (null)), { up: 0, n: 0, avg: null, at: '' });
});
