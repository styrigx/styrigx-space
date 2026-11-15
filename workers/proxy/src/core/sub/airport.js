/**
 * 拉一个机场订阅：15 秒超时、2 MB 上限、只认 2xx；不跟随到非 https。错误只回类别。
 */
import { ERR, FETCH_TIMEOUT_MS, MAX_BYTES } from './config.js';

/**
 * @param {string} url @param {string} ua @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ ok: true, text: string } | { ok: false, error: string }>}
 */
export async function fetchAirport(url, ua, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(url, { headers: { 'user-agent': ua, accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    return { ok: false, error: ERR.fetch };
  }
  if (!res.ok) return { ok: false, error: ERR.status };
  try {
    if (res.url && new URL(res.url).protocol !== 'https:') return { ok: false, error: ERR.fetch };
  } catch (e) { /* 没有 url 就不查 */ }
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) return { ok: false, error: ERR.size };
  if (!res.body) return { ok: false, error: ERR.format };
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { try { await reader.cancel(); } catch (e) { /* ignore */ } return { ok: false, error: ERR.size }; }
      chunks.push(value);
    }
  } catch (e) {
    return { ok: false, error: ERR.fetch };
  }
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return { ok: true, text: new TextDecoder().decode(buf) };
}

/** 只收 https 链接，回主机名；不对 → null @param {unknown} s */
export function airportHost(s) {
  if (typeof s !== 'string' || s.length > 2048) return null;
  try {
    const u = new URL(s.trim());
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
    return u.hostname;
  } catch (e) {
    return null;
  }
}
