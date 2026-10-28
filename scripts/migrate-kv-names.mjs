#!/usr/bin/env node
/**
 * 一次性迁移：认证库 KV（KV_LOCK_DOOR / KV_ACCOUNT_LOGIN，同一个 namespace）的键名改成第 5 层的新名字。
 * 新键名表见 workers/auth-gateway/functions/_kernel/realms.js；说明见 workers/auth-gateway/README.md「KV 键名迁移」。
 *
 * 用 Cloudflare REST API（不依赖 wrangler 登录），凭据只从环境变量读，不写进仓库：
 *   CF_API_TOKEN     有该 namespace「Workers KV Storage: Edit」权限的 API Token
 *   CF_ACCOUNT_ID    Cloudflare 账户 id
 *   SGX_KV_NAMESPACE_ID  （可选）namespace id；不给就用认证库 KV b796097c90104000992b7713f61e16ea
 *                        （2026-10-27 起网关不再绑定 KV_LOCK_DOOR，id 不再从 wrangler.toml 读；之后的 KV → D1 导入见 scripts/migrate-kv-to-d1.mjs；
 *                        这个 namespace 2026-10-29 已删除，本脚本只剩历史意义）
 *
 * 用法（按顺序；每一步都会先把整个 namespace 备份到本地 JSON）：
 *   node scripts/migrate-kv-names.mjs                 dry-run（默认）：备份 + 打印计划，不写
 *   node scripts/migrate-kv-names.mjs --apply         备份 + 写新键（带原过期时间）+ 逐键校验；已存在的新键一律不覆盖
 *   node scripts/migrate-kv-names.mjs --verify        只校验：新键的值是否与旧键一致
 *   node scripts/migrate-kv-names.mjs --delete-old    先确认新键都在，才删旧键（含 owner-passkeys、class=app 记录、
 *                                                     lock-temp:* / lock-temp-code:* / lock-temp-revoked:*）
 *   --backup-dir <目录>  备份放哪（默认 ~/.sgx-kv-backups；不许放在仓库里）
 *
 * 备份是整个 namespace 的明文（密码哈希、通行密钥公钥、user handle），文件权限 0600、目录 0700，
 * 目录落在仓库内直接拒绝（仓库是公开的）。迁移收尾后自己删掉。
 *
 * 规则：
 * - 新键写入时带旧键的绝对过期时间（剩余 TTL 不变）；已过期或 60 秒内过期的跳过（KV 要求过期时间至少 60 秒后）。
 * - owner-passkey:<id> 按记录的 class 分流：owner → account-passkey:<id>，lock / 无 class → lock-passkey:<id>，
 *   app（应用凭证，已删除）→ 不迁移；新记录去掉 class 字段，其余字段、credId、公钥、signCount 原样；
 *   owner-passkey-index 拆成 lock-passkey-index / account-passkey-index（保持原顺序，只留记录还在的 credId）。
 * - account-dev:<id> 的记录字段 sid 改名 deviceId（值不变）。
 * - 临时钥匙 lock-temp:*、lock-temp-code:*、lock-temp-revoked:* 不迁移（码哈希的域串也改了，旧码一律作废），
 *   PR 3 部署后重新签发全部临时钥匙；--delete-old 删掉它们。
 * - 密码哈希、WebAuthn user handle、credId 原样不变。账号设置 account-prefs、account-epoch 键名不变，不动。
 * - 不认识的键只报告，不改不删。
 * - --apply 只写目标键还不存在的；已存在的跳过并报告（重跑、或部署后误跑都不会用旧值覆盖新代码写的纪元/计数）。
 *
 * 合并 PR 3、迁移完成后，本脚本可在后续 PR 删除。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 一对一改名（精确键） */
export const RENAME_EXACT = Object.freeze({
  'lock-pw': 'lock-password',
  'owner-pw': 'account-password',
  'owner-user-id': 'lock-user-id',
  'owner-user-id:owner': 'account-user-id',
  'session-epoch': 'lock-epoch',
  'layer:lock': 'lock-configured',
  'layer:owner': 'account-configured',
  'recovery-switch': 'lock-reset-switch',
  'lock-temp-global': 'lock-tempkey-fail-global',
  'root-auth-global': 'root-fail-global',
});
/* 前缀改名（<旧前缀><编号> → <新前缀><编号>） */
export const RENAME_PREFIX = Object.freeze([
  ['pk-challenge:', 'lock-passkey-challenge:'],
  ['lockreset-challenge:', 'lock-reset-challenge:'],
  ['pw-fail:', 'lock-password-fail:'],
  ['pw-lock:', 'lock-password-cooldown:'],
  ['lock-temp-fail:', 'lock-tempkey-fail:'],
  ['account-challenge:', 'account-passkey-challenge:'],
  ['account-revoked:', 'account-device-revoked:'],
  ['root-auth-fail:', 'root-fail:'],
  ['root-auth-audit:', 'root-audit:'],
]);
/* 需要改写值的 */
export const PASSKEY_OLD_PREFIX = 'owner-passkey:';
export const PASSKEY_OLD_INDEX = 'owner-passkey-index';
export const DEVICE_OLD_PREFIX = 'account-dev:';
/* 不迁移、--delete-old 时删除的 */
export const DROP_EXACT = Object.freeze(['owner-passkeys']);
export const DROP_PREFIX = Object.freeze(['lock-temp:', 'lock-temp-code:', 'lock-temp-revoked:']);
/* 新名字（已迁移过的、或本来就不改的键：不报告为未知） */
const KNOWN_NEW_PREFIX = ['lock-', 'account-', 'root-'];

/**
 * @typedef {{name:string, value:string, expiration?:number, metadata?:any}} KvEntry  value 为 UTF-8 文本
 * @typedef {{key:string, value:string, expiration?:number, metadata?:any, from:string, kind:string}} Write
 */

/** @param {string} name */
function isOldPasskeyRecord(name) {
  return name.startsWith(PASSKEY_OLD_PREFIX);
}

/**
 * 纯函数：按全部现有键算出迁移计划（不访问网络，单测直接调）。
 * @param {KvEntry[]} entries
 * @param {number} [nowSec] 当前时间（秒）
 * @returns {{writes: Write[], deleteOld: string[], skipped: {key:string, reason:string}[], unknown: string[]}}
 */
export function planMigration(entries, nowSec) {
  const now = nowSec || Math.floor(Date.now() / 1000);
  const byName = new Map(entries.map((e) => [e.name, e]));
  /** @type {Write[]} */ const writes = [];
  /** @type {string[]} */ const deleteOld = [];
  const skipped = [];
  const unknown = [];
  const expiringSoon = (e) => typeof e.expiration === 'number' && e.expiration > 0 && e.expiration < now + 60;
  const push = (e, key, value, kind) => {
    deleteOld.push(e.name);
    if (expiringSoon(e)) { skipped.push({ key: e.name, reason: 'expired' }); return; }
    /** @type {Write} */
    const w = { key, value, from: e.name, kind };
    if (e.expiration) w.expiration = e.expiration;
    if (e.metadata !== undefined && e.metadata !== null) w.metadata = e.metadata;
    writes.push(w);
  };

  /* 通行密钥：先把每条记录按 class 分好域 */
  /** @type {Map<string, 'lock'|'account'|null>} credId → 域（null = app，不迁移） */
  const passkeyDomain = new Map();
  for (const e of entries) {
    if (!isOldPasskeyRecord(e.name)) continue;
    let rec;
    try { rec = JSON.parse(e.value); } catch (err) { skipped.push({ key: e.name, reason: 'bad-json' }); deleteOld.push(e.name); continue; }
    const cls = rec && rec.class;
    const domain = cls === 'owner' ? 'account' : (!cls || cls === 'lock') ? 'lock' : null;
    if (rec && rec.credId) passkeyDomain.set(rec.credId, domain);
    if (!domain) { skipped.push({ key: e.name, reason: 'class=' + cls }); deleteOld.push(e.name); continue; }
    const out = Object.assign({}, rec);
    delete out.class;
    push(e, domain + '-passkey:' + e.name.slice(PASSKEY_OLD_PREFIX.length), JSON.stringify(out), 'passkey');
  }
  const idxEntry = byName.get(PASSKEY_OLD_INDEX);
  if (idxEntry) {
    let idx = [];
    try { idx = JSON.parse(idxEntry.value); } catch (err) { idx = []; }
    if (!Array.isArray(idx)) idx = [];
    const lockIdx = idx.filter((id) => passkeyDomain.get(id) === 'lock');
    const accountIdx = idx.filter((id) => passkeyDomain.get(id) === 'account');
    deleteOld.push(PASSKEY_OLD_INDEX);
    writes.push({ key: 'lock-passkey-index', value: JSON.stringify(lockIdx), from: PASSKEY_OLD_INDEX, kind: 'index' });
    writes.push({ key: 'account-passkey-index', value: JSON.stringify(accountIdx), from: PASSKEY_OLD_INDEX, kind: 'index' });
  }

  for (const e of entries) {
    const n = e.name;
    if (isOldPasskeyRecord(n) || n === PASSKEY_OLD_INDEX) continue;
    if (Object.prototype.hasOwnProperty.call(RENAME_EXACT, n)) { push(e, RENAME_EXACT[n], e.value, 'rename'); continue; }
    if (n.startsWith(DEVICE_OLD_PREFIX)) {
      let rec;
      try { rec = JSON.parse(e.value); } catch (err) { rec = null; }
      if (rec && typeof rec === 'object') {
        if ('sid' in rec) { rec.deviceId = rec.sid; delete rec.sid; }
        push(e, 'account-device:' + n.slice(DEVICE_OLD_PREFIX.length), JSON.stringify(rec), 'device');
      } else {
        skipped.push({ key: n, reason: 'bad-json' });
        deleteOld.push(n);
      }
      continue;
    }
    const pre = RENAME_PREFIX.find(([o]) => n.startsWith(o));
    if (pre) { push(e, pre[1] + n.slice(pre[0].length), e.value, 'rename'); continue; }
    if (DROP_EXACT.includes(n) || DROP_PREFIX.some((p) => n.startsWith(p))) {
      skipped.push({ key: n, reason: 'not-migrated' });
      deleteOld.push(n);
      continue;
    }
    if (KNOWN_NEW_PREFIX.some((p) => n.startsWith(p))) continue; /* 新名字 / 本来就不改的（account-epoch、account-prefs 等） */
    unknown.push(n);
  }
  return { writes, deleteOld, skipped, unknown };
}

/**
 * 纯函数：按目标键是否已存在把写入分两份。--apply 只写 toWrite，existing 一律不覆盖。
 * @param {Write[]} writes
 * @param {Set<string>} existingNames 当前 namespace 里已有的键名
 * @returns {{toWrite: Write[], existing: Write[]}}
 */
export function splitExisting(writes, existingNames) {
  const toWrite = [];
  const existing = [];
  for (const w of writes) (existingNames.has(w.key) ? existing : toWrite).push(w);
  return { toWrite, existing };
}

/**
 * 纯函数：备份目录。默认 ~/.sgx-kv-backups；落在仓库内（含仓库根）抛错。
 * @param {string[]} argv
 * @param {string} repo 仓库根（绝对路径）
 * @param {string} home
 * @returns {string} 绝对路径
 */
export function resolveBackupDir(argv, repo, home) {
  const bi = argv.indexOf('--backup-dir');
  let dir = path.join(home, '.sgx-kv-backups');
  if (bi !== -1) {
    const v = argv[bi + 1];
    if (!v || v.startsWith('--')) throw new Error('--backup-dir 后面要跟目录');
    dir = path.resolve(v);
  }
  const rel = path.relative(path.resolve(repo), dir);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('备份目录在仓库里（' + dir + '）：备份是明文，仓库是公开的，换一个仓库外的目录');
  }
  return dir;
}

/**
 * 校验。
 * - 默认（--apply 之后、--verify）：每个计划写入的新键，现值必须与计划值一致（JSON 值按解析后比较）。
 * - presenceOnly（--delete-old，PR 3 已部署）：新代码已经在写新键（纪元推进、signCount、新注册的钥匙），
 *   值不再要求相等，只要求新键存在；带过期时间的键（challenge、限速计数、设备黑名单等）到期消失也算正常。
 * @param {Write[]} writes
 * @param {Map<string, {value:string, expiration?:number}>} current 新键现值
 * @param {{presenceOnly?:boolean}} [opts]
 * @returns {{ok:boolean, mismatches:{key:string, reason:string}[]}}
 */
export function verifyPlan(writes, current, opts) {
  const presenceOnly = !!(opts && opts.presenceOnly);
  const mismatches = [];
  for (const w of writes) {
    const cur = current.get(w.key);
    if (!cur) {
      if (!(presenceOnly && w.expiration)) mismatches.push({ key: w.key, reason: 'missing' });
      continue;
    }
    if (!presenceOnly && !sameValue(cur.value, w.value)) mismatches.push({ key: w.key, reason: 'value' });
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** @param {string} a @param {string} b */
function sameValue(a, b) {
  if (a === b) return true;
  try { return JSON.stringify(sortDeep(JSON.parse(a))) === JSON.stringify(sortDeep(JSON.parse(b))); } catch (e) { return false; }
}
/** @param {any} v */
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => { o[k] = sortDeep(v[k]); return o; }, {});
  return v;
}

/* ---------------- Cloudflare REST API ---------------- */

function cfg() {
  const token = process.env.CF_API_TOKEN || '';
  const account = process.env.CF_ACCOUNT_ID || '';
  let ns = process.env.SGX_KV_NAMESPACE_ID || '';
  if (!ns) ns = 'b796097c90104000992b7713f61e16ea'; /* 认证库 KV（以前的 KV_LOCK_DOOR / KV_ACCOUNT_LOGIN） */
  if (!token || !account || !ns) {
    throw new Error('缺环境变量：CF_API_TOKEN、CF_ACCOUNT_ID（namespace id 可用 SGX_KV_NAMESPACE_ID 指定）');
  }
  return { token, base: `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${ns}`, ns };
}

/** @param {ReturnType<typeof cfg>} c @param {string} p @param {RequestInit} [init] */
async function cf(c, p, init) {
  const res = await fetch(c.base + p, Object.assign({}, init, { headers: Object.assign({ Authorization: 'Bearer ' + c.token }, (init && init.headers) || {}) }));
  if (!res.ok) throw new Error('Cloudflare API ' + (init && init.method || 'GET') + ' ' + p + ' → ' + res.status + ' ' + (await res.text()).slice(0, 300));
  return res;
}

/** 列出全部键（含 expiration、metadata） @param {ReturnType<typeof cfg>} c */
async function listAll(c) {
  const out = [];
  let cursor = '';
  do {
    const j = await (await cf(c, '/keys?limit=1000' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))).json();
    for (const k of j.result || []) out.push(k);
    cursor = (j.result_info && j.result_info.cursor) || '';
  } while (cursor);
  return out;
}

/** 读全部键值 @param {ReturnType<typeof cfg>} c @returns {Promise<KvEntry[]>} */
async function dumpAll(c) {
  const keys = await listAll(c);
  const out = [];
  for (const k of keys) {
    const buf = Buffer.from(await (await cf(c, '/values/' + encodeURIComponent(k.name))).arrayBuffer());
    out.push({ name: k.name, value: buf.toString('utf8'), base64: buf.toString('base64'), expiration: k.expiration, metadata: k.metadata });
  }
  return out;
}

/** @param {ReturnType<typeof cfg>} c @param {Write[]} writes */
async function bulkWrite(c, writes) {
  for (let i = 0; i < writes.length; i += 1000) {
    const body = writes.slice(i, i + 1000).map((w) => {
      const o = { key: w.key, value: w.value };
      if (w.expiration) o.expiration = w.expiration;
      if (w.metadata !== undefined) o.metadata = w.metadata;
      return o;
    });
    await cf(c, '/bulk', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
}

/** @param {ReturnType<typeof cfg>} c @param {string[]} keys */
async function bulkDelete(c, keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    await cf(c, '/bulk/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(keys.slice(i, i + 1000)) });
  }
}

/** @param {string[]} argv */
async function main(argv) {
  const has = (f) => argv.includes(f);
  const mode = has('--delete-old') ? 'delete-old' : has('--verify') ? 'verify' : has('--apply') ? 'apply' : 'dry-run';
  const backupDir = resolveBackupDir(argv, REPO, os.homedir());
  const c = cfg();

  /* 1. 备份（每种模式都先备份；明文，只给自己读） */
  const entries = await dumpAll(c);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const file = path.join(backupDir, 'kv-backup-' + c.ns + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  writeFileSync(file, JSON.stringify({ namespace: c.ns, at: new Date().toISOString(), entries }, null, 1), { mode: 0o600, flag: 'wx' });
  console.log('备份：' + entries.length + ' 个键 → ' + file + '（明文，迁移收尾后删掉）');

  const plan = planMigration(entries);
  const { toWrite, existing } = splitExisting(plan.writes, new Set(entries.map((e) => e.name)));
  console.log('计划：写 ' + toWrite.length + ' 个新键，已存在不覆盖 ' + existing.length + ' 个，旧键 ' + plan.deleteOld.length + ' 个（--delete-old 时删），跳过 ' + plan.skipped.length + ' 个，未知 ' + plan.unknown.length + ' 个');
  for (const w of toWrite) console.log('  ' + w.from + ' → ' + w.key + (w.expiration ? '（过期 ' + new Date(w.expiration * 1000).toISOString() + '）' : ''));
  for (const w of existing) console.log('  已存在，不覆盖 ' + w.key + '（来自 ' + w.from + '）');
  for (const s of plan.skipped) console.log('  跳过 ' + s.key + '：' + s.reason);
  for (const u of plan.unknown) console.log('  未知（不动）' + u);
  if (mode === 'dry-run') { console.log('dry-run：没有写任何东西。确认无误后加 --apply。'); return 0; }

  const verifyNow = async (presenceOnly) => {
    const after = new Map((await dumpAll(c)).map((e) => [e.name, e]));
    const v = verifyPlan(plan.writes, after, { presenceOnly });
    for (const m of v.mismatches) console.log('  不一致 ' + m.key + '：' + m.reason);
    console.log(v.ok ? '校验通过：' + plan.writes.length + ' 个新键' + (presenceOnly ? '都在' : '与旧值一致') : '校验失败：' + v.mismatches.length + ' 个');
    return v.ok;
  };

  if (mode === 'apply') {
    await bulkWrite(c, toWrite);
    console.log('已写入 ' + toWrite.length + ' 个新键');
    /* 本次写的逐值比对；之前就在的只查存在（可能已被新代码更新过） */
    const after = new Map((await dumpAll(c)).map((e) => [e.name, e]));
    const a = verifyPlan(toWrite, after);
    const b = verifyPlan(existing, after, { presenceOnly: true });
    const mm = a.mismatches.concat(b.mismatches);
    for (const m of mm) console.log('  不一致 ' + m.key + '：' + m.reason);
    console.log(mm.length === 0 ? '校验通过：写入 ' + toWrite.length + ' 个、已存在 ' + existing.length + ' 个' : '校验失败：' + mm.length + ' 个');
    return mm.length === 0 ? 0 : 1;
  }
  if (mode === 'verify') return (await verifyNow()) ? 0 : 1;
  /* delete-old：先确认新键都在（PR 3 已部署，值可能已被新代码更新，不再比值），才删 */
  if (!(await verifyNow(true))) { console.log('校验没通过，不删旧键。'); return 1; }
  await bulkDelete(c, plan.deleteOld);
  console.log('已删除旧键 ' + plan.deleteOld.length + ' 个');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
}
