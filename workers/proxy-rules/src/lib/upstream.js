/**
 * 依次试上游，第一个 2xx 就用。每个上游等响应头最多 UPSTREAM_TIMEOUT_MS，超时就换下一个
 * （只限等响应头；拿到响应后正文照常流式转发，不受这个超时影响）。
 */

/** 单个上游等响应头的上限（毫秒）：主上游挂住时换备用，而不是整个请求一直等 */
export const UPSTREAM_TIMEOUT_MS = 8000;
export const USER_AGENT = 'styrigx-proxy-rules/1.0';

/**
 * @param {string[]} urls
 * @param {{ method: string, cacheTtl: number }} opts
 * @returns {Promise<{ response: Response | null, status: number }>}  都失败时 status = 最后一个上游的状态码（网络错误 / 超时记 502）
 */
export async function fetchFirst(urls, { method, cacheTtl }) {
  let lastStatus = 502;
  for (const u of urls) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const r = await fetch(
        new Request(u, {
          method,
          headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
          redirect: 'follow',
          signal: ac.signal,
        }),
        { cf: { cacheTtl, cacheEverything: true } },
      );
      if (r.ok) return { response: r, status: r.status };
      lastStatus = r.status;
    } catch {
      lastStatus = 502;
    } finally {
      clearTimeout(timer);
    }
  }
  return { response: null, status: lastStatus };
}
