/**
 * @fileoverview styrigx-ai 的 HTTP 小工具：JSON 错误响应、SSE 响应头、SSE 事件编码。和业务无关。
 */

export const NO_STORE = 'private, no-store';

/**
 * @param {number} status
 * @param {any} body
 * @param {Record<string, string>} [headers]
 */
export function json(status, body, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': NO_STORE, 'X-Content-Type-Options': 'nosniff', ...(headers || {}) },
  });
}

/** @param {number} status @param {string} code */
export function apiError(status, code) {
  return json(status, { ok: false, error: code });
}

/** SSE 响应头（不缓存、不嗅探；X-Accel-Buffering 让中间层别攒包） */
export const SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': NO_STORE,
  'X-Content-Type-Options': 'nosniff',
  'X-Accel-Buffering': 'no',
});

const enc = new TextEncoder();

/**
 * 一条 SSE 事件：`event: <名字>\ndata: <JSON>\n\n`。
 * @param {string} event @param {any} data
 * @returns {Uint8Array}
 */
export function sseEvent(event, data) {
  return enc.encode('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
}

/**
 * 逐个吐出上游 SSE 的 data 字段（多行 data 用 \n 拼起来）。兼容 \n / \r\n 分隔。
 * 收的是 reader（不是流本身）：调用方留着它，浏览器断开时 reader.cancel() 一起断上游。
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @returns {AsyncGenerator<string>}
 */
export async function* sseData(reader) {
  const dec = new TextDecoder();
  let buf = '';
  /** @param {string} block */
  const dataOf = (block) => {
    const lines = block.split(/\r?\n/).filter((l) => l.startsWith('data:'));
    if (!lines.length) return null;
    return lines.map((l) => l.slice(5).replace(/^ /, '')).join('\n');
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let m;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const d = dataOf(block);
        if (d != null) yield d;
      }
    }
    buf += dec.decode();
    const d = dataOf(buf);
    if (d != null && d.trim()) yield d;
  } finally {
    try { reader.releaseLock(); } catch (e) {}
  }
}
