/**
 * @fileoverview 鉴权 Worker：把 Secrets Store 绑定换成普通字符串。
 *
 * Secrets Store 绑定是对象，要 `await env.X.get()` 才拿到值；
 * functions/ 里的代码全按 Pages 的写法直接读 `env.X` 字符串。
 * 这里在每个请求开始时统一取一次，换成字符串后再交给原代码，原代码一行不改。
 *
 * - 已经是字符串的（本地测试、或以后改回普通 Secret）原样保留。
 * - 取值失败 → 该项留空字符串，由原代码按「未配置」处理（fail closed）。
 * - 同一个 isolate 内缓存 60 秒，减少调用；轮换密钥最多 60 秒生效。
 * - 绝不打印密钥值。
 */

/** 放在 Secrets Store 里的 6 个私密值（名字与 Pages 上一致） */
export const SECRET_NAMES = Object.freeze([
  'SGX_LOCK_PRIVATE',
  'SGX_STEPUP_PRIVATE',
  'SGX_APP_PRIVATE',
  'SGX_ROOT_KEY',
  'SGX_PW_PEPPER',
  'TURNSTILE_SECRET',
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
    console.error('[sgx-auth] secret read failed: ' + name);
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
