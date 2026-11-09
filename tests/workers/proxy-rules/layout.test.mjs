/**
 * 规则集反代 + 代理订阅 styrigx-proxy-rules：目录结构（workers/README.md 的骨架）。
 * index.js 只接线（默认 handler + 命名入口 ProxyAdmin）；来源一个文件一个；依赖只沿 index → app / rpc → router → api → core → lib；
 * 绑定只有 D1 D1_PROXY、Secrets Store SGX_PROXY_DB_KEY、自绑 SELF、限流 RL_SUB；公网没有管理 / 刷新路径。
 * 运行：node --test tests/workers/proxy-rules/*.test.mjs
 */
import '../account/_cf-workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../../workers/proxy-rules/', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const imports = (file) => [...strip(readFileSync(file, 'utf8')).matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
const OWN = (f) => !relative(SRC, f).startsWith('lib/vendor/');

test('文件清单：入口、路由、接口、命名入口、业务、通用件各在各的位置', () => {
  assert.deepEqual(walk(SRC).map((f) => relative(SRC, f)).sort(), [
    'api/healthz.js',
    'api/rules.js',
    'api/sub.js',
    'app.js',
    'core/sources.js',
    'core/sources/metacubex.js',
    'core/sources/own-repo.js',
    'core/sub/admin.js',
    'core/sub/airport.js',
    'core/sub/config.js',
    'core/sub/lock.js',
    'core/sub/parse.js',
    'core/sub/pipeline.js',
    'core/sub/store.js',
    'core/sub/ua.js',
    'index.js',
    'lib/aes.js',
    'lib/age.js',
    'lib/cache.js',
    'lib/content-type.js',
    'lib/http.js',
    'lib/response-headers.js',
    'lib/token.js',
    'lib/upstream.js',
    'lib/vendor/js-yaml.mjs',
    'router.js',
    'rpc/proxy-admin.js',
    'rpc/proxy-refresher.js',
    'secrets.js',
  ]);
});

test('index.js 只再导出 app.js 的默认 handler 和命名入口 ProxyAdmin', async () => {
  assert.deepEqual(strip(readFileSync(join(SRC, 'index.js'), 'utf8')).trim().split('\n').map((l) => l.trim()),
    ["export { default } from './app.js';", "export { ProxyAdmin } from './rpc/proxy-admin.js';", "export { ProxyRefresher } from './rpc/proxy-refresher.js';"]);
  const mod = await import('../../../workers/proxy-rules/src/index.js');
  const app = (await import('../../../workers/proxy-rules/src/app.js')).default;
  assert.equal(mod.default, app);
  assert.equal(typeof app.fetch, 'function');
  assert.equal(typeof app.scheduled, 'function');
  assert.equal(typeof mod.ProxyAdmin, 'function');
  assert.equal(typeof mod.ProxyRefresher, 'function');
});

test('依赖方向：只许相对 import（外加 cloudflare:workers、node:crypto）；lib/ 只 import lib/，core/ 不 import api / rpc / router / app', () => {
  for (const f of walk(SRC).filter(OWN)) {
    const rel = relative(SRC, f);
    for (const spec of imports(f)) {
      if (spec === 'cloudflare:workers') { assert.ok(rel.startsWith('rpc/'), `${rel}: cloudflare:workers 只在 rpc/`); continue; }
      if (spec === 'node:crypto') { assert.equal(rel, 'lib/age.js'); continue; }
      assert.ok(spec.startsWith('.'), `${rel}: 只许相对 import（${spec}）`);
      const target = relative(SRC, join(f, '..', spec));
      if (rel.startsWith('lib/')) assert.ok(target.startsWith('lib/'), `${rel} → ${target}`);
      if (rel.startsWith('core/')) assert.ok(target.startsWith('core/') || target.startsWith('lib/') || target === 'secrets.js', `${rel} → ${target}`);
      if (rel.startsWith('api/')) assert.ok(!['router.js', 'app.js', 'index.js'].includes(target) && !target.startsWith('rpc/'), `${rel} → ${target}`);
    }
  }
});

test('wrangler.toml：main 不变，nodejs_compat，6 小时 cron；绑定只有 D1_PROXY / SGX_PROXY_DB_KEY / SELF（自己的 ProxyRefresher）/ RL_SUB，没有 KV、变量', () => {
  const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8').replace(/^\s*#.*$/gm, '');
  assert.match(toml, /^name = "styrigx-proxy-rules"$/m);
  assert.match(toml, /^main = "src\/index\.js"$/m);
  assert.match(toml, /^compatibility_flags = \["nodejs_compat"\]$/m);
  assert.match(toml, /^crons = \["0 \*\/6 \* \* \*"\]$/m);
  assert.match(toml, /^workers_dev = false$/m);
  assert.match(toml, /^preview_urls = false$/m);
  assert.deepEqual([...toml.matchAll(/^(?:binding|name) = "([A-Z0-9_]+)"$/gm)].map((m) => m[1]), ['D1_PROXY', 'SGX_PROXY_DB_KEY', 'SELF', 'RL_SUB']);
  assert.match(toml, /\[\[services\]\]\s*binding = "SELF"\s*service = "styrigx-proxy-rules"\s*entrypoint = "ProxyRefresher"/);
  assert.equal([...toml.matchAll(/^\[\[services\]\]$/gm)].length, 1);
  assert.match(toml, /database_name = "styrigx-proxy"/);
  assert.match(toml, /database_id = "[0-9a-f-]{36}"/);
  for (const k of ['kv_namespaces', 'r2_buckets', 'vars', 'durable_objects', 'queues', 'env'])
    assert.ok(!new RegExp(`^\\[+${k}\\b`, 'm').test(toml), k);
});

test('迁移：一个基线文件，三张表，预置锁行；没有 nodes 表（成品在 sources 行里，设计 v1.7）', () => {
  assert.deepEqual(readdirSync(join(ROOT, 'migrations')), ['0001_init.sql']);
  const sql = readFileSync(join(ROOT, 'migrations/0001_init.sql'), 'utf8');
  assert.deepEqual([...sql.matchAll(/^CREATE TABLE (\w+)/gm)].map((m) => m[1]), ['meta', 'sources', 'lock']);
  assert.match(sql, /INSERT INTO lock \(id, owner, expires\) VALUES \(1, NULL, 0\);/);
});
