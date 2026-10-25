/**
 * GET /api/root-audit 返回的是最新的 50 条（gateway 审计 #8）。
 * kv.list 按键名升序、分页返回；键是 root-audit:<毫秒>:<随机>，所以第一页的前 50 个是最旧的。
 * 这里用每页 40 个键的分页 KV 模拟线上，写 130 条，断言拿到的是最后 50 条、新的在前。
 *
 * 运行：node --test tests/workers/auth-gateway/root-audit.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet, AUDIT_SHOW } from '../../../workers/auth-gateway/functions/api/root-audit.js';
import { testLockSessionCookie, testTicketCookie } from './_tickets.mjs';
import { LOCK_REAUTH_TICKET } from '../../../workers/auth-gateway/functions/_kernel/realms.js';
import { genKeyPair } from '../_harness.mjs';

const { priv: PRIV, pub: PUB } = await genKeyPair();

/** 分页 KV：list 按键名升序，每页 pageSize 个，带 cursor / list_complete（与 Workers KV 一致） */
function pagedKV(seed, pageSize) {
  const m = new Map(Object.entries(seed));
  const calls = { list: 0 };
  return {
    get: async (k, fmt) => {
      const v = m.has(k) ? m.get(k) : null;
      if (v === null) return null;
      return fmt === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix = '', cursor } = {}) => {
      calls.list++;
      const all = [...m.keys()].filter((n) => n.startsWith(prefix)).sort();
      const start = cursor ? parseInt(cursor, 10) : 0;
      const keys = all.slice(start, start + pageSize).map((name) => ({ name }));
      const done = start + pageSize >= all.length;
      return done ? { keys, list_complete: true } : { keys, list_complete: false, cursor: String(start + pageSize) };
    },
    calls,
  };
}

async function req() {
  const cookie = (await testLockSessionCookie(PRIV, 0, 'admin')) + '; ' + (await testTicketCookie(PRIV, LOCK_REAUTH_TICKET, 'root', 0));
  return new Request('https://styrigx.com/api/root-audit', { headers: { Cookie: cookie } });
}

test('root-audit：130 条分 4 页，返回最新的 50 条（新的在前），不是第一页的前 50 条', async () => {
  const t0 = Date.now() - 6 * 86400e3;
  const seed = { 'lock-epoch': '0' };
  for (let i = 0; i < 130; i++) {
    const ts = t0 + i * 60000;
    seed['root-audit:' + ts + ':r' + i] = JSON.stringify({ ts, ipPrefix: '10.0.' + i + '.x', ok: i % 2 === 0 });
  }
  const kv = pagedKV(seed, 40);
  const res = await onRequestGet({ request: await req(), env: { SGX_LOCK_PUBLIC: PUB, KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv } });
  assert.equal(res.status, 200);
  const { ok, items } = await res.json();
  assert.equal(ok, true);
  assert.equal(items.length, AUDIT_SHOW);
  assert.equal(items[0].ts, t0 + 129 * 60000, '第一条是最新的');
  assert.equal(items[49].ts, t0 + 80 * 60000, '最后一条是倒数第 50 条');
  for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].ts > items[i].ts, '按时间倒序');
  assert.equal(kv.calls.list, 4, '翻完 4 页');
});

test('root-audit：不到 50 条时全返回；没有记录时返回空列表', async () => {
  const seed = { 'lock-epoch': '0' };
  for (let i = 0; i < 7; i++) seed['root-audit:' + (1700000000000 + i) + ':x' + i] = JSON.stringify({ ts: 1700000000000 + i, ipPrefix: 'p', ok: true });
  let kv = pagedKV(seed, 40);
  let res = await onRequestGet({ request: await req(), env: { SGX_LOCK_PUBLIC: PUB, KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv } });
  assert.equal((await res.json()).items.length, 7);
  kv = pagedKV({ 'lock-epoch': '0' }, 40);
  res = await onRequestGet({ request: await req(), env: { SGX_LOCK_PUBLIC: PUB, KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv } });
  assert.deepEqual(await res.json(), { ok: true, items: [] });
});

test('root-audit：kv.list 出错 → 503 server', async () => {
  const kv = pagedKV({ 'lock-epoch': '0' }, 40);
  kv.list = async () => { throw new Error('kv'); };
  const res = await onRequestGet({ request: await req(), env: { SGX_LOCK_PUBLIC: PUB, KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv } });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, error: 'server' });
});
