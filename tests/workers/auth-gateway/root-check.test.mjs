/**
 * 根凭证比对（_kernel/root-check.js checkRootCredential）的耗时对齐 padTo：
 * - 比对失败：先计数、再写审计，最后调 padTo，然后才返回 401 auth（真失败与假入口耗时一致）
 * - 比对成功：不调 padTo
 * - 被限速（429）、限速 KV 出错（503）、计数 KV 出错（503）：不走到比对，也不调 padTo
 * root-auth 把 padTo 接到自己的 t0 上：真路径失败与无会话假入口都对齐同一个耗时。
 *
 * 运行：node --test tests/workers/auth-gateway/root-check.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRootCredential } from '../../../workers/auth-gateway/functions/_kernel/root-check.js';

const ROOT_KEY = 'root-key-for-tests-0123456789';

/** 记录每一次 KV 写和 padTo 调用的先后 */
function setup(seed = {}, fail = {}) {
  const m = new Map(Object.entries(seed));
  const log = [];
  const kv = {
    get: async (k, fmt) => {
      if (fail.get && fail.get(k)) throw new Error('kv-get');
      const v = m.has(k) ? m.get(k) : null;
      if (v === null) return null;
      return fmt === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => {
      if (fail.put && fail.put(k)) throw new Error('kv-put');
      log.push('put:' + k.split(':')[0]);
      m.set(k, v);
    },
    delete: async (k) => { log.push('delete:' + k.split(':')[0]); m.delete(k); },
  };
  const padTo = async () => { log.push('padTo'); };
  return { kv, log, padTo, m };
}
const run = (s, key, ip = '192.0.2.10') => checkRootCredential({ env: { SGX_ROOT_KEY: ROOT_KEY }, kv: s.kv, ip, key, auditPath: 'lock-reset', padTo: s.padTo });

test('比对失败：计数 → 审计 → padTo → 401 auth（padTo 在审计写入之后、只调一次）', async () => {
  const s = setup();
  const r = await run(s, 'wrong');
  assert.equal(r.ok, false);
  assert.equal(r.response.status, 401);
  assert.deepEqual(await r.response.json(), { ok: false, error: 'auth' });
  assert.deepEqual(s.log, ['put:root-fail', 'put:root-fail-global', 'put:root-audit', 'padTo']);
});

test('空串 / 只有空白的输入也是比对失败，同样 padTo', async () => {
  for (const key of ['', '   \n\t']) {
    const s = setup();
    const r = await run(s, key);
    assert.equal(r.response.status, 401);
    assert.equal(s.log.filter((x) => x === 'padTo').length, 1);
    assert.equal(s.log[s.log.length - 1], 'padTo');
  }
});

test('比对成功：不调 padTo（清掉本 IP 计数：先读、有才删，E7）', async () => {
  const s = setup();
  const r = await run(s, '  ' + ROOT_KEY + '\n');
  assert.equal(r.ok, true);
  assert.equal(s.log.includes('padTo'), false);
  /* 之前没输错过：没有计数键，不发删除 */
  assert.deepEqual(s.log, []);
  /* 之前输错过：照旧删掉本 IP 计数 */
  const s2 = setup({ 'root-fail:192.0.2.10': JSON.stringify({ count: 2 }) });
  const r2 = await run(s2, ROOT_KEY);
  assert.equal(r2.ok, true);
  assert.deepEqual(s2.log, ['delete:root-fail']);
  assert.equal(s2.m.has('root-fail:192.0.2.10'), false);
});

test('本 IP 被锁（429 cooldown）：写审计，不比对、不 padTo', async () => {
  const s = setup({ 'root-fail:192.0.2.10': JSON.stringify({ count: 0, lockedUntil: Date.now() + 60000 }) });
  const r = await run(s, ROOT_KEY);
  assert.equal(r.response.status, 429);
  assert.deepEqual(await r.response.json(), { ok: false, error: 'cooldown' });
  assert.deepEqual(s.log, ['put:root-audit']);
});

test('限速 KV 读出错：503 server，不比对、不 padTo、不写任何东西', async () => {
  const s = setup({}, { get: () => true });
  const r = await run(s, ROOT_KEY);
  assert.equal(r.response.status, 503);
  assert.deepEqual(await r.response.json(), { ok: false, error: 'server' });
  assert.deepEqual(s.log, []);
});

test('失败计数写不进去：503 server（fail closed），不 padTo', async () => {
  const s = setup({}, { put: (k) => k.startsWith('root-fail') });
  const r = await run(s, 'wrong');
  assert.equal(r.response.status, 503);
  assert.deepEqual(await r.response.json(), { ok: false, error: 'server' });
  assert.equal(s.log.includes('padTo'), false);
});

test('没有传 padTo 时失败照常返回 401（lock-reset 路径）', async () => {
  const s = setup();
  const r = await checkRootCredential({ env: { SGX_ROOT_KEY: ROOT_KEY }, kv: s.kv, ip: '192.0.2.11', key: 'wrong', auditPath: 'lock-reset' });
  assert.equal(r.response.status, 401);
});
