/**
 * space/scripts/verify-core-routes.mjs（deploy-space-core 部署后只读核对 styrigx.com 的 Worker 路由）。
 * 纯函数 verifyRoutes + 用本机假 Cloudflare API 跑一遍脚本（只读：只发 GET）。
 * 运行：node --test tests/workers/space-core/verify-core-routes.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(REPO, 'space/scripts/verify-core-routes.mjs');
const VR = await import(SCRIPT);

const GOOD = () => [
  { id: 'r1', pattern: 'styrigx.com/*', script: 'styrigx-space-core' },
  { id: 'r4', pattern: 'styrigx.com/curio/api/*', script: 'styrigx-curio-core' },
  { id: 'r5', pattern: 'styrigx.com/daymark/api/*', script: 'styrigx-daymark-core' },
];

test('verifyRoutes：styrigx.com/* 归 styrigx-space-core、没有短链两条 → 没有错误；子站接口路由不管', () => {
  assert.deepEqual(VR.verifyRoutes(GOOD()), []);
});

test('verifyRoutes：styrigx.com/* 不在 / 挂错 / 有两条 / 短链路由回来了 → 报错', () => {
  assert.ok(VR.verifyRoutes([]).some((e) => e.includes('正好一条')));
  const wrong = GOOD(); wrong[0].script = 'someone-else';
  assert.ok(VR.verifyRoutes(wrong).some((e) => e.includes('someone-else')));
  assert.ok(VR.verifyRoutes(GOOD().concat([{ id: 'x', pattern: 'styrigx.com/*', script: 'styrigx-space-core' }])).length > 0);
  for (const p of VR.SHARE_PATTERNS) {
    assert.ok(VR.verifyRoutes(GOOD().concat([{ id: 'y', pattern: p, script: 'styrigx-space-core' }])).some((e) => e.includes(p)));
  }
});

test('脚本不再认旧 Worker、不导出接管 / 还原', () => {
  assert.equal(VR.planOf, undefined);
  assert.equal(VR.restorePlan, undefined);
  assert.equal(VR.OLD_SCRIPTS, undefined);
});

/** 假 Cloudflare API：一个区域、一张路由表；记下每个请求 */
function fakeCf(routes) {
  const log = [];
  const server = http.createServer((req, res) => {
    const send = (result, ok = true, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: ok, errors: ok ? [] : [{ code: 10000, message: 'bad' }], result }));
    };
    if (req.headers.authorization !== 'Bearer t') return send(null, false, 403);
    const u = new URL(req.url, 'http://x');
    log.push(req.method + ' ' + u.pathname);
    if (req.method === 'GET' && u.pathname === '/zones') return send([{ id: 'a'.repeat(32), name: u.searchParams.get('name') }]);
    if (req.method === 'GET' && u.pathname === '/zones/' + 'a'.repeat(32) + '/workers/routes') return send(routes);
    return send(null, false, 405);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, log, base: 'http://127.0.0.1:' + server.address().port })));
}

function run(base) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT], { env: { ...process.env, CLOUDFLARE_API_TOKEN: 't', CF_API_BASE: base } });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { out += c; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('脚本：路由对 → 0；短链路由还在 → 1；只发 GET，不打印 token', async () => {
  const routes = GOOD();
  const cf = await fakeCf(routes);
  try {
    const ok = await run(cf.base);
    assert.equal(ok.code, 0, ok.out);
    routes.push({ id: 'r2', pattern: 'styrigx.com/s/*', script: 'styrigx-space-core' });
    const bad = await run(cf.base);
    assert.equal(bad.code, 1, bad.out);
    assert.ok(cf.log.every((l) => l.startsWith('GET ')), cf.log.join(','));
    assert.doesNotMatch(ok.out + bad.out, /Bearer/);
  } finally {
    cf.server.close();
  }
});
