/**
 * Report-Only CSP 的报告接收口（workers/space-core/src/core/csp-report.js，2026-11-09）：
 * - POST /api/csp-report：旧格式（application/csp-report）和 Reporting API（application/reports+json）都认，console.log 一行一条，回 204
 * - 不经主站关口（没会话也 204，不 302 锁屏）；不碰 env 里任何绑定（不写 D1 / KV、不读密钥、不用 ANON_LIMITER）
 * - 工作量有上限：正文超 16KB 直接丢、一次最多 5 条、字段截 200 字、地址去掉查询串；怪正文也 204
 * - GET 等别的方法 405；响应带主站全套安全头
 *
 * 运行：node --test tests/workers/space-core/csp-report.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const worker = (await import(REPO + '/workers/space-core/src/app.js')).default;
const CR = await import(REPO + '/workers/space-core/src/core/csp-report.js');
const SH = await import(REPO + '/workers/space-core/src/lib/security-headers.js');

/** 任何绑定被读到就记下来（报告接口不该碰 env） */
function trapEnv() {
  const touched = [];
  const env = new Proxy({}, { get(_t, k) { if (typeof k === 'string') touched.push(k); return undefined; } });
  return { env, touched };
}
const CTX = { waitUntil() {} };

async function capture(fn) {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try { return { res: await fn(), logs }; } finally { console.log = orig; }
}

function post(body, type, extra = {}) {
  return new Request('https://styrigx.com/api/csp-report', {
    method: 'POST',
    headers: { 'Content-Type': type, ...extra },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('旧格式 application/csp-report：204、记一行、地址去掉查询串；不经关口、不碰 env', async () => {
  const { env, touched } = trapEnv();
  const { res, logs } = await capture(() => worker.fetch(post({ 'csp-report': {
    'document-uri': 'https://styrigx.com/status/?return=%2Fchat%2F',
    'blocked-uri': 'https://evil.example/x.js?token=abc',
    'effective-directive': 'script-src-elem',
    'source-file': 'https://styrigx.com/',
    'line-number': 12,
    disposition: 'report',
  } }, 'application/csp-report'), env, CTX));
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(touched, [], '不碰任何绑定');
  const lines = logs.filter((l) => l.startsWith('[csp-report] {'));
  assert.equal(lines.length, 1);
  const r = JSON.parse(lines[0].slice('[csp-report] '.length));
  assert.equal(r.effectiveDirective, 'script-src-elem');
  assert.equal(r.blockedURL, 'https://evil.example/x.js');
  assert.equal(r.documentURL, 'https://styrigx.com/status/');
  assert.equal(r.lineNumber, 12);
  assert.equal(r.disposition, 'report');
  /* 主站全套安全头（包括 Reporting-Endpoints） */
  for (const [k, v] of SH.mainSiteHeaderList()) assert.equal(res.headers.get(k), v, k);
  assert.equal(res.headers.get('X-SGX-Runtime'), 'worker');
});

test('Reporting API application/reports+json：只记 csp-violation，最多 5 条，字段截 200 字', async () => {
  const one = (i) => ({ type: 'csp-violation', url: 'https://styrigx.com/', body: { documentURL: 'https://styrigx.com/', blockedURL: 'inline', effectiveDirective: 'script-src-elem', sample: 'x'.repeat(500), lineNumber: i } });
  const body = [{ type: 'deprecation', body: { id: 'x' } }].concat(Array.from({ length: 8 }, (_, i) => one(i)));
  const { env, touched } = trapEnv();
  const { res, logs } = await capture(() => worker.fetch(post(body, 'application/reports+json'), env, CTX));
  assert.equal(res.status, 204);
  assert.deepEqual(touched, []);
  const lines = logs.filter((l) => l.startsWith('[csp-report] {'));
  assert.equal(lines.length, CR.MAX_REPORTS);
  const r = JSON.parse(lines[0].slice('[csp-report] '.length));
  assert.equal(r.lineNumber, 0);
  assert.equal(r.sample.length, CR.MAX_FIELD + 1, '截到 200 字 + 省略号');
});

test('正文超 16KB：不解析、204、只记一行 dropped（Content-Length 声明的和实际读到的都算）', async () => {
  const big = JSON.stringify({ 'csp-report': { 'blocked-uri': 'x'.repeat(CR.MAX_BODY + 10) } });
  for (const req of [post(big, 'application/csp-report'), post(big, 'application/csp-report', { 'Content-Length': String(big.length) })]) {
    const { res, logs } = await capture(() => worker.fetch(req, trapEnv().env, CTX));
    assert.equal(res.status, 204);
    assert.equal(logs.filter((l) => l.startsWith('[csp-report] {')).length, 0);
    assert.ok(logs.some((l) => /dropped: body over 16384 bytes/.test(l)));
  }
});

test('怪正文（不是 JSON、空、认不出的结构）：都 204，不抛', async () => {
  for (const b of ['not json', '', '{"x":1}', '[1,2,3]', 'null']) {
    const { res } = await capture(() => worker.fetch(post(b, 'application/csp-report'), trapEnv().env, CTX));
    assert.equal(res.status, 204, JSON.stringify(b));
  }
  assert.deepEqual(CR.normalizeReports({ x: 1 }), []);
  assert.deepEqual(CR.normalizeReports(null), []);
});

test('GET / PUT：405 Allow: POST，仍带安全头；路径只认精确的 /api/csp-report', async () => {
  for (const m of ['GET', 'PUT']) {
    const res = await worker.fetch(new Request('https://styrigx.com/api/csp-report', { method: m }), trapEnv().env, CTX);
    assert.equal(res.status, 405, m);
    assert.equal(res.headers.get('Allow'), 'POST');
    assert.equal(res.headers.get('Content-Security-Policy'), SH.CSP_ENFORCED);
  }
  assert.equal(CR.isCspReportPath(new URL('https://styrigx.com/api/csp-report')), true);
  assert.equal(CR.isCspReportPath(new URL('https://styrigx.com/api/csp-report/')), false);
  assert.equal(CR.isCspReportPath(new URL('https://styrigx.com/API/csp-report')), false);
  assert.equal(CR.isCspReportPath(new URL('https://styrigx.com/api/csp-reportx')), false);
});

test('报告地址和 security-headers.js 里的 report-uri / Reporting-Endpoints 一致；强制 CSP 不变', () => {
  assert.equal(CR.CSP_REPORT_PATH, SH.CSP_REPORT_PATH);
  assert.match(SH.CSP_REPORT_ONLY, /; report-uri \/api\/csp-report; report-to csp-endpoint$/);
  assert.equal(SH.CSP_ENFORCED, "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'");
});
