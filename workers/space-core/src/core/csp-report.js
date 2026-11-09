/**
 * @fileoverview 主站 Report-Only CSP 的违规报告接收口（2026-11-09）：只打日志，返回 204，不存任何东西。
 *
 * 浏览器按 lib/security-headers.js 里 Content-Security-Policy-Report-Only 的 report-uri / report-to（Reporting-Endpoints）
 * 往 POST /api/csp-report 发违规报告：
 *   - 旧格式（report-uri）：Content-Type application/csp-report，正文 { "csp-report": { … } }
 *   - 新格式（Reporting API）：Content-Type application/reports+json，正文 [{ type: 'csp-violation', body: { … } }, …]
 *
 * 只读、只记日志（Workers Logs 看），不写 D1 / KV / R2，不调别的服务，不经主站关口（未进门的锁屏页也会报）。
 * 防刷：不碰 ANON_LIMITER（不占锁屏接口的配额）；每个请求的工作量有上限——正文最多读 MAX_BODY 字节（超了直接丢），
 * 一个请求最多记 MAX_REPORTS 条，每个字段截到 MAX_FIELD 个字符；不论正文是什么都回 204（不给探测面）。
 * 强制 CSP 不变：这里只接 Report-Only 的报告。
 */

export const CSP_REPORT_PATH = '/api/csp-report';
export const MAX_BODY = 16 * 1024;
export const MAX_REPORTS = 5;
export const MAX_FIELD = 200;

/** 记日志的字段（新格式驼峰名 → 旧格式连字符名） */
const FIELDS = Object.freeze([
  ['effectiveDirective', 'effective-directive'],
  ['blockedURL', 'blocked-uri'],
  ['documentURL', 'document-uri'],
  ['sourceFile', 'source-file'],
  ['lineNumber', 'line-number'],
  ['columnNumber', 'column-number'],
  ['disposition', 'disposition'],
  ['sample', 'script-sample'],
]);

/** @param {URL} url */
export function isCspReportPath(url) {
  return url.pathname === CSP_REPORT_PATH;
}

/** 去掉查询串和片段（地址里可能带 ?return= 之类），截长度 @param {any} v */
function clip(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  let s = String(v);
  if (/^https?:\/\//i.test(s)) s = s.replace(/[?#].*$/, '');
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + '…' : s;
}

/**
 * 正文 → 规整后的报告列表（最多 MAX_REPORTS 条）。认不出的返回 []。
 * @param {any} data
 * @returns {Array<Record<string, string|number>>}
 */
export function normalizeReports(data) {
  /** @type {any[]} */
  let raw = [];
  if (Array.isArray(data)) raw = data.filter((r) => r && typeof r === 'object' && (!r.type || r.type === 'csp-violation')).map((r) => r.body);
  else if (data && typeof data === 'object' && data['csp-report']) raw = [data['csp-report']];
  const out = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue;
    /** @type {Record<string, string|number>} */
    const r = {};
    for (const [k, legacy] of FIELDS) {
      const v = clip(b[k] !== undefined ? b[k] : b[legacy]);
      if (v !== undefined) r[k] = v;
    }
    if (Object.keys(r).length) out.push(r);
    if (out.length >= MAX_REPORTS) break;
  }
  return out;
}

/** 读正文，最多 MAX_BODY 字节；超了返回 null（不读完） @param {Request} request */
async function readCapped(request) {
  const len = Number(request.headers.get('Content-Length') || '0');
  if (len > MAX_BODY) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) { try { await reader.cancel(); } catch (e) {} return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

const NO_CONTENT_HEADERS = Object.freeze({ 'Cache-Control': 'no-store' });

/**
 * POST /api/csp-report：记日志，204。别的方法 405（Allow: POST）。永不抛错。
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function handleCspReport(request) {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { ...NO_CONTENT_HEADERS, Allow: 'POST' } });
  }
  try {
    const text = await readCapped(request);
    if (text === null) {
      console.log('[csp-report] dropped: body over ' + MAX_BODY + ' bytes');
    } else if (text) {
      const reports = normalizeReports(JSON.parse(text));
      for (const r of reports) console.log('[csp-report] ' + JSON.stringify(r));
    }
  } catch (e) {
    console.log('[csp-report] unreadable report');
  }
  return new Response(null, { status: 204, headers: NO_CONTENT_HEADERS });
}
