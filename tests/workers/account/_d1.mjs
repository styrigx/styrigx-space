/**
 * 账号库 D1 styrigx-account 的 node:sqlite 替身（一个绑定 D1_ACCOUNT：account_* 表 + settings_sync + wb_daily）。
 * 接口照 Cloudflare D1：prepare(sql).bind(...).first() / all() / run()（含 ... RETURNING），batch([...]) 整批一个事务（出错整批回滚）。
 * 每个异步方法先让出一次（await 微任务），Promise.all 发出的两个请求会交错执行，用来测并发。
 *
 *
 * makeAccountD1({ migrations })：migrations 默认 true = 按文件名顺序跑 workers/account/migrations/*.sql（0003 / 0004 的旧表，
 *   再经 0005_account_tables.sql 换成 account_*；空库上 0005 会把全部应用写成已授权，同线上首次切换）；
 *   false = 空库（测没有 "no such table" 自愈：直接报错）；'data' = 只跑数据表（0001 / 0002）；
 *   'pre-uid' = 跑到 0006 为止（不跑 0007_v6_uid_columns.sql：数据表还没 uid 列，测迁移前的表结构）。
 * withAccountD1(env, db?)：给 env 挂上 D1_ACCOUNT。
 * 观测：raw（DatabaseSync）、rows(table)、statements（执行过的 SQL 列表）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIG = new URL('../../../workers/account/migrations/', import.meta.url).pathname;

/** 只建数据表的迁移（'data' 模式只跑这两个） */
export const DATA_MIGRATIONS = Object.freeze(['0001_wellbeing.sql', '0002_settings_sync.sql']);
/** 命名 v2 的账号表迁移和它建的表 */
export const ACCOUNT_MIGRATION = '0005_account_tables.sql';
export const ACCOUNT_SQL = readFileSync(MIG + ACCOUNT_MIGRATION, 'utf8');
export const ACCOUNT_TABLES = Object.freeze(['account_epoch', 'account_password', 'account_passkey', 'account_user_handle', 'account_challenge',
  'account_attempt_limit', 'account_device', 'account_audit', 'account_grant']);
/** v6 身份表（P1，0006_identity.sql） */
export const IDENTITY_MIGRATION = '0006_identity.sql';
export const IDENTITY_SQL = readFileSync(MIG + IDENTITY_MIGRATION, 'utf8');
export const IDENTITY_TABLES = Object.freeze(['account_users', 'account_user_groups', 'account_user_password', 'account_user_passkey',
  'account_sessions', 'account_session_stack', 'account_user_audit', 'account_recovery_key']);
/** v6 P2 数据表加 uid 的迁移（2026-11-11 Gray 批准） */
export const UID_MIGRATION = '0007_v6_uid_columns.sql';
/** 所有迁移文件（按文件名顺序） */
export const MIGRATION_FILES = Object.freeze(readdirSync(MIG).filter((n) => n.endsWith('.sql')).sort());
/** 读某个迁移文件 @param {string} f */
export const migrationSql = (f) => readFileSync(MIG + f, 'utf8');

/** @param {any[]} p */
const norm = (p) => p.map((x) => (x === undefined ? null : typeof x === 'boolean' ? (x ? 1 : 0) : x));
const tick = () => new Promise((r) => setImmediate(r));

/** @param {{migrations?: boolean | 'data' | 'pre-uid'}} [opts] */
export function makeAccountD1(opts = {}) {
  const raw = new DatabaseSync(':memory:');
  if (opts.migrations !== false) {
    for (const f of MIGRATION_FILES) {
      if (opts.migrations === 'data' && DATA_MIGRATIONS.indexOf(f) === -1) continue;
      if (opts.migrations === 'pre-uid' && f >= UID_MIGRATION) continue;
      raw.exec(migrationSql(f));
    }
  }
  /** @type {string[]} */
  const statements = [];
  const exec1 = (sql, params) => {
    statements.push(sql);
    const st = raw.prepare(sql);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) return { results: st.all(...params), meta: { changes: 0 } };
    /* UPDATE / DELETE / INSERT ... RETURNING（纪元推进、challenge 单次消费）：照 D1 返回行 */
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
 * 给 env 挂上 D1_ACCOUNT（默认新建一个带全部迁移的库；给了 db 就用它）。
 * @param {Record<string, any>} env @param {ReturnType<typeof makeAccountD1>} [db]
 */
export function withAccountD1(env = {}, db) {
  return { ...env, D1_ACCOUNT: db || env.D1_ACCOUNT || makeAccountD1() };
}

/**
 * 同一个绑定拆两半：SQL 命中 re 的语句交给 side（测某张表出错 / 缺表 / 记写入），其余交给 main（账号表照常，session 验得过）。
 * batch 里全部命中才交给 side。
 * @param {any} main @param {any} side @param {RegExp} re
 */
export function splitD1(main, side, re) {
  const mine = new WeakSet();
  /** side 发出的语句（含 bind 之后的）都记下来，batch 时据此分流 @param {any} st */
  const track = (st) => {
    if (st && typeof st === 'object') {
      mine.add(st);
      if (typeof st.bind === 'function') {
        const b = st.bind.bind(st);
        st.bind = (...p) => track(b(...p));
      }
    }
    return st;
  };
  return {
    raw: main.raw, statements: main.statements, rows: main.rows,
    prepare: (sql) => (re.test(sql) ? track(side.prepare(sql)) : main.prepare(sql)),
    batch: (list) => (list.length && list.every((s) => mine.has(s)) ? side.batch(list) : main.batch(list)),
  };
}
