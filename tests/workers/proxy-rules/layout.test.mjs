/**
 * 规则集反代 styrigx-proxy-rules：目录结构（workers/README.md 的骨架）。
 * index.js 只接线；来源一个文件一个；lib/ 只 import lib/；还没有订阅之类的代码、绑定、变量。
 * 运行：node --test tests/workers/proxy-rules/*.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import worker from '../../../workers/proxy-rules/src/index.js';
import app from '../../../workers/proxy-rules/src/app.js';

const ROOT = new URL('../../../workers/proxy-rules/', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const imports = (file) => [...strip(readFileSync(file, 'utf8')).matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);

test('文件清单：入口、路由、接口、来源、通用件各在各的位置', () => {
  assert.deepEqual(walk(SRC).map((f) => relative(SRC, f)).sort(), [
    'api/healthz.js',
    'api/rules.js',
    'app.js',
    'core/sources.js',
    'core/sources/metacubex.js',
    'core/sources/own-repo.js',
    'index.js',
    'lib/cache.js',
    'lib/content-type.js',
    'lib/http.js',
    'lib/response-headers.js',
    'lib/upstream.js',
    'router.js',
  ]);
});

test('index.js 只再导出 app.js 的默认 handler', () => {
  assert.equal(strip(readFileSync(join(SRC, 'index.js'), 'utf8')).trim(), "export { default } from './app.js';");
  assert.equal(worker, app);
  assert.equal(typeof worker.fetch, 'function');
});

test('依赖方向：lib/ 只 import lib/，core/ 只 import core/，api/ 不 import router/app', () => {
  for (const f of walk(SRC)) {
    const rel = relative(SRC, f);
    for (const spec of imports(f)) {
      assert.ok(spec.startsWith('.'), `${rel}: 只许相对 import（${spec}）`);
      const target = relative(SRC, join(f, '..', spec));
      if (rel.startsWith('lib/')) assert.ok(target.startsWith('lib/'), `${rel} → ${target}`);
      if (rel.startsWith('core/')) assert.ok(target.startsWith('core/'), `${rel} → ${target}`);
      if (rel.startsWith('api/')) assert.ok(!['router.js', 'app.js', 'index.js'].includes(target), `${rel} → ${target}`);
    }
  }
});

test('wrangler.toml：main 不变，没有任何绑定、变量、密钥', () => {
  const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8').replace(/^\s*#.*$/gm, '');
  assert.match(toml, /^name = "styrigx-proxy-rules"$/m);
  assert.match(toml, /^main = "src\/index\.js"$/m);
  for (const k of ['kv_namespaces', 'd1_databases', 'r2_buckets', 'services', 'vars', 'secrets_store_secrets', 'durable_objects', 'queues'])
    assert.ok(!new RegExp(`\\b${k}\\b`).test(toml), k);
  assert.ok(!/\benv\.[A-Z_]+/.test(walk(SRC).map((f) => strip(readFileSync(f, 'utf8'))).join('\n')), '源码不读 env 上的绑定');
});
