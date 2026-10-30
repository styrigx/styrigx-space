/**
 * D1 里的网关认证状态（2026-10-27 从 KV 全部搬来；网关不再绑定 KV）。
 *
 * 为什么搬：Workers KV 最终一致，边缘读最长约 60 秒才看到新值。认证状态几乎都是「写完马上要读到」的：
 * 纪元（吊销）、通行密钥、密码、作废临时钥匙、单独退出设备、单次使用的 challenge、输错计数。
 * D1 读强一致（同一个库只有一个主库）。
 *
 * 读主库（安全读的硬性要求）：网关不开 D1 read replication，也不用 D1 session API。纪元、吊销（临时钥匙、设备）、challenge、
 * 输错计数、临时钥匙这些安全读只走绑定本身（= 主库）；内存和 KV 都不缓存，任何吊销判断都以这一次请求读到的 D1 为准。
 * （tests/workers/auth-gateway/d1-state.test.mjs 扫网关源码核对：任何地方出现 session API 调用就失败。）
 *
 * 表（migrations/0005_lock_account_state.sql、0006_auth_state.sql，库 styrigx-auth-gateway；SCHEMA 是同一份语句的代码兜底）：
 * 都是小写 snake_case 名词、都有 realm 列（'lock' | 'account' | 'root'）。本文件管 epoch / passkey / password / user_handle；
 * challenge（passkey-verify.js）、attempt_limit（attempt-limit.js）、tempkey（lock-tempkey.js）、device（account-devices.js）、
 * audit（root-audit.js）的 SQL 在各自模块里，经这里的 authDb / withSchema 访问。kv_migration 只有导入脚本写。
 * 绑定按域：realm.d1Binding（lock → D1_LOCK_AUTH，account → D1_ACCOUNT_AUTH，root → D1_ROOT_AUTH；同一个库 styrigx-auth-gateway）。恢复开关 recovery_switch 也经 D1_LOCK_AUTH（lock-reset-switch.js）。
 *
 * 上线前的 KV 旧值：scripts/migrate-kv-to-d1.mjs 在部署前跑一次写进 D1（运行时不读 KV，没有回落）。
 *
 * 出错一律抛（D1 未绑定、查询失败）；调用方按 fail closed 处理（签发 503、验票无效）。
 * 表不存在（正式网关的部署 job 不跑迁移）：建表后整次操作重试一次。
 *
 * 网关自己的一份（2026-10-30 起各 Worker 各自实现，没有共享目录）：不 import 任何东西，也不认识具体的域。
 * 域由调用方传入域描述对象（至少有 id、d1Binding，见网关 _kernel/realms.js 的 REALM_*）；
 * 网关 _kernel/d1-state.js 包一层，只认网关的三个域（也认它们的 id），再调这里。
 */

/**
 * 与 migrations/0005_lock_account_state.sql + 0006_auth_state.sql 相同的建表语句（按文件顺序；d1-state.test.mjs 核对）。
 * 全部 IF NOT EXISTS：代码兜底建表和迁移重复跑都不出错。
 */
export const SCHEMA = Object.freeze([
  /* 0005 */
  'CREATE TABLE IF NOT EXISTS epoch (realm TEXT PRIMARY KEY, value INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS passkey (realm TEXT NOT NULL, credential_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (realm, credential_id))',
  'CREATE TABLE IF NOT EXISTS password (realm TEXT PRIMARY KEY, record TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS kv_migration (name TEXT PRIMARY KEY, migrated_at INTEGER NOT NULL)',
  /* 0006 */
  'CREATE TABLE IF NOT EXISTS user_handle (realm TEXT PRIMARY KEY, handle TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS challenge (realm TEXT NOT NULL, id TEXT NOT NULL, purpose TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (realm, id))',
  'CREATE TABLE IF NOT EXISTS attempt_limit (realm TEXT NOT NULL, kind TEXT NOT NULL, bucket TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, strikes INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, PRIMARY KEY (realm, kind, bucket))',
  'CREATE TABLE IF NOT EXISTS tempkey (realm TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL DEFAULT \'\', code_hash TEXT, link INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, revoked_at INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, PRIMARY KEY (realm, id))',
  'CREATE UNIQUE INDEX IF NOT EXISTS tempkey_code ON tempkey (realm, code_hash)',
  'CREATE TABLE IF NOT EXISTS device (realm TEXT NOT NULL, device_id TEXT NOT NULL, record TEXT NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, PRIMARY KEY (realm, device_id))',
  'CREATE TABLE IF NOT EXISTS audit (realm TEXT NOT NULL, id TEXT NOT NULL, ts INTEGER NOT NULL, ip_prefix TEXT NOT NULL, ok INTEGER NOT NULL, decoy INTEGER NOT NULL DEFAULT 0, via TEXT NOT NULL DEFAULT \'\', path TEXT NOT NULL DEFAULT \'\', expires_at INTEGER NOT NULL, PRIMARY KEY (realm, id))',
  'CREATE INDEX IF NOT EXISTS audit_ts ON audit (realm, ts)',
]);

/**
 * 域描述对象（至少有非空的 id、d1Binding）。只按形状校验，不认识具体的域：具体有哪些域由调用方决定
 * （网关 _kernel/d1-state.js 的 realmOf 只放行网关自己的域）。不像域描述的一律抛错。
 * @param {any} realm
 * @returns {{id:string, d1Binding:string}}
 */
export function realmOf(realm) {
  if (realm && typeof realm === 'object' && typeof realm.id === 'string' && realm.id &&
    typeof realm.d1Binding === 'string' && realm.d1Binding) return realm;
  throw new Error('d1-state: bad realm ' + JSON.stringify(realm && realm.id ? realm.id : realm));
}

/**
 * 某域的 D1 绑定（主库；不开 session，见文件头）。没绑 → 抛错。
 * @param {any} env @param {any} realm
 */
export function authDb(env, realm) {
  const r = realmOf(realm);
  const db = env && env[r.d1Binding];
  if (!db) throw new Error('d1-missing ' + r.d1Binding);
  return db;
}

/**
 * 跑一次操作；遇到「no such table / no such index」就建表再整次重试一次（建表前没有任何写入成功，可以安全重试）。
 * @template T @param {any} db @param {() => Promise<T>} fn @returns {Promise<T>}
 */
export async function withSchema(db, fn) {
  try {
    return await fn();
  } catch (e) {
    if (!/no such table/i.test(String((e && e.message) || e))) throw e;
    for (const sql of SCHEMA) await db.prepare(sql).run();
    return await fn();
  }
}

/**
 * 某域 D1 上跑一次操作（authDb + withSchema）。
 * 兜底建表用本文件的 SCHEMA（网关形状；账号 Worker 的 realm.schema 兜底只在账号自己那份 d1-state.js 里）。
 * @template T @param {any} env @param {any} realm @param {(db:any, r:any) => Promise<T>} fn @returns {Promise<T>}
 */
export function onAuthDb(env, realm, fn) {
  const r = realmOf(realm);
  const db = authDb(env, r);
  return withSchema(db, () => fn(db, r));
}

/**
 * 顺手清掉某表某域已过期的行（尽力而为，出错吞掉；读路径本来就不认过期行）。
 * @param {any} db @param {'challenge'|'attempt_limit'|'tempkey'|'device'|'audit'} table @param {string} realmId @param {number} [now]
 */
export async function sweepExpired(db, table, realmId, now) {
  if (!/^(challenge|attempt_limit|tempkey|device|audit)$/.test(table)) throw new Error('sweep: bad table ' + table);
  try {
    await db.prepare('DELETE FROM ' + table + ' WHERE realm = ? AND expires_at <= ?').bind(realmId, now || Date.now()).run();
  } catch (e) {}
}

/** @param {any} row */
export function parseRecord(row) {
  if (!row || typeof row.record !== 'string') return null;
  try { return JSON.parse(row.record); } catch (e) { return null; }
}

/* ---------------- 纪元 ---------------- */

/**
 * 读某域的纪元（每次都读 D1 主库，不缓存）。还没有这一行（新库，导入脚本没写过）→ 写入 0。出错抛错。
 * @param {any} env @param {any} realm
 * @returns {Promise<number>}
 */
export async function readEpoch(env, realm) {
  return onAuthDb(env, realm, async (db, r) => {
    const sel = () => db.prepare('SELECT value FROM epoch WHERE realm = ?').bind(r.id).first();
    let row = await sel();
    if (!row) {
      await db.prepare('INSERT OR IGNORE INTO epoch (realm, value) VALUES (?, 0)').bind(r.id).run();
      row = await sel();
    }
    if (!row) throw new Error('epoch-missing ' + r.id);
    return Number(row.value);
  });
}

/**
 * 某域纪元 +1（原子：UPDATE ... SET value = value + 1 RETURNING value，两次推进拿到的一定是两个不同的值）。
 * 出错抛错（调用方 503，绝不继续）。
 * @param {any} env @param {any} realm
 * @returns {Promise<number>} 新纪元
 */
export async function bumpEpoch(env, realm) {
  return onAuthDb(env, realm, async (db, r) => {
    const up = () => db.prepare('UPDATE epoch SET value = value + 1 WHERE realm = ? RETURNING value').bind(r.id).first();
    let row = await up();
    if (!row) {
      await db.prepare('INSERT OR IGNORE INTO epoch (realm, value) VALUES (?, 0)').bind(r.id).run();
      row = await up();
    }
    if (!row) throw new Error('epoch-missing ' + r.id);
    return Number(row.value);
  });
}

/* ---------------- 通行密钥 ---------------- */

/**
 * 某域全部通行密钥记录（按注册顺序）。出错抛错。
 * @param {any} env @param {any} realm
 * @returns {Promise<any[]>}
 */
export async function listPasskeyRecords(env, realm) {
  return onAuthDb(env, realm, async (db, r) => {
    const res = await db.prepare('SELECT record FROM passkey WHERE realm = ? ORDER BY rowid').bind(r.id).all();
    return ((res && res.results) || []).map(parseRecord).filter((v) => v && v.credId);
  });
}

/**
 * 某域是否至少有一把通行密钥。出错抛错。
 * @param {any} env @param {any} realm
 * @returns {Promise<boolean>}
 */
export async function hasPasskeyRecord(env, realm) {
  return onAuthDb(env, realm, async (db, r) => !!(await db.prepare('SELECT 1 AS found FROM passkey WHERE realm = ? LIMIT 1').bind(r.id).first()));
}

/**
 * 按 credId 读一把（不存在 → null）。出错抛错。
 * @param {any} env @param {any} realm @param {string} credId
 */
export async function getPasskeyRecord(env, realm, credId) {
  return onAuthDb(env, realm, async (db, r) => {
    const row = await db.prepare('SELECT record FROM passkey WHERE realm = ? AND credential_id = ?').bind(r.id, String(credId)).first();
    const v = parseRecord(row);
    return v && v.credId === credId ? v : null;
  });
}

/**
 * 写一把（注册：没有就插入，同 credId 已有就整条覆盖）。出错抛错。
 * @param {any} env @param {any} realm @param {any} rec 必须带 credId
 */
export async function putPasskeyRecord(env, realm, rec) {
  return onAuthDb(env, realm, async (db, r) => {
    await db.prepare(
      'INSERT INTO passkey (realm, credential_id, record) VALUES (?, ?, ?) ON CONFLICT (realm, credential_id) DO UPDATE SET record = excluded.record'
    ).bind(r.id, String(rec.credId), JSON.stringify(rec)).run();
  });
}

/**
 * 更新已有的一把（signCount / lastUsedAt / 改名）：只改还在的那条，已被删掉的不会被写回来。出错抛错。
 * @param {any} env @param {any} realm @param {any} rec
 * @returns {Promise<boolean>} 是否真的改到了
 */
export async function updatePasskeyRecord(env, realm, rec) {
  return onAuthDb(env, realm, async (db, r) => {
    const res = await db.prepare('UPDATE passkey SET record = ? WHERE realm = ? AND credential_id = ?')
      .bind(JSON.stringify(rec), r.id, String(rec.credId)).run();
    return !!(res && res.meta && res.meta.changes > 0);
  });
}

/**
 * 删一把，返回被删的记录（本来就没有 → null）。出错抛错。
 * @param {any} env @param {any} realm @param {string} credId
 */
export async function deletePasskeyRecord(env, realm, credId) {
  return onAuthDb(env, realm, async (db, r) => {
    const row = await db.prepare('DELETE FROM passkey WHERE realm = ? AND credential_id = ? RETURNING record').bind(r.id, String(credId)).first();
    return parseRecord(row);
  });
}

/* ---------------- 密码 ---------------- */

/**
 * 某域的密码记录（没设置 → null）。出错抛错。
 * @param {any} env @param {any} realm
 */
export async function getPasswordRecord(env, realm) {
  return onAuthDb(env, realm, async (db, r) => parseRecord(await db.prepare('SELECT record FROM password WHERE realm = ?').bind(r.id).first()));
}

/**
 * 写某域的密码记录（设置 / 修改 / 重哈希）。出错抛错。
 * @param {any} env @param {any} realm @param {any} rec makePasswordRecord 的结果
 */
export async function putPasswordRecord(env, realm, rec) {
  return onAuthDb(env, realm, async (db, r) => {
    await db.prepare('INSERT INTO password (realm, record) VALUES (?, ?) ON CONFLICT (realm) DO UPDATE SET record = excluded.record')
      .bind(r.id, JSON.stringify(rec)).run();
  });
}

/**
 * 删某域的密码记录。出错抛错。
 * @param {any} env @param {any} realm
 */
export async function deletePasswordRecord(env, realm) {
  return onAuthDb(env, realm, async (db, r) => {
    await db.prepare('DELETE FROM password WHERE realm = ?').bind(r.id).run();
  });
}

/* ---------------- WebAuthn user handle ---------------- */

/**
 * 某域的 user handle（通行密钥注册时给认证器的 user.id）。create=true 且还没有时生成 32 字节随机值写入
 * （INSERT OR IGNORE 再读：并发第一次注册拿到同一个）。没有且不新建 → ''。出错抛错。
 * @param {any} env @param {any} realm @param {boolean} create @param {() => string} gen 生成新 handle
 * @returns {Promise<string>}
 */
export async function userHandleRecord(env, realm, create, gen) {
  return onAuthDb(env, realm, async (db, r) => {
    const sel = () => db.prepare('SELECT handle FROM user_handle WHERE realm = ?').bind(r.id).first();
    let row = await sel();
    if (!row && create) {
      await db.prepare('INSERT OR IGNORE INTO user_handle (realm, handle) VALUES (?, ?)').bind(r.id, gen()).run();
      row = await sel();
    }
    return row && row.handle ? String(row.handle) : '';
  });
}
