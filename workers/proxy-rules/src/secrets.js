/**
 * 读 Secrets Store 绑定 SGX_PROXY_DB_KEY（只在刷新、加 / 改来源时要；下载不读）。
 * 绑定是对象（await env.X.get()）；本地测试直接给字符串。读不到 → 空串，由调用方当「未配置」处理（fail closed）。绝不打印值。
 */
export const DB_KEY = 'SGX_PROXY_DB_KEY';

/** @param {Record<string, any>} env @returns {Promise<string>} */
export async function readDbKey(env) {
  const v = env && env[DB_KEY];
  if (typeof v === 'string') return v;
  if (v && typeof v.get === 'function') {
    try {
      const s = await v.get();
      return typeof s === 'string' ? s : '';
    } catch (e) {
      console.error('[proxy-rules] secret read failed: ' + DB_KEY);
      return '';
    }
  }
  return '';
}
