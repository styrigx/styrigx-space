/**
 * 刷新流水线（cron、手动、改动后自动，同一份代码；设计稿 v1.7 §4 + 覆盖项）：
 *   抢锁 → 没公钥报错 → 读 DB_KEY → 开着的源并行处理（机场：解密链接 → 拉 → 抽 proxies → 加密存节点；
 *   失败记类别、用上次好的节点；文件：用上次上传的节点）→ 机场源做节点处理（v1.13：丢弃 / 去旧图标 / 加国旗 / 指纹，
 *   last_nodes_enc 始终存未处理的原始节点）→ 每源用公钥 age 加密 → 条件写成品 → 放锁。
 * 明文只在内存里；日志和错误里没有链接或节点内容。
 *
 * CPU：免费档每次调用 10 ms。抽 proxies（js-yaml）+ age 加密，一个 200 节点的源本地约 4 ms、1000 节点约 12 ms，
 * 几个源放一次调用里会超。所以绑了 SELF（本 Worker 的命名入口 ProxyRefresher）时，每个源各走一次服务绑定调用，
 * 各算各的 CPU；协调这一次只做抢锁、读列表、发调用、放锁。没绑 SELF（单测）就在本次调用里依次跑。
 */
import { acquire, release } from './lock.js';
import { getMeta, listSourcesFull, getSourceById, holdsLock, saveFetched, saveError, writeArmor, loadMap, saveUnmatched } from './store.js';
import { processNodes, FP_DEFAULT } from './nodes.js';
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

/** 机场源处理规则：映射词、丢弃词、指纹（meta fp，没有即 chrome） @param {any} env */
export async function airportRules(env) {
  const m = await loadMap(env);
  return { drop: m.drop, flags: m.flags, fp: (await getMeta(env, 'fp')) || FP_DEFAULT };
}

/** noFetch：机场源不拉，直接用 last_nodes_enc（改链接试拉成功后只重出成品） @param {any} env @param {any} row @param {CryptoKey} key @param {string} pubkey @param {number} now @param {string} owner @param {string} ua @param {typeof fetch} fetchFn @param {boolean} [noFetch] */
async function refreshOne(env, row, key, pubkey, now, owner, ua, fetchFn, noFetch = false) {
  let proxies = null;
  let error = null;
  if (row.type === 'airport' && !noFetch) {
    let url = null;
    try { url = await open(key, aad(row.id, 'url'), row.url_enc); } catch (e) { error = ERR.config; }
    if (url) {
      const got = await fetchAirport(url, ua, fetchFn);
      if (!got.ok) error = got.error;
      else {
        const ex = extractProxies(got.text, { links: true });
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
  let unmatched = 0;
  if (row.type === 'airport') {
    const r = processNodes(proxies, await airportRules(env));
    proxies = r.proxies;
    unmatched = r.unmatched.length;
    await saveUnmatched(env, row.id, unmatched);
  }
  const written = await publish(env, row, proxies, pubkey, now, owner);
  return { name: row.name, ok: !error, error, nodes: proxies.length, unmatched, stale: !!error, written };
}

/**
 * 刷新一个源（ProxyRefresher.refreshSource 调，或协调者在本次调用里直接调）。锁必须还在 owner 手里，否则什么都不做。
 * @param {any} env @param {string} id @param {string} owner @param {number} now @param {string} ua @param {typeof fetch} [fetchFn]
 */
export async function refreshSourceById(env, id, owner, now, ua, fetchFn = fetch, noFetch = false) {
  if (!(await holdsLock(env, owner, now))) return { ok: false, error: 'busy' };
  const row = await getSourceById(env, id);
  if (!row || Number(row.enabled) !== 1) return { ok: false, error: 'not-found' };
  const pubkey = await getMeta(env, 'pubkey');
  if (!pubkey) return { name: row.name, ok: false, error: ERR.noKey, nodes: 0 };
  let key;
  try { key = await importDbKey(await readDbKey(env)); } catch (e) { return { name: row.name, ok: false, error: ERR.config, nodes: 0 }; }
  return refreshOne(env, row, key, pubkey, now, owner, ua, fetchFn, noFetch);
}

/**
 * @param {any} env
 * @param {{ now?: number, fetchFn?: typeof fetch, ids?: string[], noFetch?: boolean, airports?: boolean }} [opts] ids：只刷这几个源；noFetch：不拉机场（改链接试拉后、改词 / 改指纹后用）；airports：只动机场源
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
    const noFetch = !!opts.noFetch;
    const rows = (await listSourcesFull(env)).filter((r) => Number(r.enabled) === 1 && (!opts.ids || opts.ids.indexOf(r.id) >= 0) && (!opts.airports || r.type === 'airport'));
    const ua = !noFetch && rows.some((r) => r.type === 'airport') ? await userAgent(env, now, fetchFn) : '';
    const self = env.SELF && typeof env.SELF.refreshSource === 'function' ? env.SELF : null;
    const settled = await Promise.allSettled(rows.map((r) => (self
      ? self.refreshSource(r.id, owner, now, ua, noFetch)
      : refreshOne(env, r, key, pubkey, now, owner, ua, fetchFn, noFetch))));
    const sources = settled.map((s, i) => (s.status === 'fulfilled' ? s.value : { name: rows[i].name, ok: false, error: ERR.config, nodes: 0 }));
    return { ok: true, sources };
  } finally {
    await release(env, owner);
  }
}
