/**
 * D1 styrigx-proxy（绑定 D1_PROXY）读写。只放 SQL，不做加解密。
 * meta 的键：pubkey（age 公钥）、token_hash（令牌 SHA-256，下载比对用）、token_sealed（DB_KEY 封存的令牌，sub show 重印用）、ua、ua_checked。
 */

/** @param {any} env */
export const db = (env) => env.D1_PROXY;
export const dbReady = (env) => !!(env && env.D1_PROXY && typeof env.D1_PROXY.prepare === 'function');

/** @param {any} env @param {string} k @returns {Promise<string|null>} */
export async function getMeta(env, k) {
  const r = await db(env).prepare('SELECT v FROM meta WHERE k = ?').bind(k).first();
  return r ? r.v : null;
}

/** @param {any} env @param {string} k @param {string} v */
export async function setMeta(env, k, v) {
  await db(env).prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v).run();
}

/** 换令牌：哈希和封存原文同一次 batch 写（不会出现只换了一半） @param {any} env @param {string} hash @param {string} sealed */
export async function setToken(env, hash, sealed) {
  const up = 'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v';
  await db(env).batch([db(env).prepare(up).bind('token_hash', hash), db(env).prepare(up).bind('token_sealed', sealed)]);
}

const COLS = 'id, name, type, enabled, host, node_count, last_ok_at, last_error, gen, created_at, (armor <> \'\') AS ready';

/** 列表（不含密文） @param {any} env */
export async function listSources(env) {
  const r = await db(env).prepare(`SELECT ${COLS} FROM sources ORDER BY created_at, name`).all();
  return r.results || [];
}

/** 一行，带密文字段 @param {any} env @param {string} name */
export async function getSourceFull(env, name) {
  return db(env).prepare('SELECT * FROM sources WHERE name = ?').bind(name).first();
}

/** 一行（按 id），带密文 @param {any} env @param {string} id */
export async function getSourceById(env, id) {
  return db(env).prepare('SELECT * FROM sources WHERE id = ?').bind(id).first();
}

/** 锁是不是还在 owner 手里 @param {any} env @param {string} owner @param {number} now */
export async function holdsLock(env, owner, now) {
  const r = await db(env).prepare('SELECT 1 AS x FROM lock WHERE id = 1 AND owner = ? AND expires > ?').bind(owner, now).first();
  return !!r;
}

/** 刷新用：全部行带密文 @param {any} env */
export async function listSourcesFull(env) {
  const r = await db(env).prepare('SELECT * FROM sources ORDER BY created_at, name').all();
  return r.results || [];
}

/** 下载用：开着且有成品 @param {any} env @param {string} name @returns {Promise<string|null>} */
export async function getArmor(env, name) {
  const r = await db(env).prepare("SELECT armor FROM sources WHERE name = ? AND enabled = 1 AND armor <> ''").bind(name).first();
  return r ? r.armor : null;
}

/** @param {any} env */
export async function countSources(env) {
  const r = await db(env).prepare('SELECT COUNT(*) AS n FROM sources').first();
  return r ? Number(r.n) : 0;
}

/** 新建一行（armor 空） @param {any} env @param {any} row */
export async function insertSource(env, row) {
  await db(env).prepare('INSERT INTO sources (id, name, type, enabled, host, url_enc, last_nodes_enc, node_count, last_ok_at, last_error, armor, gen, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, NULL, \'\', 0, ?)')
    .bind(row.id, row.name, row.type, row.host ?? null, row.url_enc ?? null, row.last_nodes_enc ?? null, row.node_count ?? 0, row.last_ok_at ?? null, row.created_at).run();
}

/** 同名更新机场链接：换链接、清上次节点和成品（旧节点属于旧链接） @param {any} env */
export async function replaceAirport(env, id, host, urlEnc, nodesEnc, count, now) {
  /* 改机场链接（P2，设计稿 v1.10 §5）：新链接试拉成功后一条语句换链接和节点；成品不清（紧接着只为这个源重出一次） */
  await db(env).prepare("UPDATE sources SET host = ?, url_enc = ?, last_nodes_enc = ?, node_count = ?, last_ok_at = ?, last_error = NULL WHERE id = ? AND type = 'airport'")
    .bind(host, urlEnc, nodesEnc, count, now, id).run();
}

/** 改名（sub mv）：只改 name，id、成品、节点、开关都不动 @param {any} env @param {string} from @param {string} to @returns {Promise<boolean>} */
export async function renameSource(env, from, to) {
  const r = await db(env).prepare('UPDATE sources SET name = ? WHERE name = ? AND NOT EXISTS (SELECT 1 FROM sources WHERE name = ?)').bind(to, from, to).run();
  return Number(r.meta && r.meta.changes) > 0;
}

/** 同名覆盖上传文件 @param {any} env */
export async function updateFileNodes(env, id, nodesEnc, count, now) {
  await db(env).prepare("UPDATE sources SET last_nodes_enc = ?, node_count = ?, last_ok_at = ?, last_error = NULL WHERE id = ? AND type = 'file'")
    .bind(nodesEnc, count, now, id).run();
}

/** @param {any} env @param {string} name @param {boolean} on @returns {Promise<boolean>} */
export async function setEnabled(env, name, on) {
  const r = await db(env).prepare('UPDATE sources SET enabled = ? WHERE name = ?').bind(on ? 1 : 0, name).run();
  return Number(r.meta && r.meta.changes) > 0;
}

/** @param {any} env @param {string} name @returns {Promise<boolean>} */
export async function deleteSource(env, name) {
  const r = await db(env).prepare('DELETE FROM sources WHERE name = ?').bind(name).run();
  return Number(r.meta && r.meta.changes) > 0;
}

/** 刷新：机场拉取成功 → 存节点 @param {any} env */
export async function saveFetched(env, id, nodesEnc, count, now) {
  await db(env).prepare('UPDATE sources SET last_nodes_enc = ?, node_count = ?, last_ok_at = ?, last_error = NULL WHERE id = ?').bind(nodesEnc, count, now, id).run();
}

/** 刷新：记错误类别 @param {any} env */
export async function saveError(env, id, error) {
  await db(env).prepare('UPDATE sources SET last_error = ? WHERE id = ?').bind(error, id).run();
}

/**
 * 写成品：只写更新的版本，并且锁还在自己手里（设计 v1.7）。
 * @returns {Promise<boolean>} 写进去没有
 */
export async function writeArmor(env, id, armor, gen, owner) {
  const r = await db(env).prepare('UPDATE sources SET armor = ?, gen = ? WHERE id = ? AND gen < ? AND EXISTS (SELECT 1 FROM lock WHERE id = 1 AND owner = ?)')
    .bind(armor, gen, id, gen, owner).run();
  return Number(r.meta && r.meta.changes) > 0;
}

/** 换公钥后旧成品作废（新公钥的成品由紧接着的刷新写） @param {any} env */
export async function clearAllArmor(env) {
  await db(env).prepare("UPDATE sources SET armor = '', gen = 0").run();
}
