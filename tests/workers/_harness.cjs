/**
 * 测试台公共件（唯一一份实现）：Worker 单测（经 tests/workers/_harness.mjs）和 e2e 的 CJS 测试台
 * （tests/space/e2e/helpers/edge-harness.cjs、cred-e2e-helpers.cjs）都从这里取，不再各写一遍。
 * 只放和被测代码无关的纯工具；要 import Worker 源码（ESM）的东西放 _harness.mjs。
 *
 * - derToPem(der, label)：DER → PEM（64 列折行，结尾带换行；Web Crypto importKey / 网关 pemToDer 都认）
 * - makeKV(seed?, opts?)：内存 KV，实现 handler 用到的 get / put / delete / list 子集，外加测试用的观测与故障注入
 * - makeAuthD1(opts?)：站点核心 D1（D1_SPACE；正式库 styrigx-space-core）的 node:sqlite 替身，表结构就是 workers/space-core/migrations/*.sql
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {ArrayBuffer|Uint8Array} der
 * @param {string} label 'PRIVATE KEY' | 'PUBLIC KEY'
 */
function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}

/**
 * 内存 KV（Cloudflare KV 的 get / put / delete / list 子集）。
 * - seed：初始键值，原样放进 Map（不转换）
 * - get(k, 'json') 解析 JSON；不存在（或存的是 null / undefined）回 null
 * - put 存字符串：非字符串值 JSON.stringify（真 KV 只收字符串；数字结果与 String() 相同）；
 *   第三参数整个记在 _opts，其中 expirationTtl 另记在 _ttl
 * - list({prefix}) 按前缀过滤、跳过 listHides 里的键，list_complete: true
 *
 * 观测：_map（同一个 Map，另有别名 m / store / _store，照顾各文件原来的叫法）、_reads（get 过的键，按顺序）、
 *       puts（put 过的键）、_opts / _ttl、_calls（get / put / delete / list 次数）
 * 故障：kv._fail = true → get / put 抛错（delete / list 不受影响）；
 *       failGet(k) 回 true → 这次 get 抛错（opts.throwOn 是它的初值）；listHides：list 不列出的键
 *
 * @param {Record<string, any>} [seed]
 * @param {{throwOn?: ((k: string) => boolean) | null}} [opts]
 */
function makeKV(seed, opts) {
  const m = new Map(Object.entries(seed || {}));
  const throwOn = (opts && opts.throwOn) || null;
  const kv = {
    _map: m,
    m,
    store: m,
    _store: m,
    _fail: false,
    /** @type {(k: string) => boolean} */
    failGet: throwOn || (() => false),
    listHides: new Set(),
    /** @type {string[]} */
    _reads: [],
    /** @type {string[]} */
    puts: [],
    _ttl: new Map(),
    _opts: new Map(),
    _calls: { get: 0, put: 0, delete: 0, list: 0 },
    /** @param {string} k @param {string} [type] */
    async get(k, type) {
      kv._calls.get++;
      kv._reads.push(k);
      if (kv._fail || kv.failGet(k)) throw new Error('kv-fail ' + k);
      const v = m.has(k) ? m.get(k) : null;
      if (v === null || v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    /** @param {string} k @param {any} v @param {{expirationTtl?: number}} [o] */
    async put(k, v, o) {
      kv._calls.put++;
      if (kv._fail) throw new Error('kv-fail ' + k);
      kv.puts.push(k);
      m.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      kv._ttl.set(k, o && o.expirationTtl);
      kv._opts.set(k, o || null);
    },
    /** @param {string} k */
    async delete(k) {
      kv._calls.delete++;
      m.delete(k);
    },
    /** @param {{prefix?: string}} [o] */
    async list(o) {
      kv._calls.list++;
      const prefix = (o && o.prefix) || '';
      const keys = [...m.keys()].filter((n) => n.startsWith(prefix) && !kv.listHides.has(n)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
  return kv;
}

const AUTH_MIGRATIONS = path.join(__dirname, '..', '..', 'workers/space-core/migrations');

/**
 * 网关 D1 替身（D1_SPACE / D1_ACCOUNT_AUTH / D1_ROOT_AUTH 同一个库）：node:sqlite 内存库，
 * 实现 prepare().bind().first() / all() / run() 和 batch()（一个事务，任何一条失败整批回滚，同 D1）。
 * - opts.migrations === false：不跑迁移（模拟正式网关：表由 d1-state.js 遇到 no such table 时自建）
 * v6 P4 收尾（定稿 v5.4 §十一）：旧进站表的直写 / 观测（纪元、通行密钥、密码、challenge）与「上线前的 KV」导入
 * （一次性脚本 migrate-kv-to-d1.mjs，Gray 11-11 20:11 删）一并删除。
 * 观测：raw（DatabaseSync）、rows(table)、calls（执行过的 SQL，按顺序）
 * 故障：failOn = (sql) => boolean，返回 true 的语句抛错（batch 里任何一条命中 → 整批回滚）
 * @param {{migrations?: boolean}} [opts]
 */
function makeAuthD1(opts) {
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  if (!opts || opts.migrations !== false) {
    for (const f of fs.readdirSync(AUTH_MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
      raw.exec(fs.readFileSync(path.join(AUTH_MIGRATIONS, f), 'utf8'));
    }
  }
  const db = {
    raw,
    /** @type {string[]} */
    calls: [],
    /** @type {(sql: string) => boolean} */
    failOn: () => false,
    /** @param {string} sql */
    prepare(sql) {
      let args = [];
      const exec = (kind) => {
        db.calls.push(sql);
        if (db.failOn(sql)) throw new Error('d1-fail ' + sql);
        const st = raw.prepare(sql);
        if (kind === 'first') { const r = st.get(...args); return r === undefined ? null : Object.assign({}, r); }
        if (kind === 'all') return { success: true, results: st.all(...args).map((r) => Object.assign({}, r)) };
        const r = st.run(...args);
        return { success: true, meta: { changes: Number(r.changes || 0) } };
      };
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async first() { return exec('first'); },
        async all() { return exec('all'); },
        async run() { return exec('run'); },
        _exec: exec,
        _sql: sql,
        _args: () => args,
      };
      return stmt;
    },
    /** @param {any[]} stmts */
    async batch(stmts) {
      raw.exec('BEGIN');
      try {
        const out = stmts.map((st) => st._exec('run'));
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
    /** @param {string} table */
    rows(table) {
      return raw.prepare('SELECT * FROM ' + table).all().map((r) => Object.assign({}, r));
    },
  };
  return db;
}

module.exports = { derToPem, makeKV, makeAuthD1 };
