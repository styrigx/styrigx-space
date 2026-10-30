#!/usr/bin/env node
/**
 * @fileoverview 账号拆分（PR2 → PR4）：账号认证数据 D1 styrigx-auth-gateway → D1 styrigx-account，
 * 以及恢复开关表 recovery_switch → lock_reset_switch（同在网关库；网关代码只读写 lock_reset_switch）。方案见账号拆分最终方案第 9.3 / 9.4 节。
 * 生产上已按顺序执行完：apply → PR3 切流 → --lock-reset-switch（拷行）→ 部署改名后的网关代码 → --verify → --cleanup --confirm
 * （删网关库 realm='account' / 'root' 的行、DROP recovery_switch）。PR4 起网关库不再有账号数据和旧开关表；
 * 切换期专用的 --reconcile（切换窗口补齐、开关表双向合并）和 --reverse（回滚写回旧库）在 cleanup 之后没有旧边可合并 / 可写回，PR4 删除。
 *
 * 写法照 scripts/migrate-kv-to-d1.mjs：Cloudflare D1 REST（不依赖 wrangler 登录），凭据只从环境变量读；
 * 输出只有计数和主键，不打印任何值（密码记录、公钥、handle、IP 前缀以外的内容一律不出现）。
 *
 * 搬什么（「旧」= 网关库 G，「新」= 账号库 A；lock 两类和开关表的新旧都在 G）：
 *   account-epoch / account-password / account-passkey / account-device：G realm='account' → A，逐行原样
 *     （device 含已退出的行；passkey / device 另在 A.data_migration 记「拷过」的主键，见下）
 *   account-user-handle：G 账号 handle → A.handle；G 锁屏 handle → A.legacy_handle（账号登录继续认旧锁屏 handle）
 *   account-attempt-limit：G realm='account'（kind ≠ rootkey）→ A
 *   account-audit：G realm='account'（path 不是 root-reauth / root-reset）→ A（现在网关不写这种行，通常 0 条）
 *   root-attempt-limit-account：G realm='root' kind='rootkey' → A realm='account'
 *   root-audit-account：G realm='root' path account-reauth / account-reset → A realm='account' path root-reauth / root-reset
 *   root-attempt-limit-lock：G realm='root' kind='rootkey' → G realm='lock'（限速行两边各一份）
 *   root-audit-lock：G realm='root' path lock-reauth / lock-reset → G realm='lock'（path 不变）
 *   lock-reset-switch：G recovery_switch → G lock_reset_switch（同方案 9.4 lock_reset_switch 迁移的两条语句）
 * 不搬：challenge（切换那几分钟里正在进行的 Passkey 登录重试一次）；过期行（expires_at ≤ now）。
 *
 * 模式：
 *   --dry-run          只读：两边每类的行数、标记状态；不建表不写
 *   （默认）apply       A 建表（读 workers/account/migrations/0003_account_auth.sql，IF NOT EXISTS）；每类 INSERT OR IGNORE，
 *                      整类写完才写 A.data_migration 的类标记（中途失败 → 重跑补齐；有标记的类重跑跳过）
 *   --verify           按主键比较两边（行哈希 + 下面的规则）：新库每行都「至少和旧库一样新 / 一样安全」才算一致；
 *                      不一致逐条列出类名和主键，退出码 1。只读
 *   --lock-reset-switch 只搬开关表（方案 9.4 生产步骤 1，部署改名后的网关代码之前跑）：G 建 lock_reset_switch（SWITCH_CREATE），
 *                      INSERT OR IGNORE 拷 recovery_switch 的行（SWITCH_COPY），再按 9.4 合并规则把旧表里后来变化的 used / first_seen
 *                      推到新表（used 取大，first_seen 取非 0 中较小者；只写 lock_reset_switch，旧表不动），最后补上类标记。
 *                      与 apply 不同：类标记已在（PR2 / PR3 时 apply 过）也照样执行，可重复跑。不碰账号库的数据（只写 A.data_migration 标记）
 *   --cleanup --confirm 先跑一次 verify（不过就什么都不删），再删 G 里 realm='account' / 'root' 的行，DROP TABLE recovery_switch。
 *                      两边是同一个库时（预览）不删 realm='account'（那就是账号自己的行）
 *   --preview          库 id 读 web/wrangler.toml 和 workers/account/wrangler.toml 的 [env.preview]（测试库 styrigx-test-preview，两边同一个库）
 *
 * 「新库删掉的」和「没拷过的」怎么分（verify 用）：passkey / device 拷过的主键记在 A.data_migration（name = '<类名>:<主键>'）。
 *   旧库有、新库没有：记过 → 是新库后来删的，不算不一致；没记过 → 没拷过，算不一致。
 *
 * 用法：
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… node scripts/migrate-account-auth.mjs --dry-run
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… node scripts/migrate-account-auth.mjs
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… node scripts/migrate-account-auth.mjs --verify
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… node scripts/migrate-account-auth.mjs --lock-reset-switch
 *   … --cleanup --confirm；任一模式加 --preview
 * 选项：--gateway-d1 <id>（默认 workers/auth-gateway/wrangler.toml 的 D1_LOCK_AUTH = styrigx-auth-gateway）、
 *   --account-d1 <id>（默认 workers/account/wrangler.toml 的 D1_ACCOUNT_AUTH = styrigx-account；预览同名绑定在 [env.preview]）。
 *   CF_API_BASE 可指向 tests/web/e2e/preview-emulator.cjs 本地跑。
 * Token 权限：Account → D1: Edit（两个库都要；--dry-run / --verify 只发 SELECT）。
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const ACCOUNT_SCHEMA_FILE = 'workers/account/migrations/0003_account_auth.sql';

/** 方案 9.4 lock_reset_switch 迁移（workers/auth-gateway/migrations/0008_lock_reset_switch.sql；网关 0007 已被 legacy_handle 占用，顺延编号）的同一段 SQL：
 *  生产不跑 migrations apply，由本脚本执行（apply / --lock-reset-switch） */
export const SWITCH_CREATE = 'CREATE TABLE IF NOT EXISTS lock_reset_switch (hash TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)';
export const SWITCH_COPY = 'INSERT OR IGNORE INTO lock_reset_switch (hash, first_seen, used) SELECT hash, first_seen, used FROM recovery_switch';

/** 旧根域审计 path → 账号根密钥审计 path */
export const ROOT_PATH_TO_ACCOUNT = Object.freeze({ 'account-reauth': 'root-reauth', 'account-reset': 'root-reset' });
export const LOCK_ROOT_PATHS = Object.freeze(['lock-reauth', 'lock-reset']);
/** cleanup 在 G 里清 realm 行的表（tempkey 只有 lock 行） */
export const CLEANUP_TABLES = Object.freeze(['epoch', 'password', 'passkey', 'user_handle', 'challenge', 'attempt_limit', 'device', 'audit']);

/**
 * SQL 文件 → 语句（去掉 -- 注释，按 ; 分）。
 * @param {string} text
 */
export function splitSql(text) {
  return String(text).split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
    .split(';').map((s) => s.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim()).filter(Boolean);
}

/** @param {string} [repo] 仓库根（默认本脚本上一级） */
export function readAccountSchema(repo) {
  const root = repo || fileURLToPath(new URL('..', import.meta.url));
  return splitSql(readFileSync(root.replace(/\/?$/, '/') + ACCOUNT_SCHEMA_FILE, 'utf8'));
}

/* ---------- 类定义 ---------- */

const q = (s) => "'" + s + "'";
const inList = (xs) => '(' + xs.map(q).join(', ') + ')';
const ACCOUNT_ROOT_PATHS = Object.keys(ROOT_PATH_TO_ACCOUNT);
const NEW_ROOT_PATHS = Object.values(ROOT_PATH_TO_ACCOUNT);

const LIMIT_COLS = ['realm', 'kind', 'bucket', 'count', 'strikes', 'locked_until', 'window_start', 'expires_at'];
const LIMIT_MAX = ['count', 'strikes', 'locked_until', 'window_start', 'expires_at'];
const AUDIT_COLS = ['realm', 'id', 'ts', 'ip_prefix', 'ok', 'decoy', 'via', 'path', 'expires_at'];
const withRealm = (realm) => (r) => Object.assign({}, r, { realm });

/**
 * 一类数据：旧边（old）和新边（new）各在哪个库、哪些行；toNew 把旧边的一行换成新边的形状。
 * rule：合并规则（见 mergeRow）。expires：表有 expires_at（读源时跳过过期行）。baseline：记「拷过」的主键。
 * @typedef {{name: string, table: string, key: string[], cols: string[], rule: string, expires?: boolean, baseline?: boolean,
 *   max?: string[], old: {db: 'gateway'|'account', where: string, cols?: string[]}, new: {db: 'gateway'|'account', where: string, cols?: string[]},
 *   toNew: (r: any) => any}} Family
 */
/** @type {ReadonlyArray<Family>} */
export const FAMILIES = Object.freeze([
  { name: 'account-epoch', table: 'epoch', key: ['realm'], cols: ['realm', 'value'], rule: 'max', max: ['value'],
    old: { db: 'gateway', where: "realm = 'account'" }, new: { db: 'account', where: "realm = 'account'" }, toNew: (r) => r },
  { name: 'account-password', table: 'password', key: ['realm'], cols: ['realm', 'record'], rule: 'password',
    old: { db: 'gateway', where: "realm = 'account'" }, new: { db: 'account', where: "realm = 'account'" }, toNew: (r) => r },
  { name: 'account-passkey', table: 'passkey', key: ['realm', 'credential_id'], cols: ['realm', 'credential_id', 'record'], rule: 'passkey', baseline: true,
    old: { db: 'gateway', where: "realm = 'account'" }, new: { db: 'account', where: "realm = 'account'" }, toNew: (r) => r },
  { name: 'account-user-handle', table: 'user_handle', key: ['realm'], cols: ['realm', 'handle', 'legacy_handle'], rule: 'user-handle',
    old: { db: 'gateway', where: "realm = 'account'", cols: ['realm', 'handle'] }, new: { db: 'account', where: "realm = 'account'" },
    toNew: (r) => r },
  { name: 'account-device', table: 'device', key: ['realm', 'device_id'], cols: ['realm', 'device_id', 'record', 'last_seen', 'revoked_at', 'expires_at'],
    rule: 'max', max: ['last_seen', 'revoked_at', 'expires_at'], expires: true, baseline: true,
    old: { db: 'gateway', where: "realm = 'account'" }, new: { db: 'account', where: "realm = 'account'" }, toNew: (r) => r },
  { name: 'account-attempt-limit', table: 'attempt_limit', key: ['realm', 'kind', 'bucket'], cols: LIMIT_COLS, rule: 'max', max: LIMIT_MAX, expires: true,
    old: { db: 'gateway', where: "realm = 'account' AND kind <> 'rootkey'" }, new: { db: 'account', where: "realm = 'account' AND kind <> 'rootkey'" },
    toNew: (r) => r },
  { name: 'account-audit', table: 'audit', key: ['realm', 'id'], cols: AUDIT_COLS, rule: 'append', expires: true,
    old: { db: 'gateway', where: "realm = 'account' AND path NOT IN " + inList(NEW_ROOT_PATHS) },
    new: { db: 'account', where: "realm = 'account' AND path NOT IN " + inList(NEW_ROOT_PATHS) }, toNew: (r) => r },
  { name: 'root-attempt-limit-account', table: 'attempt_limit', key: ['realm', 'kind', 'bucket'], cols: LIMIT_COLS, rule: 'max', max: LIMIT_MAX, expires: true,
    old: { db: 'gateway', where: "realm = 'root' AND kind = 'rootkey'" }, new: { db: 'account', where: "realm = 'account' AND kind = 'rootkey'" },
    toNew: withRealm('account') },
  { name: 'root-audit-account', table: 'audit', key: ['realm', 'id'], cols: AUDIT_COLS, rule: 'append', expires: true,
    old: { db: 'gateway', where: "realm = 'root' AND path IN " + inList(ACCOUNT_ROOT_PATHS) },
    new: { db: 'account', where: "realm = 'account' AND path IN " + inList(NEW_ROOT_PATHS) },
    toNew: (r) => Object.assign({}, r, { realm: 'account', path: ROOT_PATH_TO_ACCOUNT[r.path] }) },
  { name: 'root-attempt-limit-lock', table: 'attempt_limit', key: ['realm', 'kind', 'bucket'], cols: LIMIT_COLS, rule: 'max', max: LIMIT_MAX, expires: true,
    old: { db: 'gateway', where: "realm = 'root' AND kind = 'rootkey'" }, new: { db: 'gateway', where: "realm = 'lock' AND kind = 'rootkey'" },
    toNew: withRealm('lock') },
  { name: 'root-audit-lock', table: 'audit', key: ['realm', 'id'], cols: AUDIT_COLS, rule: 'append', expires: true,
    old: { db: 'gateway', where: "realm = 'root' AND path IN " + inList(LOCK_ROOT_PATHS) },
    new: { db: 'gateway', where: "realm = 'lock' AND path IN " + inList(LOCK_ROOT_PATHS) }, toNew: withRealm('lock') },
]);
/** 开关表单独一类（两边都在 G，按 hash 双向合并） */
export const SWITCH_FAMILY = 'lock-reset-switch';
/** apply 写的全部类标记 */
export const MARKERS = Object.freeze([...FAMILIES.map((f) => f.name), SWITCH_FAMILY]);

/* ---------- 小工具 ---------- */

const keyOf = (fam, r) => JSON.stringify(fam.key.map((k) => r[k]));
const keyObj = (fam, r) => Object.fromEntries(fam.key.map((k) => [k, r[k]]));
const hashRow = (cols, r) => createHash('sha256').update(JSON.stringify(cols.map((c) => (r[c] === undefined ? null : r[c])))).digest('hex');
/** @param {any} s */
function parseJson(s) {
  try { const v = JSON.parse(String(s)); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
}
const num = (v) => Number(v) || 0;
const baselineName = (fam, r) => fam.name + ':' + r[fam.key[fam.key.length - 1]];

/**
 * @typedef {{d1: (sql: string, params?: any[]) => Promise<{results?: any[], meta?: {changes?: number}}>}} Api
 * @typedef {{gateway: Api, account: Api, sameDb?: boolean}} Apis
 */

function ctxOf(apis, now) {
  const tables = new Map();
  const ctx = {
    apis, now,
    /** @param {'gateway'|'account'} db */
    async hasTable(db, name) {
      const k = db + ':' + name;
      if (!tables.has(k)) {
        const r = await apis[db].d1("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]);
        tables.set(k, !!(r.results && r.results.length));
      }
      return tables.get(k);
    },
    forget() { tables.clear(); },
    /** @param {'gateway'|'account'} db @param {string} sql @param {any[]} [params] */
    async select(db, sql, params) {
      const r = await apis[db].d1(sql, params || []);
      return (r.results || []).map((x) => Object.assign({}, x));
    },
    /** @param {'gateway'|'account'} db */
    async write(db, sql, params) {
      const r = await apis[db].d1(sql, params || []);
      return num(r.meta && r.meta.changes);
    },
  };
  return ctx;
}

/** 已写的类标记 / 「拷过」的主键（A.data_migration；表不在 → 空） */
async function readMarks(ctx) {
  if (!(await ctx.hasTable('account', 'data_migration'))) return new Set();
  return new Set((await ctx.select('account', 'SELECT name FROM data_migration')).map((r) => String(r.name)));
}

/**
 * 读一边的行（表不在 → []）。src = true：作为拷贝的源，跳过过期行。
 * user_handle 的旧边额外带上锁屏 handle（→ legacy_handle）；新边的 legacy_handle 列不在时按 '' 读。
 * @param {any} ctx @param {Family} fam @param {'old'|'new'} side @param {boolean} src
 */
async function readSide(ctx, fam, side, src) {
  const s = fam[side];
  if (!(await ctx.hasTable(s.db, fam.table))) return [];
  if (fam.table === 'user_handle') {
    if (side === 'old') {
      const rows = await ctx.select(s.db, "SELECT realm, handle FROM user_handle WHERE realm IN ('account', 'lock')");
      const acct = rows.find((r) => r.realm === 'account');
      const lock = rows.find((r) => r.realm === 'lock');
      return acct ? [{ realm: 'account', handle: acct.handle, legacy_handle: lock ? lock.handle : '' }] : [];
    }
    try {
      return await ctx.select(s.db, 'SELECT realm, handle, legacy_handle FROM user_handle WHERE ' + s.where);
    } catch (e) {
      if (!/no such column/i.test(String(e && e.message))) throw e;
      return (await ctx.select(s.db, 'SELECT realm, handle FROM user_handle WHERE ' + s.where)).map((r) => Object.assign(r, { legacy_handle: '' }));
    }
  }
  const exp = src && fam.expires;
  return ctx.select(s.db, 'SELECT ' + fam.cols.join(', ') + ' FROM ' + fam.table + ' WHERE ' + s.where + (exp ? ' AND expires_at > ?' : '') + ' ORDER BY ' + fam.key.join(', '), exp ? [ctx.now] : []);
}

/**
 * 一行的合并：s = 源边的行（已换成目标边形状）或 null，d = 目标边的行或 null。返回要在目标边做的操作。
 * 规则都是「更安全的赢」：只把目标边往更新 / 更严的方向推，从不放宽。
 * @param {Family} fam @param {any} s @param {any} d @param {{marks: Set<string>, dstCols: string[]}} c
 * @returns {Array<{op: 'insert'|'update'|'delete'|'baseline'|'conflict', why: string, sql?: string, params?: any[], db?: string}>}
 */
export function mergeRow(fam, s, d, c) {
  const cols = c.dstCols;
  const where = fam.key.map((k) => k + ' = ?').join(' AND ');
  const kv = (r) => fam.key.map((k) => r[k]);
  const ops = [];
  const insert = (why) => ops.push({ op: 'insert', why, sql: 'INSERT OR IGNORE INTO ' + fam.table + ' (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')', params: cols.map((k) => (s[k] === undefined ? null : s[k])) });
  if (!s && !d) return ops;
  const r = s || d;
  const known = fam.baseline && c.marks.has(baselineName(fam, r));
  if (s && !d) {
    if (known) return ops; /* 拷过、目标边后来删了：删除赢，不补回 */
    insert('missing');
    if (fam.baseline) ops.push({ op: 'baseline', why: 'baseline', db: 'account', sql: 'INSERT OR IGNORE INTO data_migration (name, migrated_at) VALUES (?, ?)', params: [baselineName(fam, s), 0] });
    return ops;
  }
  if (!s && d) {
    /* 只在目标边：passkey 拷过的 = 源边删了 → 目标边也删；其余（新加的、源边过期 / 被清的）不动 */
    if (fam.rule === 'passkey' && known) ops.push({ op: 'delete', why: 'deleted-on-source', sql: 'DELETE FROM ' + fam.table + ' WHERE ' + where, params: kv(d) });
    return ops;
  }
  if (hashRow(cols, s) === hashRow(cols, d)) return ops;
  if (fam.rule === 'max') {
    const up = (fam.max || []).filter((f) => num(s[f]) > num(d[f]));
    if (up.length) ops.push({ op: 'update', why: up.join('+'), sql: 'UPDATE ' + fam.table + ' SET ' + up.map((f) => f + ' = MAX(' + f + ', ?)').join(', ') + ' WHERE ' + where, params: [...up.map((f) => num(s[f])), ...kv(d)] });
    return ops; /* 其余列（device.record 等）目标边的赢 */
  }
  if (fam.rule === 'password') {
    const sa = num((parseJson(s.record) || {}).updatedAt);
    const da = num((parseJson(d.record) || {}).updatedAt);
    if (sa > da) ops.push({ op: 'update', why: 'newer-updatedAt', sql: 'UPDATE password SET record = ? WHERE ' + where + ' AND record = ?', params: [s.record, ...kv(d), d.record] });
    else if (sa === da) ops.push({ op: 'conflict', why: 'same-updatedAt-different-record' });
    return ops;
  }
  if (fam.rule === 'passkey') {
    const sr = parseJson(s.record);
    const dr = parseJson(d.record);
    if (!sr || !dr) { ops.push({ op: 'conflict', why: 'bad-record' }); return ops; }
    if (num(sr.signCount) > num(dr.signCount)) {
      const next = JSON.stringify(Object.assign({}, dr, { signCount: num(sr.signCount) }));
      ops.push({ op: 'update', why: 'signCount', sql: 'UPDATE passkey SET record = ? WHERE ' + where + ' AND record = ?', params: [next, ...kv(d), d.record] });
    }
    return ops; /* 改名、lastUsedAt 等：目标边的赢 */
  }
  if (fam.rule === 'user-handle') {
    if (String(s.handle) !== String(d.handle)) { ops.push({ op: 'conflict', why: 'handle-differs' }); return ops; }
    if (cols.includes('legacy_handle') && s.legacy_handle && !d.legacy_handle) {
      ops.push({ op: 'update', why: 'legacy_handle', sql: "UPDATE user_handle SET legacy_handle = ? WHERE realm = ? AND legacy_handle = ''", params: [s.legacy_handle, d.realm] });
    }
    return ops;
  }
  /* append（审计只追加）：同主键内容不同 = 有人改过，列出不动 */
  ops.push({ op: 'conflict', why: 'row-differs' });
  return ops;
}

/**
 * 一类数据旧边 → 新边的差异（不执行；verify / cleanup 用）。
 * @param {any} ctx @param {Family} fam @param {Set<string>} marks
 */
async function diffFamily(ctx, fam, marks) {
  const src = (await readSide(ctx, fam, 'old', true)).map(fam.toNew);
  const dst = await readSide(ctx, fam, 'new', false);
  const dstCols = fam.new.cols || fam.cols;
  const S = new Map(src.map((r) => [keyOf(fam, r), r]));
  const D = new Map(dst.map((r) => [keyOf(fam, r), r]));
  const out = [];
  for (const k of [...new Set([...S.keys(), ...D.keys()])].sort()) {
    const s = S.get(k) || null;
    const d = D.get(k) || null;
    for (const op of mergeRow(fam, s, d, { marks, dstCols })) out.push(Object.assign({ db: fam.new.db, key: keyObj(fam, s || d) }, op));
  }
  return { ops: out, src: src.length, dst: dst.length };
}

/** 开关表：按 hash 把 G recovery_switch（old）合并进 G lock_reset_switch（new）——只算新表要补 / 要推严的行（旧表不写） */
async function diffSwitch(ctx) {
  const read = async (t) => ((await ctx.hasTable('gateway', t)) ? ctx.select('gateway', 'SELECT hash, first_seen, used FROM ' + t + ' ORDER BY hash') : []);
  const O = new Map((await read('recovery_switch')).map((r) => [String(r.hash), r]));
  const N = new Map((await read('lock_reset_switch')).map((r) => [String(r.hash), r]));
  const ops = [];
  for (const h of [...new Set([...O.keys(), ...N.keys()])].sort()) {
    const o = O.get(h);
    const n = N.get(h);
    const firsts = [o, n].filter(Boolean).map((r) => num(r.first_seen)).filter((x) => x > 0);
    const merged = { hash: h, used: Math.max(...[o, n].filter(Boolean).map((r) => num(r.used))), first_seen: firsts.length ? Math.min(...firsts) : 0 };
    for (const [table, row] of [['lock_reset_switch', n]]) {
      if (!row) {
        ops.push({ op: 'insert', why: 'missing', db: 'gateway', table, key: { hash: h }, sql: 'INSERT OR IGNORE INTO ' + table + ' (hash, first_seen, used) VALUES (?, ?, ?)', params: [h, merged.first_seen, merged.used] });
      } else if (num(row.used) !== merged.used || num(row.first_seen) !== merged.first_seen) {
        ops.push({
          op: 'update', why: 'used/first_seen', db: 'gateway', table, key: { hash: h },
          sql: 'UPDATE ' + table + ' SET used = MAX(used, ?), first_seen = CASE WHEN first_seen = 0 THEN ? WHEN ? = 0 THEN first_seen ELSE MIN(first_seen, ?) END WHERE hash = ?',
          params: [merged.used, merged.first_seen, merged.first_seen, merged.first_seen, h],
        });
      }
    }
  }
  return { ops, old: O.size, new: N.size };
}

/* ---------- 各模式 ---------- */

/**
 * @param {Apis} apis 两个库（gateway = styrigx-auth-gateway，account = styrigx-account；预览两个是同一个库，sameDb = true）
 * @param {{mode: 'dry-run'|'apply'|'lock-reset-switch'|'verify'|'cleanup', confirm?: boolean, now?: number,
 *   schema?: string[], log?: (s: string) => void}} o schema：A 的建表语句（默认读 0003 文件）
 * @returns {Promise<{ok: boolean, lines: string[], written: number, mismatches: string[], conflicts: string[]}>}
 */
export async function run(apis, o) {
  const lines = [];
  const log = (s) => { lines.push(s); if (o.log) o.log(s); };
  const now = o.now || Date.now();
  const ctx = ctxOf(apis, now);
  const res = { ok: true, lines, written: 0, mismatches: /** @type {string[]} */ ([]), conflicts: /** @type {string[]} */ ([]) };
  const fmt = (fam, op) => fam + ' ' + (op.table || '') + ' ' + JSON.stringify(op.key) + ' (' + op.why + ')';

  if (o.mode === 'dry-run') return dryRun(ctx, log, res);
  if (o.mode === 'apply') return apply(ctx, o.schema || readAccountSchema(), log, res);
  if (o.mode === 'lock-reset-switch') return copySwitch(ctx, log, res);

  const marks = await readMarks(ctx);
  const missing = MARKERS.filter((m) => !marks.has(m));

  if (o.mode === 'verify' || o.mode === 'cleanup') {
    if (o.mode === 'cleanup' && !o.confirm) throw new Error('--cleanup deletes data: add --confirm');
    for (const m of missing) res.mismatches.push(m + ' (marker missing: apply not finished)');
    for (const fam of FAMILIES) {
      const d = await diffFamily(ctx, fam, marks);
      for (const op of d.ops) {
        if (op.op === 'baseline') continue;
        (op.op === 'conflict' ? res.conflicts : res.mismatches).push(fmt(fam.name, Object.assign({ table: fam.table }, op)));
      }
      log(fam.name + ': ' + d.src + ' old / ' + d.dst + ' new row(s), ' + d.ops.filter((x) => x.op !== 'baseline').length + ' mismatch(es)');
    }
    const sw = await diffSwitch(ctx);
    for (const op of sw.ops) res.mismatches.push(fmt(SWITCH_FAMILY, op));
    log(SWITCH_FAMILY + ': ' + sw.old + ' recovery_switch / ' + sw.new + ' lock_reset_switch row(s), ' + sw.ops.length + ' mismatch(es)');
    const bad = res.mismatches.length + res.conflicts.length;
    log(bad ? 'verify FAILED: ' + bad + ' mismatch(es)' : 'verify OK');
    res.ok = bad === 0;
    if (o.mode === 'verify' || !res.ok) {
      if (o.mode === 'cleanup' && !res.ok) log('cleanup aborted: nothing deleted');
      return res;
    }
    return cleanup(ctx, log, res);
  }

  throw new Error('unknown mode: ' + o.mode);
}

async function dryRun(ctx, log, res) {
  const marks = await readMarks(ctx);
  for (const fam of FAMILIES) {
    const n = (await readSide(ctx, fam, 'old', true)).length;
    log(fam.name + ': ' + n + ' row(s) planned' + (marks.has(fam.name) ? ' (already migrated: will be skipped)' : ''));
  }
  const rs = (await ctx.hasTable('gateway', 'recovery_switch')) ? (await ctx.select('gateway', 'SELECT COUNT(*) AS n FROM recovery_switch'))[0].n : 0;
  log(SWITCH_FAMILY + ': ' + rs + ' recovery_switch row(s) planned' + (marks.has(SWITCH_FAMILY) ? ' (already migrated: will be skipped)' : ''));
  /* 不拷的：只报计数 */
  const count = async (table, where, params) => ((await ctx.hasTable('gateway', table)) ? num((await ctx.select('gateway', 'SELECT COUNT(*) AS n FROM ' + table + ' WHERE ' + where, params || []))[0].n) : 0);
  log('not copied: account challenge ' + await count('challenge', "realm = 'account' AND expires_at > ?", [ctx.now]) +
    ', root audit with other paths ' + await count('audit', "realm = 'root' AND path NOT IN " + inList([...ACCOUNT_ROOT_PATHS, ...LOCK_ROOT_PATHS]) + ' AND expires_at > ?', [ctx.now]) +
    ', expired rows skipped');
  log('lock user handle (→ legacy_handle): ' + await count('user_handle', "realm = 'lock'"));
  if (ctx.apis.sameDb) log('note: gateway and account are the same database');
  return res;
}

async function apply(ctx, schema, log, res) {
  for (const sql of schema) await ctx.write('account', sql);
  /* 预览两边同库：user_handle 由网关 0006 建好、0007 补上 legacy_handle 列；这里是防御（0007 之前的老库），列已存在就跳过 */
  try {
    await ctx.select('account', 'SELECT legacy_handle FROM user_handle LIMIT 0');
  } catch (e) {
    if (!/no such column/i.test(String(e && e.message))) throw e;
    await ctx.write('account', "ALTER TABLE user_handle ADD COLUMN legacy_handle TEXT NOT NULL DEFAULT ''");
    log('user_handle: added column legacy_handle');
  }
  ctx.forget();
  const marks = await readMarks(ctx);
  const mark = (name) => ctx.write('account', 'INSERT OR IGNORE INTO data_migration (name, migrated_at) VALUES (?, ?)', [name, ctx.now]);
  for (const fam of FAMILIES) {
    if (marks.has(fam.name)) { log(fam.name + ': already migrated, skipped'); continue; }
    const rows = (await readSide(ctx, fam, 'old', true)).map(fam.toNew);
    const db = fam.new.db;
    /* 账号库里的类：语句本身带「该类标记不存在」条件（同库原子）；网关库里的类：上面已查过标记 */
    const guard = db === 'account' ? ' WHERE NOT EXISTS (SELECT 1 FROM data_migration WHERE name = ?)' : '';
    let n = 0;
    for (const r of rows) {
      const vals = fam.cols.map((c) => (r[c] === undefined ? null : r[c]));
      const sql = fam.table === 'user_handle'
        /* 已有（预览同库）只补空的 legacy_handle，不动 handle */
        ? 'INSERT INTO user_handle (realm, handle, legacy_handle) SELECT ?, ?, ?' + guard + " ON CONFLICT (realm) DO UPDATE SET legacy_handle = excluded.legacy_handle WHERE user_handle.legacy_handle = '' AND excluded.legacy_handle <> ''"
        : 'INSERT OR IGNORE INTO ' + fam.table + ' (' + fam.cols.join(', ') + ') SELECT ' + fam.cols.map(() => '?').join(', ') + guard;
      n += await ctx.write(db, sql, guard ? [...vals, fam.name] : vals);
      if (fam.baseline) {
        await ctx.write('account', 'INSERT OR IGNORE INTO data_migration (name, migrated_at) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM ' + fam.table + ' WHERE ' +
          fam.key.map((k) => k + ' = ?').join(' AND ') + ')', [baselineName(fam, r), ctx.now, ...fam.key.map((k) => r[k])]);
      }
    }
    await mark(fam.name);
    res.written += n;
    log(fam.name + ': ' + n + ' of ' + rows.length + ' row(s) written');
  }
  if (marks.has(SWITCH_FAMILY)) {
    log(SWITCH_FAMILY + ': already migrated, skipped');
  } else {
    await ctx.write('gateway', SWITCH_CREATE);
    const n = (await ctx.hasTable('gateway', 'recovery_switch')) ? await ctx.write('gateway', SWITCH_COPY) : 0;
    await mark(SWITCH_FAMILY);
    res.written += n;
    log(SWITCH_FAMILY + ': ' + n + ' row(s) written');
  }
  return res;
}

/** --lock-reset-switch：开关表 G recovery_switch → G lock_reset_switch（方案 9.4 生产步骤 1；可重复跑） */
async function copySwitch(ctx, log, res) {
  await ctx.write('gateway', SWITCH_CREATE);
  ctx.forget();
  if (!(await ctx.hasTable('gateway', 'recovery_switch'))) {
    log(SWITCH_FAMILY + ': no recovery_switch table, nothing to copy');
    return res;
  }
  const copied = await ctx.write('gateway', SWITCH_COPY);
  const sw = await diffSwitch(ctx);
  let merged = 0;
  for (const op of sw.ops) merged += await ctx.write('gateway', op.sql, op.params);
  if (await ctx.hasTable('account', 'data_migration')) {
    await ctx.write('account', 'INSERT OR IGNORE INTO data_migration (name, migrated_at) VALUES (?, ?)', [SWITCH_FAMILY, ctx.now]);
  }
  res.written += copied + merged;
  log(SWITCH_FAMILY + ': ' + copied + ' row(s) copied, ' + merged + ' row(s) updated (' + sw.old + ' recovery_switch / ' + sw.new + ' lock_reset_switch)');
  return res;
}

async function cleanup(ctx, log, res) {
  const realms = ctx.apis.sameDb ? ['root'] : ['account', 'root'];
  if (ctx.apis.sameDb) log("note: same database: realm='account' rows are the account's own, not deleted");
  for (const t of CLEANUP_TABLES) {
    if (!(await ctx.hasTable('gateway', t))) continue;
    const n = await ctx.write('gateway', 'DELETE FROM ' + t + ' WHERE realm IN ' + inList(realms));
    res.written += n;
    log('cleanup ' + t + ': ' + n + ' row(s) deleted');
  }
  await ctx.write('gateway', 'DROP TABLE IF EXISTS recovery_switch');
  log('cleanup: dropped recovery_switch');
  return res;
}

/* ---------- Cloudflare REST ---------- */

/** @param {{base: string, token: string, account: string}} c @param {string} id @returns {Api} */
export function cfD1(c, id) {
  return {
    async d1(sql, params) {
      const r = await fetch(`${c.base}/accounts/${c.account}/d1/database/${id}/query`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: sql, params: params || [] }),
        signal: AbortSignal.timeout(30000),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.success) throw new Error('D1 query HTTP ' + r.status + ' ' + JSON.stringify((j && j.errors) || []) + ' (the token needs D1: Edit)');
      return (Array.isArray(j.result) ? j.result[0] : j.result) || {};
    },
  };
}

/**
 * wrangler.toml 里某 binding 的 database_id：preview = true 只看 [[env.preview.d1_databases]]，否则只看顶层 [[d1_databases]]。
 * @param {string} toml @param {string} binding @param {boolean} preview
 */
export function d1IdIn(toml, binding, preview) {
  const head = preview ? '[[env.preview.d1_databases]]' : '[[d1_databases]]';
  for (const block of String(toml).split(/\n(?=\[)/)) {
    if (!block.startsWith(head)) continue;
    const b = block.match(/^binding = "([A-Z0-9_]+)"/m);
    const id = block.match(/^database_id = "([0-9a-f-]+)"/m);
    if (b && id && b[1] === binding) return id[1];
  }
  return '';
}

/**
 * 两个库的 id。网关：D1_LOCK_AUTH（正式 workers/auth-gateway/wrangler.toml，预览 web/wrangler.toml）；
 * 账号：workers/account/wrangler.toml 的 D1_ACCOUNT_AUTH（正式和 [env.preview] 都有，PR2a 加的）。
 * @param {string} repo @param {{preview?: boolean, gatewayD1?: string, accountD1?: string}} o
 */
export function resolveDbIds(repo, o) {
  const read = (p) => readFileSync(repo.replace(/\/?$/, '/') + p, 'utf8');
  const pv = !!o.preview;
  const gw = o.gatewayD1 || d1IdIn(read(pv ? 'web/wrangler.toml' : 'workers/auth-gateway/wrangler.toml'), 'D1_LOCK_AUTH', pv);
  const ac = o.accountD1 || d1IdIn(read('workers/account/wrangler.toml'), 'D1_ACCOUNT_AUTH', pv);
  if (!gw) throw new Error('gateway D1 database id not found (D1_LOCK_AUTH)');
  if (!ac) throw new Error('account D1 database id not found (D1_ACCOUNT_AUTH)');
  return { gateway: gw, account: ac };
}

/** @param {string[]} argv */
export function modeOf(argv) {
  /* PR4 删掉的切换期模式：明确拒绝，不能落到默认的 apply */
  const removed = ['--reconcile', '--reverse'].filter((f) => argv.includes(f));
  if (removed.length) throw new Error(removed.join(' ') + ' removed in PR4 (gateway account rows and recovery_switch are gone after --cleanup)');
  const flags = ['--dry-run', '--lock-reset-switch', '--verify', '--cleanup'].filter((f) => argv.includes(f));
  if (flags.length > 1) throw new Error('pick one mode: ' + flags.join(' '));
  return flags.length ? /** @type {any} */ (flags[0].slice(2)) : 'apply';
}

/** @param {string[]} argv @param {string} name */
function opt(argv, name) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] || '' : '';
}

async function main(argv) {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const mode = modeOf(argv);
  if (mode === 'cleanup' && !argv.includes('--confirm')) throw new Error('--cleanup deletes data: add --confirm');
  const token = process.env.CF_API_TOKEN || '';
  const account = process.env.CF_ACCOUNT_ID || '';
  if (!token || !account) throw new Error('CF_API_TOKEN and CF_ACCOUNT_ID are required');
  const ids = resolveDbIds(repo, { preview: argv.includes('--preview'), gatewayD1: opt(argv, 'gateway-d1'), accountD1: opt(argv, 'account-d1') });
  const c = { base: (process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, ''), token, account };
  const sameDb = ids.gateway === ids.account;
  console.log(`${mode}: gateway D1 ${ids.gateway} → account D1 ${ids.account}${argv.includes('--preview') ? ' (preview)' : ''}${sameDb ? ' (same database)' : ''}`);
  const res = await run({ gateway: cfD1(c, ids.gateway), account: cfD1(c, ids.account), sameDb }, { mode, confirm: argv.includes('--confirm'), log: (s) => console.log('  ' + s) });
  for (const m of res.mismatches) console.error('  mismatch: ' + m);
  if (!res.ok) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => { console.error('error: ' + (e && e.message ? e.message : e)); process.exit(1); });
}
