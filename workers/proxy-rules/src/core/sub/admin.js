/**
 * 管理操作（RPC ProxyAdmin 调；鉴权在 account Worker：会话 / reauth）。
 * 每个改动之后自动刷新一次（由调用方 waitUntil 或直接 await）。回给 account 的只有状态，不回链接和节点内容。
 */
import { NAME_RE, MAX_SOURCES, MAX_BYTES, MAX_URL } from './config.js';
import { getMeta, setMeta, listSources, getSourceFull, countSources, insertSource, replaceAirport, renameSource, updateFileNodes, setEnabled as dbSetEnabled, deleteSource, clearAllArmor } from './store.js';
import { busy } from './lock.js';
import { airportHost, fetchAirport } from './airport.js';
import { userAgent } from './ua.js';
import { extractProxies } from './parse.js';
import { aad } from './pipeline.js';
import { importDbKey, seal } from '../../lib/aes.js';
import { isX25519Recipient } from '../../lib/age.js';
import { newToken, hashToken } from '../../lib/token.js';
import { readDbKey } from '../../secrets.js';

const fail = (error) => ({ ok: false, error });

/** 公钥只显示头尾 @param {string|null} k */
export const keyHint = (k) => (k ? k.slice(0, 10) + '…' + k.slice(-6) : '');

/** @param {any} env @param {number} [now] */
export async function status(env, now = Date.now()) {
  const pubkey = await getMeta(env, 'pubkey');
  const token = await getMeta(env, 'token_hash');
  const rows = await listSources(env);
  return {
    ok: true,
    pubkey: keyHint(pubkey),
    hasKey: !!pubkey,
    hasLink: !!token,
    refreshing: await busy(env, now),
    sources: rows.map((r) => ({
      name: r.name, type: r.type, enabled: Number(r.enabled) === 1, host: r.type === 'airport' ? r.host : '',
      nodes: Number(r.node_count) || 0, ready: Number(r.ready) === 1, lastOkAt: r.last_ok_at || 0, error: r.last_error || '', gen: r.gen || 0,
    })),
  };
}

/** @param {any} env @param {unknown} pub */
export async function setKey(env, pub) {
  const k = typeof pub === 'string' ? pub.trim() : '';
  if (k.startsWith('age1pq1')) return fail('pq-unsupported');
  if (!isX25519Recipient(k)) return fail('pubkey');
  await setMeta(env, 'pubkey', k);
  await clearAllArmor(env);
  return { ok: true, pubkey: keyHint(k) };
}

/** 生成 / 替换下载令牌：明文只回这一次 @param {any} env */
export async function newLink(env) {
  const t = newToken();
  await setMeta(env, 'token_hash', await hashToken(t));
  return { ok: true, token: t };
}

async function dbKey(env) {
  try { return await importDbKey(await readDbKey(env)); } catch (e) { return null; }
}

/**
 * 加机场 / 同名改链接。改链接先试拉（设计稿 v1.10 §5）：新链接只在内存里拉一次、抽 proxies（同刷新的超时、体积、每源上限），
 * 成功才一条语句换链接和节点，回 id 给调用方只为这个源重出成品（不再重拉）；失败什么都不换、不写 last_error，回 { ok:false, error, kept:true }。
 * @param {any} env @param {unknown} name @param {unknown} url @param {number} [now] @param {typeof fetch} [fetchFn]
 */
export async function addAirport(env, name, url, now = Date.now(), fetchFn = fetch) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return fail('name');
  if (typeof url !== 'string' || url.length > MAX_URL) return fail('url');
  const host = airportHost(url);
  if (!host) return fail('url');
  const key = await dbKey(env);
  if (!key) return fail('config');
  const old = await getSourceFull(env, name);
  if (old && old.type !== 'airport') return fail('type');
  if (old) {
    const got = await fetchAirport(url.trim(), await userAgent(env, now, fetchFn), fetchFn);
    if (!got.ok) return { ok: false, error: got.error, kept: true, oldHost: old.host || '', host };
    const ex = extractProxies(got.text);
    if (!ex.ok) return { ok: false, error: ex.error, kept: true, oldHost: old.host || '', host };
    await replaceAirport(env, old.id, host, await seal(key, aad(old.id, 'url'), url.trim()),
      await seal(key, aad(old.id, 'nodes'), JSON.stringify(ex.proxies)), ex.proxies.length, now);
    return { ok: true, updated: true, oldHost: old.host || '', host, nodes: ex.proxies.length, id: old.id };
  }
  if ((await countSources(env)) >= MAX_SOURCES) return fail('too-many-sources');
  const id = crypto.randomUUID();
  await insertSource(env, { id, name, type: 'airport', host, url_enc: await seal(key, aad(id, 'url'), url.trim()), created_at: now });
  return { ok: true, updated: false, host };
}

/** 上传文件 / 同名覆盖：只抽 proxies，原文不落库 @param {any} env @param {unknown} name @param {unknown} text @param {number} [now] */
export async function upload(env, name, text, now = Date.now()) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return fail('name');
  if (typeof text !== 'string' || !text) return fail('file');
  if (new TextEncoder().encode(text).length > MAX_BYTES) return fail('size');
  const ex = extractProxies(text);
  if (!ex.ok) return fail(ex.error);
  const key = await dbKey(env);
  if (!key) return fail('config');
  const old = await getSourceFull(env, name);
  if (old && old.type !== 'file') return fail('type');
  const json = JSON.stringify(ex.proxies);
  if (old) {
    await updateFileNodes(env, old.id, await seal(key, aad(old.id, 'nodes'), json), ex.proxies.length, now);
    return { ok: true, updated: true, nodes: ex.proxies.length };
  }
  if ((await countSources(env)) >= MAX_SOURCES) return fail('too-many-sources');
  const id = crypto.randomUUID();
  await insertSource(env, { id, name, type: 'file', last_nodes_enc: await seal(key, aad(id, 'nodes'), json), node_count: ex.proxies.length, last_ok_at: now, created_at: now });
  return { ok: true, updated: false, nodes: ex.proxies.length };
}

/** @param {any} env @param {unknown} name @param {boolean} on */
export async function setEnabled(env, name, on) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return fail('name');
  return (await dbSetEnabled(env, name, !!on)) ? { ok: true } : fail('not-found');
}

/** @param {any} env @param {unknown} name */
export async function remove(env, name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return fail('name');
  return (await deleteSource(env, name)) ? { ok: true } : fail('not-found');
}

/** 改名（sub-mv）：只改名、不刷新；新名已存在 exists、旧名不存在 not-found、新旧相同不动作 @param {any} env @param {unknown} from @param {unknown} to */
export async function rename(env, from, to) {
  if (typeof from !== 'string' || !NAME_RE.test(from) || typeof to !== 'string' || !NAME_RE.test(to)) return fail('name');
  if (from === to) return { ok: true, same: true };
  if (!(await getSourceFull(env, from))) return fail('not-found');
  if (await getSourceFull(env, to)) return fail('exists');
  return (await renameSource(env, from, to)) ? { ok: true } : fail('exists');
}
