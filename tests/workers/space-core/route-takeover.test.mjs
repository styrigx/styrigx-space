/**
 * space/scripts/route-takeover.mjs（进站 v3 L2 第一次部署 styrigx-space-core 时把 styrigx.com 的路由从旧 Worker 挪过来）。
 * 纯函数（plan / verify / restore 计划）+ 用本机假 Cloudflare API 跑一遍 takeover → verify → restore 的完整流程。
 * 运行：node --test tests/workers/space-core/route-takeover.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(REPO, 'space/scripts/route-takeover.mjs');
const RT = await import(SCRIPT);

const BEFORE = () => [
  { id: 'r1', pattern: 'styrigx.com/*', script: 'styrigx-auth-gateway' },
  { id: 'r2', pattern: 'styrigx.com/s/*', script: 'styrigx-share' },
  { id: 'r3', pattern: 'styrigx.com/api/share*', script: 'styrigx-share' },
  { id: 'r4', pattern: 'styrigx.com/curio/api/*', script: 'styrigx-curio-core' },
  { id: 'r5', pattern: 'styrigx.com/daymark/api/*', script: 'styrigx-daymark-core' },
];

test('plan：旧网关挂着 styrigx.com/*、短链两条还在 → needed；都已经归 styrigx-space-core 且没有短链两条 → 不用动', () => {
  const p = RT.planOf(BEFORE());
  assert.equal(p.needed, true);
  assert.equal(p.main.id, 'r1');
  assert.deepEqual(p.share.map((r) => r.id), ['r2', 'r3']);
  assert.deepEqual(p.errors, []);
  const done = [{ id: 'r1', pattern: 'styrigx.com/*', script: 'styrigx-space-core' }, BEFORE()[3]];
  assert.equal(RT.planOf(done).needed, false);
  assert.deepEqual(RT.verifyRoutes(done), []);
});

test('plan：路由挂在不认识的 Worker 上 → 报错，不动手', () => {
  const r = BEFORE();
  r[0].script = 'someone-else';
  assert.ok(RT.planOf(r).errors.length > 0);
});

test('verify：styrigx.com/* 不在 / 挂错 / 短链两条还在 → 报错', () => {
  assert.ok(RT.verifyRoutes(BEFORE()).length >= 3);
  assert.ok(RT.verifyRoutes([]).some((e) => e.includes('正好一条')));
});

test('restorePlan：只还原原来挂在旧 Worker 上的', () => {
  const p = RT.planOf(BEFORE());
  assert.deepEqual(RT.restorePlan({ main: p.main, share: p.share }), {
    main: { pattern: 'styrigx.com/*', script: 'styrigx-auth-gateway' },
    share: [{ pattern: 'styrigx.com/s/*', script: 'styrigx-share' }, { pattern: 'styrigx.com/api/share*', script: 'styrigx-share' }],
  });
  assert.deepEqual(RT.restorePlan({ main: { pattern: 'styrigx.com/*', script: 'styrigx-space-core' }, share: [] }), { main: null, share: [] });
});

/** 假 Cloudflare API：一个区域、一张路由表 */
function fakeCf(routes) {
  const log = [];
  let n = 100;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (result, ok = true, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: ok, errors: ok ? [] : [{ code: 10000, message: 'bad' }], result }));
      };
      if (req.headers.authorization !== 'Bearer t') return send(null, false, 403);
      const u = new URL(req.url, 'http://x');
      log.push(req.method + ' ' + u.pathname);
      if (req.method === 'GET' && u.pathname === '/zones') return send([{ id: 'a'.repeat(32), name: u.searchParams.get('name') }]);
      const base = '/zones/' + 'a'.repeat(32) + '/workers/routes';
      if (req.method === 'GET' && u.pathname === base) return send(routes);
      if (req.method === 'POST' && u.pathname === base) { const r = JSON.parse(body); routes.push({ id: 'n' + (n++), ...r }); return send({}); }
      const m = u.pathname.startsWith(base + '/') ? u.pathname.slice(base.length + 1) : null;
      const i = routes.findIndex((r) => r.id === m);
      if (i < 0) return send(null, false, 404);
      if (req.method === 'PUT') { routes[i] = { id: m, ...JSON.parse(body) }; return send({}); }
      if (req.method === 'DELETE') { routes.splice(i, 1); return send({}); }
      return send(null, false, 405);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, log, base: 'http://127.0.0.1:' + server.address().port })));
}

function run(base, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, CLOUDFLARE_API_TOKEN: 't', CF_API_BASE: base, GITHUB_OUTPUT: '' } });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { out += c; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('takeover → verify → restore：先改 styrigx.com/* 再删短链两条；回退把三条原样还给旧 Worker；子站接口路由不动', async () => {
  const routes = BEFORE();
  const cf = await fakeCf(routes);
  const state = path.join(mkdtempSync(path.join(tmpdir(), 'rt-')), 'state.json');
  try {
    assert.equal((await run(cf.base, ['verify'])).code, 1, '接管前 verify 不过');
    const t = await run(cf.base, ['takeover', '--state', state]);
    assert.equal(t.code, 0, t.out);
    const writes = cf.log.filter((l) => !l.startsWith('GET'));
    assert.deepEqual(writes, ['PUT /zones/' + 'a'.repeat(32) + '/workers/routes/r1', 'DELETE /zones/' + 'a'.repeat(32) + '/workers/routes/r2', 'DELETE /zones/' + 'a'.repeat(32) + '/workers/routes/r3']);
    assert.deepEqual(routes.map((r) => r.pattern + '>' + r.script), ['styrigx.com/*>styrigx-space-core', 'styrigx.com/curio/api/*>styrigx-curio-core', 'styrigx.com/daymark/api/*>styrigx-daymark-core']);
    assert.equal(JSON.parse(readFileSync(state, 'utf8')).main.script, 'styrigx-auth-gateway');
    assert.equal((await run(cf.base, ['verify'])).code, 0);
    const p2 = await run(cf.base, ['plan']);
    assert.match(p2.out, /already belong/);
    const r = await run(cf.base, ['restore', '--state', state]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(routes.map((x) => x.pattern + '>' + x.script).sort(), BEFORE().map((x) => x.pattern + '>' + x.script).sort());
    assert.doesNotMatch(t.out + r.out, /Bearer|\bt\b token/);
  } finally {
    cf.server.close();
  }
});
