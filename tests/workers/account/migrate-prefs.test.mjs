/**
 * 一次性导入 scripts/migrate-prefs-kv-to-d1.mjs（2026-10-28）：KV account-prefs → D1 styrigx-account 的 settings_sync。
 * - planPrefsImport：清洗规则同接口（不合法的项跳过）
 * - runPrefsPlan：--dry-run 不写、apply 建表 + 写入、重复跑幂等、不盖掉 D1 里更新的值、--verify
 * - 导入后接口 GET /api/prefs 读到的就是 KV 里的那份
 * - CLI：经 CF_API_BASE 指向本地假 Cloudflare REST，跑 --dry-run / apply / --verify
 *
 * 运行：node --test tests/workers/account/migrate-prefs.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { makeAccountD1 } from './_d1.mjs';
import { planPrefsImport, runPrefsPlan, ACCOUNT_KV_NAMESPACE, LEGACY_PREFS_KEY } from '../../../scripts/migrate-prefs-kv-to-d1.mjs';
import { d1IdOf } from '../../../scripts/migrate-kv-to-d1.mjs';
import { rowsToPrefs } from '../../../workers/account/src/api/prefs.js';

const REPO = new URL('../../../', import.meta.url).pathname;
const NOW = Date.now() - 3600e3; /* 过去的时间：CLI 用真实时钟清洗（t 不能在未来） */

/** D1 REST 替身：api.d1(sql, params) → { results, meta }（同 cfApi().d1For） @param {ReturnType<typeof makeAccountD1>} db */
function restD1(db) {
  const calls = [];
  return {
    calls,
    d1: async (sql, params) => {
      calls.push(sql);
      const st = db.raw.prepare(sql);
      if (/^\s*SELECT/i.test(sql)) return { results: st.all(...(params || [])), meta: { changes: 0 } };
      const r = st.run(...(params || []));
      return { results: [], meta: { changes: Number(r.changes) } };
    },
  };
}

const KV_VALUE = JSON.stringify({
  items: {
    'sgx-theme-mode': { v: 'dark', t: NOW - 5000 },
    'sgx-palette': { v: null, t: NOW - 4000 },
    'sgx-lang': { v: 'zh', t: NOW - 3000 },
    'evil': { v: 'x', t: NOW - 1000 },
    'sgx-future': { v: 'x', t: NOW + 3 * 3600e3 },
    'sgx-num': { v: 5, t: NOW - 1000 },
  },
  updatedAt: NOW - 3000,
});

test('planPrefsImport：按接口规则清洗；没有 / 坏 JSON → 空计划', () => {
  const p = planPrefsImport(KV_VALUE, NOW);
  assert.equal(p.found, true);
  assert.equal(p.updatedAt, NOW - 3000);
  assert.equal(p.skipped, 3);
  assert.deepEqual(p.rows, [
    { k: 'sgx-lang', v: 'zh', t: NOW - 3000 },
    { k: 'sgx-palette', v: null, t: NOW - 4000 },
    { k: 'sgx-theme-mode', v: 'dark', t: NOW - 5000 },
  ]);
  assert.deepEqual(planPrefsImport(null, NOW), { found: false, updatedAt: 0, rows: [], skipped: 0 });
  assert.deepEqual(planPrefsImport('{oops', NOW).rows, []);
  assert.equal(planPrefsImport(JSON.stringify({ items: { 'sgx-a': { v: '1', t: 1 } } }), NOW).updatedAt, NOW, '没有 updatedAt → 按现在');
  assert.equal(ACCOUNT_KV_NAMESPACE, 'b20701f5f48e498e897bc6f0bd81643f');
  assert.equal(LEGACY_PREFS_KEY, 'account-prefs');
});

test('dry-run：不建表、不写；只打印计数，不打印值', async () => {
  const db = makeAccountD1({ migrations: false });
  const api = restD1(db);
  const r = await runPrefsPlan(api, planPrefsImport(KV_VALUE, NOW), { mode: 'dry-run' });
  assert.equal(r.ok, true);
  assert.equal(r.written, 0);
  assert.ok(api.calls.every((s) => /^\s*SELECT/i.test(s)), '只读');
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'settings_sync'").get().n, 0);
  const out = r.lines.join('\n');
  assert.match(out, /3 item\(s\) to import, 3 invalid item\(s\) skipped/);
  assert.match(out, /table missing \(will be created\); 3 row\(s\) would be written/);
  assert.doesNotMatch(out, /dark|zh|sgx-/);
});

test('apply：建表 + 写入；再跑一次幂等（0 行）；verify OK；接口读到同一份', async () => {
  const db = makeAccountD1({ migrations: false });
  const api = restD1(db);
  const plan = planPrefsImport(KV_VALUE, NOW);
  const a = await runPrefsPlan(api, plan, { mode: 'apply' });
  assert.equal(a.written, 3);
  const b = await runPrefsPlan(api, plan, { mode: 'apply' });
  assert.equal(b.written, 0, '重复跑不再写');
  assert.equal(db.rows('settings_sync').length, 3);
  const v = await runPrefsPlan(api, plan, { mode: 'verify' });
  assert.equal(v.ok, true);
  assert.match(v.lines.join('\n'), /verify OK/);
  const p = rowsToPrefs(db.rows('settings_sync'));
  assert.deepEqual(p, {
    items: { 'sgx-lang': { v: 'zh', t: NOW - 3000 }, 'sgx-palette': { v: null, t: NOW - 4000 }, 'sgx-theme-mode': { v: 'dark', t: NOW - 5000 } },
    updatedAt: NOW - 3000,
  });
  const dry = await runPrefsPlan(api, plan, { mode: 'dry-run' });
  assert.match(dry.lines.join('\n'), /0 row\(s\) would be written, 3 already same or newer/);
});

test('不盖掉 D1 里更新的值（上线后设备已同步过）；D1 里更旧的被 KV 值补上', async () => {
  const db = makeAccountD1();
  db.raw.prepare('INSERT INTO settings_sync (k, v, t, updated_at) VALUES (?, ?, ?, ?)').run('sgx-theme-mode', 'light', NOW - 100, NOW - 100);
  db.raw.prepare('INSERT INTO settings_sync (k, v, t, updated_at) VALUES (?, ?, ?, ?)').run('sgx-lang', 'en', NOW - 9000, NOW - 9000);
  const api = restD1(db);
  const plan = planPrefsImport(KV_VALUE, NOW);
  const dry = await runPrefsPlan(api, plan, { mode: 'dry-run' });
  assert.match(dry.lines.join('\n'), /2 row\(s\) in D1; 2 row\(s\) would be written, 1 already same or newer/);
  const a = await runPrefsPlan(api, plan, { mode: 'apply' });
  assert.equal(a.written, 2);
  const m = Object.fromEntries(db.rows('settings_sync').map((r) => [r.k, r.v]));
  assert.deepEqual(m, { 'sgx-lang': 'zh', 'sgx-palette': null, 'sgx-theme-mode': 'light' });
  assert.equal((await runPrefsPlan(api, plan, { mode: 'verify' })).ok, true, 'D1 里比 KV 新也算通过');
});

test('verify：没表 / 缺行 / D1 比 KV 旧 → 失败并列出键；KV 里没有 account-prefs → 空计划也 OK', async () => {
  const plan = planPrefsImport(KV_VALUE, NOW);
  let r = await runPrefsPlan(restD1(makeAccountD1({ migrations: false })), plan, { mode: 'verify' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['settings_sync (no table)']);
  const db = makeAccountD1();
  db.raw.prepare('INSERT INTO settings_sync (k, v, t, updated_at) VALUES (?, ?, ?, ?)').run('sgx-lang', 'en', NOW - 9000, 1);
  r = await runPrefsPlan(restD1(db), plan, { mode: 'verify' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.sort(), ['sgx-lang (older than KV)', 'sgx-palette (missing)', 'sgx-theme-mode (missing)']);
  r = await runPrefsPlan(restD1(makeAccountD1()), planPrefsImport(null, NOW), { mode: 'verify' });
  assert.equal(r.ok, true);
  assert.match(r.lines.join('\n'), /not found/);
});

test('默认目标库 = workers/account/wrangler.toml 的 D1_SETTINGS_SYNC（styrigx-account）', () => {
  assert.equal(d1IdOf(readFileSync(REPO + 'workers/account/wrangler.toml', 'utf8'), 'D1_SETTINGS_SYNC'), '03f60d23-9c2f-4f3d-a692-764ccaac6f5d');
});

/* ---------- CLI：本地假 Cloudflare REST ---------- */

/** @param {{kv: Map<string,string>, db: ReturnType<typeof makeAccountD1>}} st */
async function fakeCf(st) {
  const seen = [];
  const srv = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push(req.method + ' ' + req.url);
    const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.headers.authorization !== 'Bearer tok') return send(403, { success: false });
    let m = req.url.match(/^\/accounts\/acc\/storage\/kv\/namespaces\/([0-9a-f]+)\/values\/(.+)$/);
    if (m && req.method === 'GET') {
      const v = m[1] === ACCOUNT_KV_NAMESPACE ? st.kv.get(decodeURIComponent(m[2])) : undefined;
      if (v === undefined) { res.writeHead(404); return res.end(); }
      res.writeHead(200); return res.end(v);
    }
    m = req.url.match(/^\/accounts\/acc\/d1\/database\/([0-9a-f-]+)\/query$/);
    if (m && req.method === 'POST') {
      if (m[1] !== '03f60d23-9c2f-4f3d-a692-764ccaac6f5d') return send(404, { success: false, errors: [{ message: 'no db' }] });
      const q = JSON.parse(body);
      try {
        const s = st.db.raw.prepare(q.sql);
        const r = /^\s*SELECT/i.test(q.sql) ? { results: s.all(...q.params), meta: { changes: 0 } } : { results: [], meta: { changes: Number(s.run(...q.params).changes) } };
        return send(200, { success: true, result: [r] });
      } catch (e) {
        return send(400, { success: false, errors: [{ message: String(e.message) }] });
      }
    }
    send(404, { success: false });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: 'http://127.0.0.1:' + srv.address().port, seen, close: () => new Promise((r) => srv.close(r)) };
}

function runCli(args, base) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [REPO + 'scripts/migrate-prefs-kv-to-d1.mjs', ...args], {
      env: { ...process.env, CF_API_TOKEN: 'tok', CF_ACCOUNT_ID: 'acc', CF_API_BASE: base },
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('CLI：--dry-run → apply → apply（幂等）→ --verify；--preview 拒绝；只读 account-prefs，不写 KV', async () => {
  const st = { kv: new Map([[LEGACY_PREFS_KEY, KV_VALUE], ['avatar:v', 'v1']]), db: makeAccountD1({ migrations: false }) };
  const cf = await fakeCf(st);
  try {
    let r = await runCli(['--dry-run'], cf.base);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /dry-run: KV b20701f5f48e498e897bc6f0bd81643f \(account-prefs\) → D1 03f60d23-9c2f-4f3d-a692-764ccaac6f5d/);
    assert.match(r.out, /3 row\(s\) would be written/);
    r = await runCli(['--verify'], cf.base);
    assert.equal(r.code, 1, '导入前 verify 失败');
    r = await runCli([], cf.base);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /3 of 3 row\(s\) written/);
    r = await runCli([], cf.base);
    assert.match(r.out, /0 of 3 row\(s\) written/);
    r = await runCli(['--verify'], cf.base);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /verify OK/);
    assert.equal(st.db.rows('settings_sync').length, 3);
    r = await runCli(['--preview'], cf.base);
    assert.equal(r.code, 1);
    assert.match(r.out, /preview D1 styrigx-account-preview does not exist/);
    const kvCalls = cf.seen.filter((s) => s.includes('/storage/kv/'));
    assert.ok(kvCalls.length > 0);
    assert.ok(kvCalls.every((s) => s === 'GET /accounts/acc/storage/kv/namespaces/' + ACCOUNT_KV_NAMESPACE + '/values/account-prefs'), kvCalls.join('\n'));
  } finally {
    await cf.close();
  }
});
