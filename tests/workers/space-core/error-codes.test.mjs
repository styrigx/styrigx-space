/**
 * 服务端 error 码静态核对（tests/kernel）：错误码登记表（workers/space-core/src/lib/http.js ERROR_CODES）与各 Worker 实际返回的码 / 状态一致。
 * v6 P4 起旧进站前端的 ERR_KEY 映射核对删了（定稿 v5.2 §十三 P4）。
 *
 * 运行：node --test tests/workers/space-core/error-codes.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function read(p) {
  return readFileSync(join(ROOT, p), 'utf8');
}

/* v6 P4（定稿 v5.2 §十三 P4）：旧进站前端（shell/space/api.js 的 ERR_KEY / NEED_VERIFY_CODES）随旧会话删了，「服务端码 ↔ 前端映射」三条核对一起删；下面的错误码登记表核对照旧。 */

/* ---------- 错误码登记表（workers/space-core/src/lib/http.js ERROR_CODES） ---------- */

/** 网关 src/、账号 / 分享 Worker 里每个带 HTTP 状态的错误码：apiError(S,'c')、{status:S, body:{ok:false,error:'c'}}、json(S,{ok:false,error:'c'}) */
function extractCodeStatusPairs() {
  const dirs = ['workers/space-core/src', 'workers/account/src'];
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      const p = d + '/' + e.name;
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js') && p !== 'workers/space-core/src/lib/http.js') files.push(p);
    }
  };
  dirs.forEach(walk);
  const pairs = [];
  for (const f of files) {
    const src = read(f);
    const res = [
      /apiError\(\s*(\d+)\s*,\s*'([a-z][a-z0-9_-]*)'/g,
      /status:\s*(\d+),\s*body:\s*\{\s*ok:\s*false,\s*error:\s*'([a-z][a-z0-9_-]*)'/g,
      /json\(\s*(\d+)\s*,\s*\{\s*ok:\s*false,\s*error:\s*'([a-z][a-z0-9_-]*)'/g,
    ];
    for (const re of res) for (const m of src.matchAll(re)) pairs.push({ file: f, status: Number(m[1]), code: m[2] });
  }
  return pairs;
}

test('错误码登记表：每个返回的错误码都登记在 ERROR_CODES，HTTP 状态也在登记范围内', async () => {
  const { ERROR_CODES } = await import(join(ROOT, 'workers/space-core/src/lib/http.js'));
  const pairs = extractCodeStatusPairs();
  assert.ok(pairs.length > 150, '应提取到一批错误响应，实际 ' + pairs.length);
  const bad = pairs.filter((p) => !Object.prototype.hasOwnProperty.call(ERROR_CODES, p.code) || !ERROR_CODES[p.code].includes(p.status));
  assert.deepEqual(bad, [], '新错误码或新状态要先登记到 workers/space-core/src/lib/http.js ERROR_CODES');
  /* 登记表里没有用不到的码 */
  const used = new Set(pairs.map((p) => p.code));
  assert.deepEqual(Object.keys(ERROR_CODES).filter((c) => !used.has(c)), []);
});

test('json() / apiError()：默认头、Set-Cookie 原样保留、错误体字段顺序', async () => {
  const { json, apiError, NO_STORE } = await import(join(ROOT, 'workers/space-core/src/lib/http.js'));
  const r = json(200, { ok: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'application/json');
  assert.equal(r.headers.get('Cache-Control'), NO_STORE);
  assert.equal(await r.text(), '{"ok":true}');
  const h = new Headers();
  h.append('Set-Cookie', 'a=1; Path=/');
  h.append('Set-Cookie', 'b=2; Path=/');
  const r2 = json(200, { ok: true }, h);
  assert.deepEqual(r2.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
  const r3 = apiError(403, 'reauth', { reason: 'expired' }, { 'Cache-Control': 'no-store' });
  assert.equal(r3.status, 403);
  assert.equal(r3.headers.get('Cache-Control'), 'no-store');
  assert.equal(await r3.text(), '{"ok":false,"error":"reauth","reason":"expired"}');
});

test('clientIp()：只认 CF-Connecting-IP，不认 X-Forwarded-For', async () => {
  const { clientIp } = await import(join(ROOT, 'workers/space-core/src/lib/http.js'));
  assert.equal(clientIp(new Request('https://x/', { headers: { 'CF-Connecting-IP': '203.0.113.9', 'X-Forwarded-For': '1.2.3.4' } })), '203.0.113.9');
  assert.equal(clientIp(new Request('https://x/', { headers: { 'X-Forwarded-For': '1.2.3.4' } })), 'unknown');
  assert.equal(clientIp(new Request('https://x/')), 'unknown');
});
