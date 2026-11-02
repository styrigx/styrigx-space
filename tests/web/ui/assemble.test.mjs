/**
 * 四包拼一棵树（合并 PR2；移植自 styrigx-atlas tests/pages.test.mjs，按单树改写）：
 * - scripts/assemble.mjs：主站产物整份在根上（域名根文件 _worker.js / _headers / _redirects / robots.txt / 404.html 都归主站），
 *   三站产物在 /blog/ /curio/ /daymark/ 下、各带自己的 404.html；子站产物带根文件、主站产物里已有子站目录、哪个包没构建 → 失败，且不出半棵树
 * - web/atlas/static/_worker.js：非 styrigx.com 一律 301（host 判断不变）；/curio/ /daymark/ 下像图片的回答一律 404 no-store，
 *   主站（/images/ /avatar/ /og.png 收藏图标）和 /blog/（og.png）照旧；过渡期三站 .xml 一律 404（PR3 网关接管子站前缀后删）
 * - web/atlas/static/_headers：子站缓存规则在 @gen-security-headers 段外（gen-csp 不管）
 * - 三站 baseURL 都是 https://styrigx.com/<站>/；子站包不带自己的 Pages 根文件；奇趣、日刻的 web/ 里没有图片文件
 * - 最后一组对真实构建拼树（先 npm run build 或 CI 的 Build site + Build subsites；没构建就跳过）
 * 运行：node --test tests/web/ui/assemble.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(path.join(REPO, p), 'utf8');
const { assemble, SITES, ROOT_ONLY } = await import(pathToFileURL(path.join(REPO, 'scripts/assemble.mjs')).href);
const pagesWorker = (await import(pathToFileURL(path.join(REPO, 'web/atlas/static/_worker.js')).href)).default;

const IMG = /\.(png|apng|jpe?g|jfif|pjpeg|pjp|gif|webp|avif|svgz?|ico|cur|bmp|tiff?|heic|heif|jxl)$/i;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HOST = 'https://styrigx.com';

/* ---------------- assemble（临时目录里的假产物） ---------------- */

/** 写一份假产物：{ 相对路径: 内容 } */
function tree(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

function fixture({ mainExtra = {}, siteExtra = {}, skip = [] } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'sgx-assemble-'));
  const main = tree(path.join(base, 'main'), {
    'index.html': 'main', '404.html': 'main 404', '_worker.js': 'w', '_headers': 'h', '_redirects': 'r', 'robots.txt': 'User-agent: *\n',
    'css/main.css': 'c', 'en/index.html': 'main en', ...mainExtra,
  });
  for (const s of SITES) {
    if (skip.includes(s)) continue;
    tree(path.join(base, s), { 'index.html': s, 'en/index.html': s + ' en', '404.html': s + ' 404', 'css/a.css': s, ...(siteExtra[s] || {}) });
  }
  return { base, main, siteDir: (s) => path.join(base, s), out: path.join(base, 'out', 'site') };
}

test('SITES / ROOT_ONLY：三站、四个只在域名根上的文件', () => {
  assert.deepEqual([...SITES], ['blog', 'curio', 'daymark']);
  assert.deepEqual([...ROOT_ONLY].sort(), ['_headers', '_redirects', '_worker.js', 'robots.txt']);
});

test('assemble：主站整份在根上（根文件和 404 归主站），三站在 /<站>/ 下各带 404', () => {
  const f = fixture();
  const out = assemble(f);
  assert.equal(out, f.out);
  for (const n of ['index.html', '404.html', '_worker.js', '_headers', '_redirects', 'robots.txt', 'css/main.css', 'en/index.html']) {
    assert.equal(readFileSync(path.join(out, n), 'utf8'), readFileSync(path.join(f.main, n), 'utf8'), n);
  }
  for (const s of SITES) {
    assert.equal(readFileSync(path.join(out, s, 'index.html'), 'utf8'), s);
    assert.equal(readFileSync(path.join(out, s, 'en/index.html'), 'utf8'), s + ' en');
    assert.equal(readFileSync(path.join(out, s, '404.html'), 'utf8'), s + ' 404');
    for (const n of ROOT_ONLY) assert.equal(existsSync(path.join(out, s, n)), false, s + '/' + n);
  }
  assert.deepEqual(readdirSync(out).sort(), ['404.html', '_headers', '_redirects', '_worker.js', 'blog', 'css', 'curio', 'daymark', 'en', 'index.html', 'robots.txt']);
});

test('assemble：输出目录先清空（上次拼的残留不留）', () => {
  const f = fixture();
  tree(f.out, { 'stale.html': 'old', 'blog/stale.js': 'old' });
  assemble(f);
  assert.equal(existsSync(path.join(f.out, 'stale.html')), false);
  assert.equal(existsSync(path.join(f.out, 'blog/stale.js')), false);
});

test('assemble：子站产物里有只该在域名根上的文件 → 失败，不出半棵树', () => {
  for (const n of ROOT_ONLY) {
    const f = fixture({ siteExtra: { curio: { [n]: 'x' } } });
    assert.throws(() => assemble(f), (e) => /curio 的产物里有只该在域名根上的文件/.test(e.message) && e.message.includes(n), n);
    assert.equal(existsSync(f.out), false, n + '：不该留下输出目录');
  }
});

test('assemble：主站产物里已有子站目录 → 撞名失败', () => {
  const f = fixture({ mainExtra: { 'daymark/index.html': 'clash' } });
  assert.throws(() => assemble(f), /主站产物里已有 daymark\//);
  assert.equal(existsSync(f.out), false);
});

test('assemble：哪个包没构建就报哪个', () => {
  const f = fixture({ skip: ['blog'] });
  assert.throws(() => assemble(f), /blog 还没构建/);
  const g = fixture();
  assert.throws(() => assemble({ ...g, main: path.join(g.base, 'nope') }), /主站还没构建/);
});

test('assemble：输出目录不能和主站产物重叠', () => {
  const f = fixture();
  assert.throws(() => assemble({ ...f, out: f.main }), /重叠/);
  assert.throws(() => assemble({ ...f, out: path.join(f.main, 'x') }), /重叠/);
});

/* ---------------- web/atlas/static/_worker.js ---------------- */

/** 假的 ASSETS：按路径回不同的静态回答，记下收到的请求 */
function assetsWith(map, seen = []) {
  return {
    fetch: async (req) => {
      const p = new URL(req.url).pathname;
      seen.push(p);
      const hit = map[p];
      return hit ? hit() : new Response('static:' + p, { headers: { 'Content-Type': 'text/html' } });
    },
  };
}

test('_worker.js：非 styrigx.com 一律 301 回 styrigx.com（含子站路径），保留路径和查询串，不碰静态文件', async () => {
  const seen = [];
  for (const host of ['styrigx-space.pages.dev', 'abc123.styrigx-space.pages.dev', 'atlas.styrigx.com']) {
    for (const p of ['/blog/', '/curio/en/?x=1', '/daymark/a.png']) {
      const res = await pagesWorker.fetch(new Request('https://' + host + p), { ASSETS: assetsWith({}, seen) });
      assert.equal(res.status, 301, host + p);
      assert.equal(res.headers.get('Location'), HOST + p);
      assert.equal(res.headers.get('Cache-Control'), 'no-store');
    }
  }
  assert.equal(seen.length, 0);
});

test('_worker.js：styrigx.com 的页面交给静态文件（主站和三站）', async () => {
  for (const p of ['/', '/settings/', '/blog/', '/curio/en/', '/daymark/']) {
    const res = await pagesWorker.fetch(new Request(HOST + p), { ASSETS: assetsWith({}) });
    assert.equal(res.status, 200, p);
    assert.equal(await res.text(), 'static:' + p);
  }
});

test('_worker.js：/curio/ /daymark/ 图片后缀一律 404（不管文件在不在、大小写、查询串、编码 / 双斜杠），不带图片字节、no-store', async () => {
  const assets = assetsWith({
    '/curio/a.png': () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } }),
    '/daymark/img/b.SVG': () => new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
  });
  const paths = ['/curio/a.png', '/daymark/img/b.SVG', '/curio/a.png?v=1', '/CURIO/a.png', '/%63urio/a.png', '/curio/a%2Epng', '//daymark//x.webp'];
  for (const ext of ['jpeg', 'jpg', 'webp', 'avif', 'gif', 'ico', 'bmp', 'heic', 'jxl', 'svgz', 'tiff']) paths.push('/curio/x.' + ext, '/daymark/x.' + ext);
  for (const p of paths) {
    const res = await pagesWorker.fetch(new Request(HOST + p), { ASSETS: assets });
    assert.equal(res.status, 404, p);
    assert.equal(res.headers.get('Cache-Control'), 'no-store', p);
    assert.doesNotMatch(res.headers.get('Content-Type') || '', /^image\//, p);
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff', p);
    assert.equal(await res.text(), 'not found', p);
  }
});

test('_worker.js：/curio/ /daymark/ 没有后缀但回答是 image/* 的也 404；字体、脚本、样式、页面照常', async () => {
  const assets = assetsWith({
    '/curio/blob': () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } }),
    '/daymark/fonts/inter-latin.woff2': () => new Response('font', { headers: { 'Content-Type': 'font/woff2' } }),
    '/curio/js/app.0123456789abcdef.js': () => new Response('js', { headers: { 'Content-Type': 'text/javascript' } }),
  });
  assert.equal((await pagesWorker.fetch(new Request(HOST + '/curio/blob'), { ASSETS: assets })).status, 404);
  for (const p of ['/daymark/fonts/inter-latin.woff2', '/curio/js/app.0123456789abcdef.js']) {
    const res = await pagesWorker.fetch(new Request(HOST + p), { ASSETS: assets });
    assert.equal(res.status, 200, p);
  }
});

test('_worker.js：主站和博客的图片照旧（/images/ /avatar/ /og.png /favicon.* /blog/og.png）', async () => {
  const img = (ct) => () => new Response(PNG, { headers: { 'Content-Type': ct } });
  const map = {
    '/og.png': img('image/png'), '/favicon.ico': img('image/x-icon'), '/favicon.svg': img('image/svg+xml'),
    '/avatar/96.webp': img('image/webp'), '/images/x.jpg': img('image/jpeg'), '/blog/og.png': img('image/png'),
    '/curiosity.png': img('image/png'), '/daymarks/x.png': img('image/png'),
  };
  for (const p of Object.keys(map)) {
    const res = await pagesWorker.fetch(new Request(HOST + p), { ASSETS: assetsWith(map) });
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('Content-Type'), /^image\//, p);
  }
});

test('_worker.js：跳转原样放行（Pages 补尾斜杠、_redirects），不当成图片拦', async () => {
  const assets = assetsWith({
    '/curio': () => new Response(null, { status: 308, headers: { Location: '/curio/' } }),
    '/daymark/x.png': () => new Response(null, { status: 302, headers: { Location: '/daymark/' } }),
  });
  const a = await pagesWorker.fetch(new Request(HOST + '/curio'), { ASSETS: assets });
  assert.equal(a.status, 308);
  const b = await pagesWorker.fetch(new Request(HOST + '/daymark/x.png'), { ASSETS: assets });
  assert.equal(b.status, 302);
});

test('_worker.js 过渡期（PR2 → PR3）：三站的 .xml（全文 RSS、站点地图）一律 404 no-store；主站 /sitemap.xml、子站页面 / manifest.json 照旧', async () => {
  const xml = (p) => () => new Response('<rss>' + p + '</rss>', { headers: { 'Content-Type': 'application/rss+xml' } });
  const assets = assetsWith({
    '/blog/rss.xml': xml('a'), '/blog/en/rss.xml': xml('b'), '/blog/sitemap-0.xml': xml('c'), '/curio/sitemap.xml': xml('d'),
    '/blog/feed': xml('e'), '/sitemap.xml': xml('main'),
    '/blog/manifest.json': () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
  });
  for (const p of ['/blog/rss.xml', '/blog/en/rss.xml', '/blog/sitemap-0.xml', '/blog/sitemap-index.xml', '/curio/sitemap.xml', '/daymark/sitemap.xml', '/BLOG/RSS.XML', '/blog/feed']) {
    const res = await pagesWorker.fetch(new Request(HOST + p), { ASSETS: assets });
    assert.equal(res.status, 404, p);
    assert.equal(res.headers.get('Cache-Control'), 'no-store', p);
    assert.equal(await res.text(), 'not found', p);
  }
  for (const p of ['/sitemap.xml', '/blog/manifest.json', '/blog/']) {
    assert.equal((await pagesWorker.fetch(new Request(HOST + p), { ASSETS: assets })).status, 200, p);
  }
});

/* ---------------- 根文件归属 / 包内容 ---------------- */

test('_headers：子站缓存规则在 @gen-security-headers 段外，/js/ /css/ 一年 immutable、博客字体一周', () => {
  const h = read('web/atlas/static/_headers');
  const end = h.indexOf('# @gen-security-headers end');
  assert.ok(end > 0);
  const generated = h.slice(0, end);
  const after = h.slice(end);
  for (const site of SITES) {
    for (const dir of ['js', 'css']) {
      const re = new RegExp(`^/${site}/${dir}/\\*\\n  Cache-Control: public, max-age=31536000, immutable$`, 'm');
      assert.match(after, re, site + ' ' + dir);
      assert.doesNotMatch(generated, re, site + ' ' + dir + ' 不能写进生成段');
    }
  }
  assert.match(after, /^\/blog\/fonts\/\*\n  Cache-Control: public, max-age=604800$/m);
});

test('三站 baseURL 都是 https://styrigx.com/<站>/（产物放在主站单树里）', () => {
  for (const site of SITES) {
    assert.match(read(`web/${site}/hugo.yaml`), new RegExp(`^baseURL: 'https://styrigx\\.com/${site}/'$`, 'm'), site);
  }
});

test('子站包不带自己的 Pages 配置和根文件，也没有 Pages Functions', () => {
  for (const site of SITES) {
    for (const f of ['wrangler.toml', 'functions', 'static/_worker.js', 'static/_headers', 'static/_redirects', 'static/robots.txt']) {
      assert.equal(existsSync(path.join(REPO, 'web', site, f)), false, `web/${site}/${f}`);
    }
  }
  assert.equal(read('web/atlas/static/robots.txt'), 'User-agent: *\nDisallow: /\n');
});

test('奇趣、日刻的 web/ 里没有图片文件（图片只能走接口 Worker 的 /<站>/api/*，先验会话）', () => {
  const skip = new Set(['public', 'resources', 'node_modules']);
  const bad = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(path.join(dir, e.name), rel + e.name + '/'); }
      else if (IMG.test(e.name)) bad.push(rel + e.name);
    }
  };
  for (const site of ['curio', 'daymark']) walk(path.join(REPO, 'web', site), `web/${site}/`);
  assert.deepEqual(bad, []);
});

/* ---------------- 真实构建拼树 ---------------- */

test('真实构建：拼好的树根文件归主站、三站各在前缀下、站内地址都带本站前缀、/curio/ /daymark/ 没有图片', (t) => {
  const built = ['atlas', ...SITES].every((s) => existsSync(path.join(REPO, 'web', s, 'public/index.html')));
  if (!built) { t.skip('还没构建（先 npm run build）'); return; }
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'sgx-site-')), 'site');
  assemble({ out });
  for (const f of ['_worker.js', '_headers', '_redirects', 'robots.txt', '404.html', 'index.html']) {
    assert.ok(readFileSync(path.join(out, f)).equals(readFileSync(path.join(REPO, 'web/atlas/public', f))), f + ' 来自主站');
  }
  assert.equal(readFileSync(path.join(out, '_worker.js'), 'utf8'), read('web/atlas/static/_worker.js'));
  for (const s of SITES) {
    for (const f of ['index.html', 'en/index.html', '404.html']) assert.ok(existsSync(path.join(out, s, f)), s + '/' + f);
    for (const n of ROOT_ONLY) assert.equal(existsSync(path.join(out, s, n)), false, s + '/' + n);
    const html = readFileSync(path.join(out, s, 'index.html'), 'utf8');
    const refs = [...html.matchAll(/(?:href|src)="?(\/[^"\s>]*)/g)].map((m) => m[1]);
    assert.ok(refs.length > 3, s);
    assert.deepEqual(refs.filter((r) => !r.startsWith('/' + s + '/')), [], s + '：站内地址都带 /' + s + '/');
    const canon = html.match(/<link rel="?canonical"? href="?([^"\s>]+)/);
    if (canon) assert.ok(canon[1].startsWith(`https://styrigx.com/${s}/`), s + ' canonical ' + canon[1]);
  }
  const imgs = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), rel + e.name + '/');
      else if (IMG.test(e.name)) imgs.push(rel + e.name);
    }
  };
  for (const s of ['curio', 'daymark']) walk(path.join(out, s), s + '/');
  assert.deepEqual(imgs, []);
});
