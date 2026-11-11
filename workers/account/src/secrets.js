/**
 * @fileoverview 账号 Worker：把 Secrets Store 绑定换成普通字符串（账号拆分 PR2，读法照搬网关 workers/space-core/src/secrets.js）。
 *
 * Secrets Store 绑定是对象，要 `await env.X.get()` 才拿到值；账号鉴权代码按字符串读 `env.X`。
 * 在每个请求开始时统一取一次，换成字符串后再交给后面的代码。
 *
 * - 已经是字符串的（本地测试、预览用普通 Secret）原样保留。
 * - 取值失败 → 该项留空字符串，由调用方按「未配置」处理（fail closed）；有失败的这一轮不缓存，下个请求重试。
 * - 同一个 isolate 内缓存 60 秒，减少调用；轮换密钥最多 60 秒生效。救援钥匙 SGX_ACCOUNT_RESCUE_KEY 不缓存，每个请求现取
 *   （定稿 §九「改完运行时即时生效」；Gray 2026-11-11 22:46：只它不缓存，其他保留 60 秒）。
 * - 绝不打印密钥值。
 */

/** 放在 Secrets Store 里的密钥（wrangler.toml 的 secrets_store_secrets，binding = secret_name）：
 *  账号密码 pepper（v6 唯一的密码 pepper）；
 *  救援钥匙 SGX_ACCOUNT_RESCUE_KEY（v6 P3，定稿 v5.2 §九：只读，Gray 在 dashboard 设值 / 换值，不缓存、即时生效）。
 *  v6 P4（定稿 v5.2 §十三）：账号侧旧恢复密钥与进站密码 pepper SGX_SPACE_PASSWORD_PEPPER 删除；
 *  账号签名钥匙对删除（定稿 v5.3 §十二）。 */
export const SECRET_NAMES = Object.freeze([
  'SGX_ACCOUNT_PASSWORD_PEPPER',
  'SGX_ACCOUNT_RESCUE_KEY',
]);

/** 不缓存的（每个请求现取） */
const UNCACHED = Object.freeze(['SGX_ACCOUNT_RESCUE_KEY']);
const TTL_MS = 60 * 1000;
let cache = null; /* { at: number, values: Record<string,string> } */

/** 测试用：清缓存 */
export function _resetSecretCache() { cache = null; }

function isStoreBinding(v) {
  return v != null && typeof v === 'object' && typeof v.get === 'function';
}

async function readOne(env, name) {
  const v = env[name];
  if (typeof v === 'string') return v;
  if (!isStoreBinding(v)) return undefined;
  try {
    const s = await v.get();
    return typeof s === 'string' ? s : '';
  } catch (e) {
    console.error('[sgx-account] secret read failed: ' + name);
    return '';
  }
}

/**
 * @param {Record<string, any>} env Worker 的 env
 * @param {number} [now]
 * @returns {Promise<Record<string, any>>} 新的 env（绑定原样，私密值换成字符串）
 */
export async function resolveSecrets(env, now = Date.now()) {
  const fresh = {};
  await Promise.all(UNCACHED.map(async (n) => {
    const s = await readOne(env, n);
    if (s !== undefined) fresh[n] = s;
  }));
  if (!cache || now - cache.at > TTL_MS) {
    const values = {};
    await Promise.all(SECRET_NAMES.filter((n) => UNCACHED.indexOf(n) === -1).map(async (n) => {
      const s = await readOne(env, n);
      if (s !== undefined) values[n] = s;
    }));
    /* 有取值失败的不缓存，下个请求重试 */
    const anyEmpty = Object.values(values).some(v => v === '');
    cache = anyEmpty ? null : { at: now, values };
    return Object.assign({}, env, values, fresh);
  }
  return Object.assign({}, env, cache.values, fresh);
}
