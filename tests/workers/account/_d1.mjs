/**
 * 账号库 D1 styrigx-account 的 node:sqlite 替身（D1_SETTINGS_SYNC / D1_WELLBEING 同一个库）。
 * 接口照 Cloudflare D1：prepare(sql).bind(...).first() / all() / run()，batch([...]) 整批一个事务（出错整批回滚）。
 * 每个异步方法先让出一次（await 微任务），Promise.all 发出的两个请求会交错执行，用来测并发。
 *
 * makeAccountD1({ migrations })：migrations 默认 true = 先跑 workers/account/migrations/*.sql；false = 空库（测 "no such table" 自愈）。
 * 观测：raw（DatabaseSync）、rows(table)、statements（执行过的 SQL 列表）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIG = new URL('../../../workers/account/migrations/', import.meta.url).pathname;

/** @param {any[]} p */
const norm = (p) => p.map((x) => (x === undefined ? null : typeof x === 'boolean' ? (x ? 1 : 0) : x));
const tick = () => new Promise((r) => setImmediate(r));

/** @param {{migrations?: boolean}} [opts] */
export function makeAccountD1(opts = {}) {
  const raw = new DatabaseSync(':memory:');
  if (opts.migrations !== false) {
    for (const f of readdirSync(MIG).filter((n) => n.endsWith('.sql')).sort()) raw.exec(readFileSync(MIG + f, 'utf8'));
  }
  /** @type {string[]} */
  const statements = [];
  const exec1 = (sql, params) => {
    statements.push(sql);
    const st = raw.prepare(sql);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) return { results: st.all(...params), meta: { changes: 0 } };
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
