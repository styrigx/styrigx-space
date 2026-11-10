/**
 * @fileoverview 账号 Worker：把 Secrets Store 绑定换成普通字符串（账号拆分 PR2，读法照搬网关 workers/space-core/src/secrets.js）。
 *
 * Secrets Store 绑定是对象，要 `await env.X.get()` 才拿到值；账号鉴权代码按字符串读 `env.X`。
 * 在每个请求开始时统一取一次，换成字符串后再交给后面的代码。
 *
 * - 已经是字符串的（本地测试、预览用普通 Secret）原样保留。
 * - 取值失败 → 该项留空字符串，由调用方按「未配置」处理（fail closed）；有失败的这一轮不缓存，下个请求重试。
 * - 同一个 isolate 内缓存 60 秒，减少调用；轮换密钥最多 60 秒生效。
 * - 绝不打印密钥值。
 */

/** 放在 Secrets Store 里的密钥（wrangler.toml 的 secrets_store_secrets，binding = secret_name）：
 *  票的签名钥匙一对、恢复密钥、账号密码 pepper（这四个只绑在账号 Worker）；
 *  进站密码 pepper SGX_SPACE_PASSWORD_PEPPER（v6 P2 pepper 方案 a：网关也绑着；账号只用来验 pepper_id = space 的旧哈希，P4 删）。 */
export const SECRET_NAMES = Object.freeze([
  'SGX_ACCOUNT_PRIVATE',
  'SGX_ACCOUNT_PUBLIC',
  'SGX_ACCOUNT_RECOVERY_KEY',
  'SGX_ACCOUNT_PASSWORD_PEPPER',
  'SGX_SPACE_PASSWORD_PEPPER',
]);

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
  if (!cache || now - cache.at > TTL_MS) {
    const values = {};
    await Promise.all(SECRET_NAMES.map(async (n) => {
      const s = await readOne(env, n);
      if (s !== undefined) values[n] = s;
    }));
    /* 有取值失败的不缓存，下个请求重试 */
    const anyEmpty = Object.values(values).some(v => v === '');
    cache = anyEmpty ? null : { at: now, values };
    return Object.assign({}, env, values);
  }
  return Object.assign({}, env, cache.values);
}
