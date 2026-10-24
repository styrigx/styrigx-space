/**
 * 测试用 D1（分享短链 Worker styrigx-share 的 D1_SHARE_LINK）。
 * - 有 node:sqlite（Node 22+）：真 SQL，表结构就是 workers/share/migrations/*.sql，语句就是 lib/links.js 的 SQL
 * - 没有（CI 的 Node 20）：内存替身，只认 lib/links.js SQL 里的那几条语句（认不出的语句直接抛错，不会悄悄放过）
 * 两种都暴露 rows()（share_link 全部行）和 fails()（share_fail 全部行）给断言用。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQL } from '../../workers/share/src/lib/links.js';

const MIG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'workers/share/migrations');
let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch (e) {}

export const HAS_SQLITE = !!sqlite;

/** @param {{memory?:boolean}} [opts] memory:true 强制用内存替身 */
export function shareD1(opts) {
  if (sqlite && !(opts && opts.memory)) return sqliteD1();
  return memoryD1();
}

function sqliteD1() {
  const db = new sqlite.DatabaseSync(':memory:');
  for (const f of readdirSync(MIG).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(MIG, f), 'utf8'));
  const stmt = (sql, args) => ({
    bind: (...a) => stmt(sql, a),
    async first() { return db.prepare(sql).get(...(args || [])) || null; },
    async all() { return { results: db.prepare(sql).all(...(args || [])) }; },
    async run() { const r = db.prepare(sql).run(...(args || [])); return { meta: { changes: Number(r.changes) } }; },
  });
  return {
    kind: 'sqlite',
    prepare: (sql) => stmt(sql, []),
    rows: () => db.prepare('SELECT * FROM share_link').all().map((r) => ({ ...r })),
    fails: () => db.prepare('SELECT * FROM share_fail').all().map((r) => ({ ...r })),
    raw: db,
  };
}

function memoryD1() {
  /** @type {Map<string, any>} */
  const links = new Map();
  /** @type {Map<string, any>} */
  const fail = new Map();
  const exec = {
    [SQL.byCode]: { first: ([c]) => [...links.values()].find((r) => r.code === c) || null },
    [SQL.byId]: { first: ([id]) => links.get(id) || null },
    [SQL.list]: { all: () => [...links.values()].sort((a, b) => b.created_at - a.created_at) },
    [SQL.countActive]: { first: ([now]) => ({ n: [...links.values()].filter((r) => r.revoked_at == null && r.expires_at > now).length }) },
    [SQL.insert]: {
      run: ([id, code, name, target, session, key, created, expires]) => {
        if (links.has(id) || [...links.values()].some((r) => r.code === code)) throw new Error('UNIQUE constraint failed');
        links.set(id, { id, code, name, target, session_sec: session, key_id: key, created_at: created, expires_at: expires, revoked_at: null, opens: 0, last_open_at: null });
        return 1;
      },
    },
    [SQL.revoke]: { run: ([id, at]) => { const r = links.get(id); if (r && r.revoked_at == null) { r.revoked_at = at; return 1; } return 0; } },
    [SQL.opened]: { run: ([id, at]) => { const r = links.get(id); if (r) { r.opens++; r.last_open_at = at; return 1; } return 0; } },
    [SQL.purge]: {
      run: ([t]) => {
        let n = 0;
        for (const [k, r] of links) if (r.expires_at < t || (r.revoked_at != null && r.revoked_at < t)) { links.delete(k); n++; }
        return n;
      },
    },
    [SQL.failGet]: { first: ([ip]) => { const r = fail.get(ip); return r ? { count: r.count, window_start: r.window_start, locked_until: r.locked_until } : null; } },
    [SQL.failPut]: { run: ([ip, count, ws, lu]) => { fail.set(ip, { ip, count, window_start: ws, locked_until: lu }); return 1; } },
    [SQL.failPurge]: { run: ([t]) => { let n = 0; for (const [k, r] of fail) if (r.window_start < t && r.locked_until < t) { fail.delete(k); n++; } return n; } },
  };
  const stmt = (sql, args) => {
    const e = exec[sql];
    if (!e) throw new Error('share-d1 memory: unknown SQL: ' + sql);
    return {
      bind: (...a) => stmt(sql, a),
      async first() { if (!e.first) throw new Error('not a first() query'); return e.first(args || []); },
      async all() { if (!e.all) throw new Error('not an all() query'); return { results: e.all(args || []) }; },
      async run() { if (!e.run) throw new Error('not a run() query'); return { meta: { changes: e.run(args || []) } }; },
    };
  };
  return {
    kind: 'memory',
    prepare: (sql) => stmt(sql, []),
    rows: () => [...links.values()].map((r) => ({ ...r })),
    fails: () => [...fail.values()].map((r) => ({ ...r })),
    _links: links,
  };
}
