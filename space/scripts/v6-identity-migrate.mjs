#!/usr/bin/env node
/**
 * @fileoverview v6 身份统一：把现有凭据迁成 root / styrigx 两个用户的 SQL 生成器（P1 只写脚本，不执行）。
 *
 * 本脚本从不连 Cloudflare、不跑 wrangler、不写任何库：只读一份导出的 JSON，输出一个 SQL 文件。
 * 什么时候、由谁对正式库 styrigx-account 执行这份 SQL，在 P2 / P3 由 Gray 批准（见 docs/specs/v6-identity-migration.md）。
 *
 * 对照表（定稿 §九、Muse 复盘 5）：
 *   现账号凭据（账号库 styrigx-account，同库 SQL 直接搬，不用导出）：
 *     account_password(id=1)                 → account_user_password(uid 0)，record 原样，pepper_id 'account'（SGX_ACCOUNT_PASSWORD_PEPPER）
 *     account_passkey                        → account_user_passkey(uid 0)，credential_id / record 逐字节照抄；
 *                                              user_handle / legacy_handle = account_user_handle 的 handle / legacy_handle
 *   现进站凭据（站点核心库 styrigx-space-core，跨库，要导出）：
 *     password WHERE realm='lock'            → account_user_password(uid 1000)，record 原样，pepper_id 'space'（SGX_SPACE_PASSWORD_PEPPER）
 *     passkey WHERE realm='lock'             → account_user_passkey(uid 1000)，credential_id / record 逐字节照抄；
 *                                              user_handle / legacy_handle = user_handle(realm='lock') 的 handle / legacy_handle
 *   用户与组：account_users 两行（0 root、1000 styrigx；styrigx 的 avatar = 'avatar:'，即 KV_PROFILE 里现有的 avatar:* 文件）；
 *     styrigx 的默认组 wheel、sudoers、listen、ai、status、curio-write、daymark-write。
 *   头像、偏好（settings_sync）、设备（account_device）、数字健康（wb_daily）：表都还没有 uid，数据不动、归属记为 styrigx（P2 加 uid 时搬）。
 *
 * 红线：通行密钥只改挂 uid，RP（styrigx.com）不变；credential_id、record（credId、publicKey、signCount、aaguid）逐字节不动；
 *   user handle 逐字节照抄。通行密钥用普通 INSERT（不是 OR IGNORE）：凭据 ID 撞了宁可整批失败，也不悄悄丢一把钥匙。
 *   给了 --account 导出时脚本先比对两边的凭据 ID，撞了直接报错、不出 SQL。
 * 密码：哈希原样复制（加盐 + pepper，不换算法）。两把 pepper：root 的哈希是 SGX_ACCOUNT_PASSWORD_PEPPER 做的，styrigx 的（进站密码）
 *   是 SGX_SPACE_PASSWORD_PEPPER 做的，记在 account_user_password.pepper_id。未决（二选一，Hark 倾向 a）：
 *   a) 登录成功时用账号 pepper 重算哈希、pepper_id 改成 'account'，全部重算后 P4 删 space pepper；b) 两把 pepper 并存。
 * 幂等：用户、组用 INSERT OR IGNORE；密码只在该用户还没有密码行时写；通行密钥按「这把已挂在这个 uid 上」跳过（WHERE NOT EXISTS），
 *   再跑一遍什么都不变；挂在另一个 uid 上的同一凭据 ID 会让 INSERT 撞主键失败（不悄悄丢）。
 *
 * 用法：
 *   node space/scripts/v6-identity-migrate.mjs --print-export        打印两条只读导出命令（SELECT，--json）
 *   node space/scripts/v6-identity-migrate.mjs --space space.json [--account account.json] [--out v6-identity.sql] [--now <毫秒>]
 *   导出文件就是 `wrangler d1 execute <库> --remote --json --command "<EXPORT_SQL>"` 的原样输出（三条语句三组结果）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** 站点核心库的只读导出（三条 SELECT，顺序固定：密码、通行密钥、user handle） */
export const SPACE_EXPORT_SQL = "SELECT record FROM password WHERE realm = 'lock'; SELECT credential_id, record FROM passkey WHERE realm = 'lock' ORDER BY credential_id; SELECT handle, legacy_handle FROM user_handle WHERE realm = 'lock'";
/** 账号库的只读导出（只用来比对凭据 ID 撞没撞；搬数据本身在同库 SQL 里） */
export const ACCOUNT_EXPORT_SQL = 'SELECT credential_id FROM account_passkey ORDER BY credential_id';

export const ROOT_UID = 0;
export const STYRIGX_UID = 1000;
export const STYRIGX_GROUPS = Object.freeze(['wheel', 'sudoers', 'listen', 'ai', 'status', 'curio-write', 'daymark-write']);

/** SQL 字符串字面量 @param {string} s */
export function q(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * 解析 wrangler d1 execute --json 的输出：[{ results: [...] }, ...]（也接受直接给的数组的数组）。
 * @param {any} json @param {number} n 期望的结果组数
 * @returns {any[][]}
 */
export function resultSets(json, n) {
  if (!Array.isArray(json) || json.length !== n) throw new Error('导出格式不对：要 ' + n + ' 组结果，拿到 ' + (Array.isArray(json) ? json.length : typeof json));
  return json.map((x, i) => {
    const rows = Array.isArray(x) ? x : x && Array.isArray(x.results) ? x.results : null;
    if (!rows) throw new Error('第 ' + (i + 1) + ' 组没有 results');
    if (x && x.success === false) throw new Error('第 ' + (i + 1) + ' 组 success=false');
    return rows;
  });
}

/**
 * 站点核心导出 → { password, passkeys, handle }（校验：record 是 JSON、通行密钥 record.credId 与 credential_id 一致、handle 至多一行）。
 * @param {any} json
 */
export function parseSpaceExport(json) {
  const [pw, pk, uh] = resultSets(json, 3);
  if (pw.length > 1 || uh.length > 1) throw new Error('lock 的 password / user_handle 应至多一行');
  const passkeys = pk.map((r) => {
    if (typeof r.credential_id !== 'string' || !r.credential_id || typeof r.record !== 'string') throw new Error('通行密钥行不完整');
    const rec = JSON.parse(r.record);
    if (rec.credId !== undefined && rec.credId !== r.credential_id) throw new Error('通行密钥 credId 与 credential_id 不一致：' + r.credential_id);
    return { credentialId: r.credential_id, record: r.record };
  });
  if (passkeys.length && !uh.length) throw new Error('有进站通行密钥却没有 user handle（userHandle 校验会失败），停止');
  const password = pw.length ? pw[0].record : null;
  if (password !== null) JSON.parse(password);
  return { password, passkeys, handle: uh.length ? { handle: String(uh[0].handle), legacy: String(uh[0].legacy_handle || '') } : null };
}

/** 账号导出 → 凭据 ID 列表 @param {any} json @returns {string[]} */
export function parseAccountExport(json) {
  return resultSets(json, 1)[0].map((r) => String(r.credential_id));
}

/**
 * 生成迁移 SQL（给账号库 styrigx-account 用）。
 * @param {ReturnType<typeof parseSpaceExport>} space
 * @param {{now: number, accountCredentialIds?: string[]}} opts
 * @returns {string}
 */
export function generateSql(space, opts) {
  const now = Math.floor(Number(opts.now));
  if (!Number.isFinite(now) || now <= 0) throw new Error('now 不对');
  if (opts.accountCredentialIds) {
    const clash = space.passkeys.filter((p) => opts.accountCredentialIds.includes(p.credentialId)).map((p) => p.credentialId);
    if (clash.length) throw new Error('进站通行密钥与账号通行密钥的凭据 ID 撞了（' + clash.join(', ') + '），要人工决定归属，停止');
  }
  const L = [];
  L.push('-- v6 身份统一：凭据迁移（space/scripts/v6-identity-migrate.mjs 生成，' + new Date(now).toISOString() + '）。');
  L.push('-- 只给账号库 styrigx-account 用；执行前要 Gray 批准（P1 不对生产执行）。幂等：再跑一遍不变。');
  L.push('');
  L.push('-- 用户：root（uid 0）、styrigx（uid 1000）');
  L.push('INSERT OR IGNORE INTO account_users (uid, name, avatar, expires_at, epoch, disabled, created_at) VALUES (' + ROOT_UID + ", 'root', '', 0, 0, 0, " + now + '), (' + STYRIGX_UID + ", 'styrigx', 'avatar:', 0, 0, 0, " + now + ');');
  L.push('-- styrigx 的默认组');
  L.push('INSERT OR IGNORE INTO account_user_groups (uid, grp, added_at) VALUES ' + STYRIGX_GROUPS.map((g) => '(' + STYRIGX_UID + ', ' + q(g) + ', ' + now + ')').join(', ') + ';');
  L.push('');
  L.push('-- 现账号凭据 → root（同库搬；record 原样复制，pepper_id = account：SGX_ACCOUNT_PASSWORD_PEPPER）');
  L.push('INSERT INTO account_user_password (uid, record, pepper_id, must_change, expires_at) SELECT ' + ROOT_UID + ", record, 'account', 0, 0 FROM account_password WHERE id = 1"
    + ' AND NOT EXISTS (SELECT 1 FROM account_user_password WHERE uid = ' + ROOT_UID + ');');
  L.push('INSERT INTO account_user_passkey (credential_id, uid, user_handle, legacy_handle, record) SELECT p.credential_id, ' + ROOT_UID + ', h.handle, h.legacy_handle, p.record'
    + ' FROM account_passkey p JOIN account_user_handle h ON h.id = 1'
    + ' WHERE NOT EXISTS (SELECT 1 FROM account_user_passkey x WHERE x.credential_id = p.credential_id AND x.uid = ' + ROOT_UID + ');');
  L.push('');
  L.push('-- 现进站凭据 → styrigx（跨库，值来自站点核心的只读导出；record 原样复制，pepper_id = space：SGX_SPACE_PASSWORD_PEPPER）');
  if (space.password !== null) {
    L.push('INSERT INTO account_user_password (uid, record, pepper_id, must_change, expires_at) SELECT ' + STYRIGX_UID + ', ' + q(space.password) + ", 'space', 0, 0"
      + ' WHERE NOT EXISTS (SELECT 1 FROM account_user_password WHERE uid = ' + STYRIGX_UID + ');');
  } else {
    L.push('-- （站点核心没有进站密码）');
  }
  if (space.passkeys.length && space.handle) {
    for (const p of space.passkeys) {
      L.push('INSERT INTO account_user_passkey (credential_id, uid, user_handle, legacy_handle, record) SELECT ' + [q(p.credentialId), STYRIGX_UID, q(space.handle.handle), q(space.handle.legacy), q(p.record)].join(', ')
        + ' WHERE NOT EXISTS (SELECT 1 FROM account_user_passkey WHERE credential_id = ' + q(p.credentialId) + ' AND uid = ' + STYRIGX_UID + ');');
    }
  } else {
    L.push('-- （站点核心没有进站通行密钥）');
  }
  L.push('');
  return L.join('\n');
}

/* ---------------- 命令行 ---------------- */

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--print-export') o.printExport = true;
    else if (a === '--space' || a === '--account' || a === '--out' || a === '--now') o[a.slice(2)] = argv[++i];
    else throw new Error('不认识的参数：' + a);
  }
  return o;
}

export function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.printExport) {
    console.log('# 只读导出（SELECT；不写库）');
    console.log('npx wrangler d1 execute styrigx-space-core --remote --json --command "' + SPACE_EXPORT_SQL + '" > space.json');
    console.log('npx wrangler d1 execute styrigx-account --remote --json --command "' + ACCOUNT_EXPORT_SQL + '" > account.json');
    return 0;
  }
  if (typeof o.space !== 'string') throw new Error('要 --space <导出文件>（先 --print-export 看导出命令）');
  const space = parseSpaceExport(JSON.parse(readFileSync(o.space, 'utf8')));
  const accountCredentialIds = typeof o.account === 'string' ? parseAccountExport(JSON.parse(readFileSync(o.account, 'utf8'))) : undefined;
  const sql = generateSql(space, { now: o.now ? Number(o.now) : Date.now(), accountCredentialIds });
  if (typeof o.out === 'string') {
    writeFileSync(o.out, sql);
    console.log('写好了 ' + o.out + '（没有执行；执行前要 Gray 批准）');
  } else {
    process.stdout.write(sql);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    process.exit(main());
  } catch (e) {
    console.error('[v6-identity-migrate] ' + (e && /** @type {any} */ (e).message || e));
    process.exit(1);
  }
}
