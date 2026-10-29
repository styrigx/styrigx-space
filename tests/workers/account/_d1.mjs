/**
 * 账号库 D1 styrigx-account 的 node:sqlite 替身（D1_SETTINGS_SYNC / D1_WELLBEING 同一个库）。
 * 接口照 Cloudflare D1：prepare(sql).bind(...).first() / all() / run()（含 ... RETURNING），batch([...]) 整批一个事务（出错整批回滚）。
 * 每个异步方法先让出一次（await 微任务），Promise.all 发出的两个请求会交错执行，用来测并发。
 *
 * 2026-10-29 PR2：同一个库还有账号鉴权表（D1_ACCOUNT_AUTH，migrations/0003_account_auth.sql，AUTH_TABLES）。
 *
 * makeAccountD1({ migrations })：migrations 默认 true = 先跑 workers/account/migrations/*.sql（含 0003 的 auth 表）；false = 空库（测 "no such table" 自愈）；
 *   'data' = 只跑数据表（0001 / 0002，不建 auth 表）。
 * withAccountAuthD1(env, db?)：把同一个库挂成 D1_ACCOUNT_AUTH（和线上一样，三个绑定名同一个库）。
 * 观测：raw（DatabaseSync）、rows(table)、statements（执行过的 SQL 列表）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIG = new URL('../../../workers/account/migrations/', import.meta.url).pathname;

/** 账号鉴权表的迁移文件（PR2）和它建的九张表（方案第 9.1 节） */
export const AUTH_MIGRATION = '0003_account_auth.sql';
export const ACCOUNT_AUTH_SQL = readFileSync(MIG + AUTH_MIGRATION, 'utf8');
export const AUTH_TABLES = Object.freeze(['epoch', 'password', 'passkey', 'user_handle', 'challenge', 'attempt_limit', 'device', 'audit', 'data_migration']);

/** @param {any[]} p */
const norm = (p) => p.map((x) => (x === undefined ? null : typeof x === 'boolean' ? (x ? 1 : 0) : x));
const tick = () => new Promise((r) => setImmediate(r));

/** @param {{migrations?: boolean | 'data'}} [opts] */
export function makeAccountD1(opts = {}) {
  const raw = new DatabaseSync(':memory:');
  if (opts.migrations !== false) {
    for (const f of readdirSync(MIG).filter((n) => n.endsWith('.sql')).sort()) {
      if (opts.migrations === 'data' && f === AUTH_MIGRATION) continue;
      raw.exec(readFileSync(MIG + f, 'utf8'));
    }
  }
  /** @type {string[]} */
  const statements = [];
  const exec1 = (sql, params) => {
    statements.push(sql);
    const st = raw.prepare(sql);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) return { results: st.all(...params), meta: { changes: 0 } };
    /* 鉴权表要用的 UPDATE / DELETE / INSERT ... RETURNING（纪元推进、challenge 单次消费）：照 D1 返回行 */
    if (/\bRETURNING\b/i.test(sql)) { const rows = st.all(...params); return { results: rows, meta: { changes: rows.length } }; }
    const r = st.run(...params);
    return { results: [], meta: { changes: Number(r.changes) } };
  };
  const stmt = (sql, params = []) => ({
    sql, params,
    bind: (...p) => stmt(sql, norm(p)),
    async all() { await tick(); return exec1(sql, params); },
    async run() { await tick(); return exec1(sql, params); },
    async first(col) {
      await tick();
      const row = exec1(sql, params).results[0];
      if (!row) return null;
      return col ? row[col] : row;
    },
  });
  return {
    raw, statements,
    prepare: (sql) => stmt(sql),
    async batch(list) {
      await tick();
      raw.exec('BEGIN');
      try {
        const out = list.map((s) => exec1(s.sql, s.params));
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql) { await tick(); raw.exec(sql); return { count: 1 }; },
    /** @param {string} table */
    rows: (table) => raw.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all(),
  };
}

/**
 * 账号 Worker 的 env 加上 D1_ACCOUNT_AUTH（默认新建一个带全部迁移的库；给了 db 就用同一个，和 D1_SETTINGS_SYNC / D1_WELLBEING 共库）。
 * @param {Record<string, any>} env @param {ReturnType<typeof makeAccountD1>} [db]
 */
export function withAccountAuthD1(env = {}, db) {
  const d = db || env.D1_SETTINGS_SYNC || env.D1_WELLBEING || makeAccountD1();
  return { ...env, D1_ACCOUNT_AUTH: d };
}
