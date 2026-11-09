/**
 * 刷新流水线（cron、手动、改动后自动，同一份代码；设计稿 v1.7 §4 + 覆盖项）：
 *   抢锁 → 没公钥报错 → 读 DB_KEY → 开着的源并行处理（机场：解密链接 → 拉 → 抽 proxies → 加密存节点；
 *   失败记类别、用上次好的节点；文件：用上次上传的节点）→ 每源用公钥 age 加密 → 条件写成品 → 放锁。
 * 明文只在内存里；日志和错误里没有链接或节点内容。
 *
 * CPU：免费档每次调用 10 ms。抽 proxies（js-yaml）+ age 加密，一个 200 节点的源本地约 4 ms、1000 节点约 12 ms，
 * 几个源放一次调用里会超。所以绑了 SELF（本 Worker 的命名入口 ProxyRefresher）时，每个源各走一次服务绑定调用，
 * 各算各的 CPU；协调这一次只做抢锁、读列表、发调用、放锁。没绑 SELF（单测）就在本次调用里依次跑。
 */
import { acquire, release } from './lock.js';
import { getMeta, listSourcesFull, getSourceById, holdsLock, saveFetched, saveError, writeArmor } from './store.js';
import { fetchAirport } from './airport.js';
import { extractProxies, providerText } from './parse.js';
import { userAgent } from './ua.js';
import { ERR } from './config.js';
import { importDbKey, seal, open } from '../../lib/aes.js';
import { encryptArmor } from '../../lib/age.js';
import { readDbKey } from '../../secrets.js';

/** 加密附加数据：行 id + 字段 */
export const aad = (id, field) => id + ':' + field;

/**
 * 把一个源的节点做成成品并写库。
 * @returns {Promise<boolean>}
 */
async function publish(env, row, proxies, pubkey, gen, owner) {
  const armor = await encryptArmor(pubkey, providerText(proxies, gen));
  return writeArmor(env, row.id, armor, gen, owner);
}

/** @param {any} env @param {any} row @param {CryptoKey} key @param {string} pubkey @param {number} now @param {string} owner @param {string} ua @param {typeof fetch} fetchFn */
async function refreshOne(env, row, key, pubkey, now, owner, ua, fetchFn) {
  let proxies = null;
  let error = null;
  if (row.type === 'airport') {
    let url = null;
    try { url = await open(key, aad(row.id, 'url'), row.url_enc); } catch (e) { error = ERR.config; }
    if (url) {
      const got = await fetchAirport(url, ua, fetchFn);
      if (!got.ok) error = got.error;
      else {
        const ex = extractProxies(got.text);
        if (!ex.ok) error = ex.error;
        else {
          proxies = ex.proxies;
          await saveFetched(env, row.id, await seal(key, aad(row.id, 'nodes'), JSON.stringify(proxies)), proxies.length, now);
        }
      }
    }
    if (error) await saveError(env, row.id, error);
  }
  if (!proxies && row.last_nodes_enc) {
    try { proxies = JSON.parse(await open(key, aad(row.id, 'nodes'), row.last_nodes_enc)); } catch (e) { proxies = null; error = error || ERR.config; }
  }
  if (!proxies) return { name: row.name, ok: false, error: error || ERR.empty, nodes: 0 };
  const written = await publish(env, row, proxies, pubkey, now, owner);
  return { name: row.name, ok: !error, error, nodes: proxies.length, stale: !!error, written };
}

/**
 * 刷新一个源（ProxyRefresher.refreshSource 调，或协调者在本次调用里直接调）。锁必须还在 owner 手里，否则什么都不做。
 * @param {any} env @param {string} id @param {string} owner @param {number} now @param {string} ua @param {typeof fetch} [fetchFn]
 */
export async function refreshSourceById(env, id, owner, now, ua, fetchFn = fetch) {
  if (!(await holdsLock(env, owner, now))) return { ok: false, error: 'busy' };
  const row = await getSourceById(env, id);
  if (!row || Number(row.enabled) !== 1) return { ok: false, error: 'not-found' };
  const pubkey = await getMeta(env, 'pubkey');
  if (!pubkey) return { name: row.name, ok: false, error: ERR.noKey, nodes: 0 };
  let key;
  try { key = await importDbKey(await readDbKey(env)); } catch (e) { return { name: row.name, ok: false, error: ERR.config, nodes: 0 }; }
  return refreshOne(env, row, key, pubkey, now, owner, ua, fetchFn);
}

/**
 * @param {any} env
 * @param {{ now?: number, fetchFn?: typeof fetch }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string, sources?: any[] }>}
 */
export async function runRefresh(env, opts = {}) {
  const now = opts.now ?? Date.now();
  const fetchFn = opts.fetchFn ?? fetch;
  const owner = crypto.randomUUID();
  if (!(await acquire(env, owner, now))) return { ok: false, error: 'busy' };
  try {
    const pubkey = await getMeta(env, 'pubkey');
    if (!pubkey) return { ok: false, error: ERR.noKey };
    let key;
    try { key = await importDbKey(await readDbKey(env)); } catch (e) { return { ok: false, error: ERR.config }; }
    const rows = (await listSourcesFull(env)).filter((r) => Number(r.enabled) === 1);
    const ua = rows.some((r) => r.type === 'airport') ? await userAgent(env, now, fetchFn) : '';
    const self = env.SELF && typeof env.SELF.refreshSource === 'function' ? env.SELF : null;
    const settled = await Promise.allSettled(rows.map((r) => (self
      ? self.refreshSource(r.id, owner, now, ua)
      : refreshOne(env, r, key, pubkey, now, owner, ua, fetchFn))));
    const sources = settled.map((s, i) => (s.status === 'fulfilled' ? s.value : { name: rows[i].name, ok: false, error: ERR.config, nodes: 0 }));
    return { ok: true, sources };
  } finally {
    await release(env, owner);
  }
}
