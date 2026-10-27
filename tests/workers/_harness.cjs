/**
 * 测试台公共件（唯一一份实现）：Worker 单测（经 tests/workers/_harness.mjs）和 e2e 的 CJS 测试台
 * （tests/web/e2e/edge-harness.cjs、cred-e2e-helpers.cjs）都从这里取，不再各写一遍。
 * 只放和被测代码无关的纯工具；要 import Worker 源码（ESM）的东西放 _harness.mjs。
 *
 * - derToPem(der, label)：DER → PEM（64 列折行，结尾带换行；Web Crypto importKey / 网关 pemToDer 都认）
 * - makeKV(seed?, opts?)：内存 KV，实现 handler 用到的 get / put / delete / list 子集，外加测试用的观测与故障注入
 * - makeAuthD1(opts?)：网关 D1（styrigx-auth-gateway）的 node:sqlite 替身，表结构就是 workers/auth-gateway/migrations/*.sql；
 *   可带一份「上线前的 KV」模拟部署前跑过 scripts/migrate-kv-to-d1.mjs
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

const AUTH_MIGRATIONS = path.join(__dirname, '..', '..', 'workers/auth-gateway/migrations');

/** 每张表属于导入计划的哪一类（scripts/migrate-kv-to-d1.mjs planAuthImport 的 family 名去掉 realm 前缀） */
const IMPORT_FAMILY_OF_TABLE = { epoch: 'epoch', password: 'password', passkey: 'passkey', user_handle: 'user-handle', device: 'device', tempkey: 'tempkey' };

/**
 * 网关 D1 替身（D1_LOCK_AUTH / D1_ACCOUNT_AUTH / D1_ROOT_AUTH 同一个库）：node:sqlite 内存库，
 * 实现 prepare().bind().first() / all() / run() 和 batch()（一个事务，任何一条失败整批回滚，同 D1）。
 * - opts.migrations === false：不跑迁移（模拟正式网关：表由 d1-state.js 遇到 no such table 时自建）
 * - opts.epochs：{ lock: 3, account: 1 }（也认 'lock-epoch' 这种旧名）直接写进 epoch 表
 * - opts.legacyKv：一份「上线前的 KV」（makeKV）。模拟「部署前跑过 scripts/migrate-kv-to-d1.mjs」：某张表第一次被网关读写之前，
 *   用导入脚本的同一个 planAuthImport 把这份 KV 里对应的那一类导进来（每类只导一次，同脚本的 kv_migration 标记）。
 *   只是测试替身：网关代码本身不读 KV（kv-binding-split.test.mjs 用碰一下就抛错的 KV 核对）。
 *   纪元：KV 里有才导（值 + 1）；没有就不写，网关按 0 起步（单测里大量按纪元 0 签票）。
 * 观测：raw（DatabaseSync）、epoch(realm)（没有这一行 → null）、rows(table)、passkey(realm, credId) / passkeys(realm) / password(realm)、
 *       calls（执行过的 SQL，按顺序）
 * 直接写（不走网关代码，用来摆测试前提）：setEpoch(realm, value)、putPasskey(realm, rec)、putPassword(realm, rec)、
 *   putChallenge(realm, cid, purpose, challenge, expiresAt?)
 * 故障：failOn = (sql) => boolean，返回 true 的语句抛错（batch 里任何一条命中 → 整批回滚）
 * @param {{migrations?: boolean, epochs?: Record<string, number>, legacyKv?: any}} [opts]
 */
function makeAuthD1(opts) {
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  const realmName = (n) => String(n).replace(/-epoch$/, '');
  if (!opts || opts.migrations !== false) {
    for (const f of fs.readdirSync(AUTH_MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
      raw.exec(fs.readFileSync(path.join(AUTH_MIGRATIONS, f), 'utf8'));
    }
  }
  for (const [name, value] of Object.entries((opts && opts.epochs) || {})) {
    raw.prepare('INSERT OR REPLACE INTO epoch (realm, value) VALUES (?, ?)').run(realmName(name), value);
  }
  const legacyKv = (opts && opts.legacyKv) || null;
  const imported = new Set();
  /** 这条语句要碰的表在导入计划里的那几类，还没导过的先导（同步执行计划语句；表还不存在就等网关自建后再导） */
  function importFor(sql) {
    if (!legacyKv) return;
    const tables = new Set();
    for (const m of String(sql).matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_]+)/gi)) tables.add(m[1].toLowerCase());
    const want = [...tables].map((t) => IMPORT_FAMILY_OF_TABLE[t]).filter((f) => f && !imported.has(f));
    if (!want.length) return;
    const { planAuthImport } = require('../../scripts/migrate-kv-to-d1.mjs');
    const kvMap = new Map();
    for (const [k, v] of (legacyKv._map instanceof Map ? legacyKv._map : new Map())) {
      if (v === null || v === undefined) continue;
      kvMap.set(k, { value: typeof v === 'string' ? v : JSON.stringify(v) });
    }
    const plan = planAuthImport(kvMap, Date.now(), { epochWhenMissing: false });
    for (const f of want) {
      const famTables = Object.keys(IMPORT_FAMILY_OF_TABLE).filter((t) => IMPORT_FAMILY_OF_TABLE[t] === f);
      const exists = famTables.every((t) => raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t))
        && raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv_migration'").get();
      if (!exists) continue; /* --no-migrations：表还没建，等网关建完下一条语句再导 */
      imported.add(f);
      for (const fam of plan.families.filter((x) => x.name.replace(/^(lock|account)-/, '') === f)) {
        for (const st of fam.statements) raw.prepare(st.sql).run(...st.params);
      }
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
        importFor(sql);
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
      for (const st of stmts) importFor(st._sql);
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
    /** @param {string} realm 'lock' | 'account'（也认 'lock-epoch'） */
    epoch(realm) {
      importFor('SELECT FROM epoch');
      const r = raw.prepare('SELECT value FROM epoch WHERE realm = ?').get(realmName(realm));
      return r ? Number(r.value) : null;
    },
    /** @param {string} table */
    rows(table) {
      importFor('SELECT FROM ' + table);
      return raw.prepare('SELECT * FROM ' + table).all().map((r) => Object.assign({}, r));
    },
    /** @param {string} realm @param {number} value 直接写纪元 */
    setEpoch(realm, value) {
      raw.prepare('INSERT OR REPLACE INTO epoch (realm, value) VALUES (?, ?)').run(realmName(realm), value);
    },
    /** @param {string} realm 'lock' | 'account' @param {string} credId @returns {any|null} */
    passkey(realm, credId) {
      importFor('SELECT FROM passkey');
      const r = raw.prepare('SELECT record FROM passkey WHERE realm = ? AND credential_id = ?').get(realm, credId);
      return r ? JSON.parse(r.record) : null;
    },
    /** @param {string} realm @returns {any[]} 按注册顺序 */
    passkeys(realm) {
      importFor('SELECT FROM passkey');
      return raw.prepare('SELECT record FROM passkey WHERE realm = ? ORDER BY rowid').all(realm).map((r) => JSON.parse(r.record));
    },
    /** @param {string} realm @param {any} rec 直接写一把（字段按存储格式，必须带 credId） */
    putPasskey(realm, rec) {
      importFor('INSERT INTO passkey');
      raw.prepare('INSERT OR REPLACE INTO passkey (realm, credential_id, record) VALUES (?, ?, ?)').run(realm, rec.credId, JSON.stringify(rec));
    },
    /**
     * 直接写一个一次性 challenge（摆测试前提；网关签发用 passkey-verify.js issueChallenge）
     * @param {string} realm @param {string} id cid @param {string} purpose @param {string} challenge @param {number} [expiresAt] 毫秒，默认 5 分钟后
     */
    putChallenge(realm, id, purpose, challenge, expiresAt) {
      raw.prepare('INSERT OR REPLACE INTO challenge (realm, id, purpose, challenge, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(realm, id, purpose, challenge, expiresAt || Date.now() + 300000);
    },
    /** @param {string} realm @returns {any|null} */
    password(realm) {
      importFor('SELECT FROM password');
      const r = raw.prepare('SELECT record FROM password WHERE realm = ?').get(realm);
      return r ? JSON.parse(r.record) : null;
    },
    /** @param {string} realm @param {any} rec makePasswordRecord 的结果 */
    putPassword(realm, rec) {
      importFor('INSERT INTO password');
      raw.prepare('INSERT OR REPLACE INTO password (realm, record) VALUES (?, ?)').run(realm, JSON.stringify(rec));
    },
  };
  return db;
}

module.exports = { derToPem, makeKV, makeAuthD1 };
