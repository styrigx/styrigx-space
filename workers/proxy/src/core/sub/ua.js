/**
 * 拉机场时的 User-Agent：mihomo/<最新版本>。只在上次核对超过 24 小时才问 GitHub；失败沿用上次（起始 1.19.33）。
 */
import { getMeta, setMeta } from './store.js';
import { UA_DEFAULT, UA_CHECK_MS } from './config.js';

const VER_RE = /^v?(\d{1,3}\.\d{1,3}\.\d{1,3})$/;

/** @param {any} env @param {number} now @param {typeof fetch} [fetchFn] @returns {Promise<string>} */
export async function userAgent(env, now, fetchFn = fetch) {
  let ver = (await getMeta(env, 'ua')) || UA_DEFAULT;
  const checked = Number((await getMeta(env, 'ua_checked')) || 0);
  if (now - checked > UA_CHECK_MS) {
    try {
      const r = await fetchFn('https://api.github.com/repos/MetaCubeX/mihomo/releases/latest', {
        headers: { 'user-agent': 'styrigx-proxy', accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const m = VER_RE.exec(String((await r.json()).tag_name || ''));
        if (m) { ver = m[1]; await setMeta(env, 'ua', ver); }
      }
    } catch (e) { /* 沿用 */ }
    await setMeta(env, 'ua_checked', String(now));
  }
  return 'mihomo/' + ver;
}
