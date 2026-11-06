/**
 * B2-7 网站数字健康：接口校验 / 汇总、计时器拆包、区域映射、时长格式。
 * 接口 2026-10-24 搬到账号 Worker styrigx-account（workers/account/src/api/wellbeing.js）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReport, summarize, dayOk, sectionOf, onRequestPost as rawPost, onRequestGet as rawGet } from '../../../workers/account/src/api/wellbeing.js';
import { wrap, testAccountSessionCookie } from './_auth.mjs';
import { testLockSessionCookie } from '../auth-gateway/_tickets.mjs';
import { genKeyPair, authD1For, makeKV } from '../_harness.mjs';

const onRequestPost = wrap(rawPost);
const onRequestGet = wrap(rawGet);
import { buildBody, localDay } from '../../../space/web/assets/js/lib/wb-track.js';
import { wbAreaOf } from '../../../space/web/assets/js/lib/wb-area.js';
import { fmtDur, foldSections } from '../../../space/web/assets/js/lib/wb-view.js';

const NOW = Date.parse('2026-10-17T09:00:00Z');

test('dayOk：只接受 UTC 今天前后 1 天', () => {
  assert.ok(dayOk('2026-10-17', NOW));
  assert.ok(dayOk('2026-10-16', NOW));
  assert.ok(dayOk('2026-10-18', NOW));
  assert.ok(!dayOk('2026-10-15', NOW));
  assert.ok(!dayOk('2026-10-19', NOW));
  assert.ok(!dayOk('2026/10/17', NOW));
  assert.ok(!dayOk('', NOW));
});

test('parseReport：合法上报规整、同键合并', () => {
  const r = parseReport({ d: '2026-10-17', s: [
    { k: 'home', sec: 30 },
    { k: 'book:abc-1', t: '  三体\n ', sec: 100.4 },
    { k: 'home', sec: 20 },
  ] }, NOW);
  assert.deepEqual(r, { d: '2026-10-17', s: [
    { k: 'home', t: '', sec: 50 },
    { k: 'book:abc-1', t: '三体', sec: 100 },
  ] });
});

test('parseReport：非法上报全部拒绝', () => {
  const bad = [
    null, {}, { d: '2026-10-17' }, { d: '2026-10-17', s: [] },
    { d: '2020-01-01', s: [{ k: 'home', sec: 5 }] },
    { d: '2026-10-17', s: [{ k: 'evil', sec: 5 }] },
    { d: '2026-10-17', s: [{ k: 'post:<script>', sec: 5 }] },
    { d: '2026-10-17', s: [{ k: 'home', sec: 0 }] },
    { d: '2026-10-17', s: [{ k: 'home', sec: 901 }] },
    { d: '2026-10-17', s: [{ k: 'home', sec: 'x' }] },
    { d: '2026-10-17', s: Array.from({ length: 13 }, () => ({ k: 'home', sec: 1 })) },
  ];
  for (const b of bad) assert.equal(parseReport(b, NOW), null, JSON.stringify(b));
});

test('summarize：按区域合计；书名只给 detail（账号会话）', () => {
  const rows = [
    { k: 'home', t: '', sec: 120 },
    { k: 'book:a', t: '三体', sec: 600 },
    { k: 'book:b', t: '活着', sec: 300 },
    { k: 'post:hello', t: 'Hello', sec: 90 },
  ];
  const o = summarize(rows, true);
  assert.equal(o.total, 1110);
  /* P4-3 PR-4b：旧键 home 并进 space */
  assert.deepEqual(o.sections, [{ k: 'book', sec: 900 }, { k: 'space', sec: 120 }, { k: 'blog', sec: 90 }]);
  assert.equal(o.items[0].t, '三体');
  const v = summarize(rows, false);
  assert.deepEqual(v.items, []);
  assert.equal(v.total, 1110);
  assert.equal(sectionOf('post:x'), 'blog');
});

test('PR-4b 读旧写新：新键 space 能上报；旧键 home / settings 照收，汇总并进 space', () => {
  assert.equal(sectionOf('space'), 'space');
  assert.equal(sectionOf('home'), 'space');
  assert.equal(sectionOf('settings'), 'space');
  const d = new Date().toISOString().slice(0, 10);
  for (const k of ['space', 'home', 'settings']) assert.ok(parseReport({ d, s: [{ k, sec: 30 }] }), k + ' 应能上报');
  const o = summarize([{ k: 'home', t: '', sec: 60 }, { k: 'settings', t: '', sec: 30 }, { k: 'space', t: '', sec: 10 }, { k: 'files', t: '', sec: 5 }], false);
  assert.deepEqual(o.sections, [{ k: 'space', sec: 100 }, { k: 'files', sec: 5 }]);
  assert.equal(o.total, 105);
});

test('POST / GET：无会话 401，不碰数据库', async () => {
  let touched = false;
  const env = { D1_WELLBEING: { prepare() { touched = true; } } };
  const post = await onRequestPost({ request: new Request('https://styrigx.com/api/wellbeing', { method: 'POST', body: '{}' }), env });
  assert.equal(post.status, 401);
  const get = await onRequestGet({ request: new Request('https://styrigx.com/api/wellbeing'), env });
  assert.equal(get.status, 401);
  assert.equal(touched, false);
});

test('buildBody：每条最多 900 秒，余量留下次；不足 1 秒不发', () => {
  const { body, rest } = buildBody({ d: '2026-10-17', s: {
    home: { t: '', sec: 1000.5 },
    files: { t: '', sec: 0.4 },
    'book:a': { t: '三体', sec: 61.9 },
  } });
  const b = JSON.parse(body);
  assert.deepEqual(b, { d: '2026-10-17', s: [{ k: 'home', sec: 900 }, { k: 'book:a', sec: 61, t: '三体' }] });
  assert.ok(Math.abs(rest.s.home.sec - 100.5) < 1e-9);
  assert.ok(Math.abs(rest.s.files.sec - 0.4) < 1e-9);
  assert.ok(Math.abs(rest.s['book:a'].sec - 0.9) < 1e-9);
  assert.equal(buildBody({ d: '2026-10-17', s: { home: { t: '', sec: 0.2 } } }).body, '');
});

test('localDay：本机日期补零', () => {
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('wbAreaOf：主站页面映射', () => {
  /* P4-3 PR-4b：旷野页、旷野子页、账号页都记 space（只写新键） */
  assert.equal(wbAreaOf('/'), 'space');
  assert.equal(wbAreaOf('/en/'), 'space');
  assert.equal(wbAreaOf('/files/'), 'files');
  assert.equal(wbAreaOf('/en/browser/'), 'browser');
  assert.equal(wbAreaOf('/bookmarks/'), null); /* 2026-10-21 主站书签下线 */
  assert.equal(wbAreaOf('/en/search/'), 'browser');
  for (const p of ['/theme/', '/display/', '/wellbeing/', '/about/', '/status/', '/security/', '/security/lock/', '/en/security/tempkeys/', '/account/', '/en/account/devices/']) {
    assert.equal(wbAreaOf(p), 'space', p);
  }
  assert.equal(wbAreaOf('/blog/'), null, '子站不归主站区域');
  assert.equal(wbAreaOf('/themes/'), null, '只认整段');
  assert.equal(wbAreaOf('/app-verify/'), null);
  assert.equal(wbAreaOf('/404.html'), null);
});

test('foldSections（前端读旧）：home / settings 并进 space，同键相加、按时长排序', () => {
  assert.deepEqual(foldSections([{ k: 'home', sec: 100 }, { k: 'blog', sec: 120 }, { k: 'settings', sec: 50 }, { k: 'space', sec: 10 }]), [
    { k: 'space', sec: 160 },
    { k: 'blog', sec: 120 },
  ]);
  assert.deepEqual(foldSections([]), []);
});

test('fmtDur：中英文时长', () => {
  assert.equal(fmtDur(30, false), '不到 1 分钟');
  assert.equal(fmtDur(65 * 60, false), '1 小时 5 分钟');
  assert.equal(fmtDur(120 * 60, false), '2 小时');
  assert.equal(fmtDur(5 * 60, true), '5 min');
  assert.equal(fmtDur(150 * 60, true, true), '2 hrs 30 min');
});

/* ---- P2-2：POST 只记账号会话 + wellbeing.write；GET 明细只给账号会话，响应带 detail ---- */
const LK = await genKeyPair();
const AK = await genKeyPair();
/** D1_WELLBEING 替身：记下写入；SELECT 返回固定两行 */
function wbDb() {
  const db = {
    writes: 0,
    prepare(sql) {
      return {
        run: async () => ({}),
        bind: () => ({ all: async () => ({ results: [{ k: 'home', t: '', sec: 60 }, { k: 'book:a', t: '三体', sec: 30 }] }) }),
        sql,
      };
    },
    async batch(stmts) { db.writes += stmts.length; return []; },
  };
  return db;
}
function wbEnv(db) {
  const kv = makeKV();
  return { SGX_LOCK_PUBLIC: LK.pub, SGX_ACCOUNT_PUBLIC: AK.pub, D1_LOCK_AUTH: authD1For(kv), D1_ACCOUNT_AUTH: authD1For(kv), D1_WELLBEING: db };
}
async function wbCookie(role, acc) {
  const c = [await testLockSessionCookie(LK.priv, 0, role)];
  if (acc) c.push(await testAccountSessionCookie(AK.priv, 'password', 0, Date.now()));
  return c.join('; ');
}
const body = () => JSON.stringify({ d: new Date().toISOString().slice(0, 10), s: [{ k: 'home', sec: 30 }] });

test('POST：进门没账号会话 → 204 丢弃不写（锁屏密码 / 临时钥匙进门一样）；进门 + 账号会话 → 写入', async () => {
  for (const role of ['password', 'tempkey']) {
    const db = wbDb();
    const r = await onRequestPost({ request: new Request('https://styrigx.com/api/wellbeing', { method: 'POST', body: body(), headers: { Cookie: await wbCookie(role, false) } }), env: wbEnv(db) });
    assert.equal(r.status, 204);
    assert.equal(db.writes, 0, role);
  }
  const db = wbDb();
  const r = await onRequestPost({ request: new Request('https://styrigx.com/api/wellbeing', { method: 'POST', body: body(), headers: { Cookie: await wbCookie('password', true) } }), env: wbEnv(db) });
  assert.equal(r.status, 204);
  assert.ok(db.writes >= 1);
});

test('GET：没账号会话 detail:false 只有合计；有账号会话 detail:true 带书名', async () => {
  const a = await onRequestGet({ request: new Request('https://styrigx.com/api/wellbeing', { headers: { Cookie: await wbCookie('password', false) } }), env: wbEnv(wbDb()) });
  assert.equal(a.status, 200);
  const ja = await a.json();
  assert.equal(ja.detail, false);
  assert.equal(ja.total, 90);
  assert.deepEqual(ja.items, []);
  const b = await onRequestGet({ request: new Request('https://styrigx.com/api/wellbeing', { headers: { Cookie: await wbCookie('tempkey', true) } }), env: wbEnv(wbDb()) });
  const jb = await b.json();
  assert.equal(jb.detail, true);
  assert.equal(jb.items[0].t, '三体');
  const c = await onRequestGet({ request: new Request('https://styrigx.com/api/wellbeing', { headers: { Cookie: await wbCookie('password', false) } }), env: { ...wbEnv(null), D1_WELLBEING: undefined } });
  assert.equal((await c.json()).detail, false);
});
