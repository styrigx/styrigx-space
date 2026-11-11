/**
 * D1 绑定按域分（realms.js 头注释，2026-10-27 起网关认证状态全部在 D1，不再绑定 KV）。
 * 账号拆分 PR3：网关只剩锁屏域——realm='lock' 的行（和恢复开关表 lock_reset_switch）只经 D1_SPACE；
 * 网关一行都不碰 realm='account' / realm='root'（正式库里 PR4 已删光；测试库里故意留着，用来抓越界），D1_ACCOUNT_AUTH / D1_ROOT_AUTH 绑定已删。
 *
 * 线上只有一个库，读错 realm 也不会出错，所以单靠功能测试发现不了。这里把 D1_SPACE 换成「只认 realm='lock'」的视图：
 * 越界的语句照常执行（流程不被打断），但记下来，最后断言一条都没有。
 * env 里同时放上以前的 KV 绑定名和已删的 D1_ACCOUNT_AUTH / D1_ROOT_AUTH，换成碰一下就抛错的替身：运行时一次都不能碰。
 *
 * 跑的流程：v6 P4（定稿 v5.2 §十三）起进站签发、锁屏凭证接口全部删除，网关还读 realm='lock' 行的入口只剩
 * space-audit（旧进站凭证使用记录，只读；门是 v6 会话的 root 档）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v6Space } from '../_v6admit.mjs';
import { makeAuthD1, forbiddenKV } from '../_harness.mjs';

const API = '../../../workers/space-core/src/api/';

/** 有 realm 列的表（0005 / 0006）；lock_reset_switch、kv_migration 没有 realm 列 */
const REALM_TABLES = /\b(?:FROM|INTO|UPDATE|JOIN)\s+(epoch|passkey|password|user_handle|challenge|attempt_limit|tempkey|device|audit)\b/i;
const REALM_IDS = ['lock', 'account', 'root'];

/**
 * D1 替身上的视图（网关只有 D1_SPACE = 只认 realm='lock'），只认自己 realm 的行：
 * - 碰有 realm 列的表的语句，绑定参数里必须有自己的 realm id；
 * - 参数里出现别的 realm id（'lock' / 'account' / 'root' 原样）算越界；
 * - lock_reset_switch 只许经 D1_SPACE；旧表 recovery_switch 运行时谁都不许碰（方案 9.4 改名，PR4 已 DROP）；kv_migration 运行时谁都不许碰（只有导入脚本写）。
 * 越界的语句照常执行（流程不被打断），记进 violations，最后断言一条都没有。
 */
function splitD1() {
  const db = makeAuthD1();
  const violations = [];
  /** @type {Record<string, number>} 每个视图执行过的、碰 realm 表的语句数 */
  const used = { lock: 0, account: 0, root: 0 };
  const view = (name, mine) => {
    const check = (sql, args) => {
      if (/^\s*CREATE /i.test(sql)) return; /* 兜底建表 */
      if (/\bkv_migration\b/i.test(sql)) violations.push(name + ' touches kv_migration: ' + sql);
      if (/\brecovery_switch\b/i.test(sql)) violations.push(name + ' touches recovery_switch: ' + sql);
      if (/\block_reset_switch\b/i.test(sql) && mine !== 'lock') violations.push(name + ' touches lock_reset_switch: ' + sql);
      for (const a of args) {
        if (typeof a === 'string' && REALM_IDS.includes(a) && a !== mine) violations.push(name + ' binds ' + a + ': ' + sql);
      }
      if (REALM_TABLES.test(sql)) {
        used[mine]++;
        if (!args.includes(mine)) violations.push(name + ' realm table without realm=' + mine + ': ' + sql + ' ' + JSON.stringify(args));
      }
    };
    return {
      prepare(sql) {
        const st = db.prepare(sql);
        let bound = [];
        const exec = (k) => { check(sql, bound); return st._exec(k); };
        const wrapped = {
          bind(...args) { bound = args; st.bind(...args); return wrapped; },
          first: async () => exec('first'),
          all: async () => exec('all'),
          run: async () => exec('run'),
          _exec: exec,
          _sql: sql,
          _args: () => bound,
        };
        return wrapped;
      },
      batch: (stmts) => db.batch(stmts),
    };
  };
  return { db, violations, used, lock: view('D1_SPACE', 'lock') };
}

function get(path, cookie) {
  return new Request('https://styrigx.com' + path, { headers: { 'CF-Connecting-IP': '198.51.100.7', ...(cookie ? { Cookie: cookie } : {}) } });
}

test('网关只经 D1_SPACE 读 realm=lock 的行；已删的 D1_ACCOUNT_AUTH / D1_ROOT_AUTH 和 KV 一次都不碰：space-audit 跑一遍', async () => {
  const touched = [];
  const d1 = splitD1();
  const env = {
    /* 上线前的 KV 绑定名、账号拆分 PR3 删掉的两个 D1 绑定名：碰一下就抛错的替身 */
    KV_LOCK_DOOR: forbiddenKV('KV_LOCK_DOOR', touched), KV_ACCOUNT_LOGIN: forbiddenKV('KV_ACCOUNT_LOGIN', touched),
    D1_ACCOUNT_AUTH: forbiddenKV('D1_ACCOUNT_AUTH', touched), D1_ROOT_AUTH: forbiddenKV('D1_ROOT_AUTH', touched),
    D1_SPACE: d1.lock,
    SGX_ENV: 'production',
    /* space-audit 的门问账号 Worker（v6 会话的路由档）：账号侧只给个替身，D1 一行不碰 */
    ACCOUNT_VERIFIER: v6Space({}),
  };
  /* 库里遗留的行：锁屏审计一条（P4 之前写的）、账号域一条（拆分前写的，网关不该读到） */
  d1.db.raw.prepare("INSERT INTO audit (realm, id, ts, ip_prefix, ok, expires_at) VALUES ('lock', 'a1', 5, '198.51.100', 1, 9e15)").run();
  d1.db.raw.prepare("INSERT INTO audit (realm, id, ts, ip_prefix, ok, expires_at) VALUES ('account', 'a2', 6, '203.0.113', 0, 9e15)").run();
  const call = async (mod, method, req) => (await import(API + mod))[method]({ request: req, env, waitUntil() {} });

  let r = await call('space-audit.js', 'onRequestGet', get('/api/space-audit'));
  assert.equal(r.status, 401);
  r = await call('space-audit.js', 'onRequestGet', get('/api/space-audit', 'sgx-session=alice'));
  assert.equal(r.status, 403);
  r = await call('space-audit.js', 'onRequestGet', get('/api/space-audit', 'sgx-session=root'));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const body = await r.json();
  assert.equal(body.items.length, 1, '只读 realm=lock 的那一条');

  assert.ok(d1.used.lock > 0, JSON.stringify(d1.used));
  assert.deepEqual(d1.violations, []);
  assert.deepEqual(touched, [], '网关运行时碰了 KV 或已删的 D1 绑定');
});
