/**
 * 一个 Hugo 站（2026-11 合站；前身是合并 PR2 的四包拼树测试 assemble.test.mjs，移植自 styrigx-atlas tests/pages.test.mjs）：
 * - 主站和三个子站同一次 hugo 构建、同一棵 space/web/public/：域名根文件 _worker.js / _headers / _redirects / robots.txt / 404.html 只有主站的，
 *   三站在 /blog/ /curio/ /daymark/ 下、各带自己的 404.html（content/<站>/404.md，layout notfound）；中文在 /<站>/zh/（不是 /zh/<站>/）
 * - space/web/static/_worker.js：非 styrigx.com 一律 301（host 判断不变）；/curio/ /daymark/ 下像图片的回答一律 404 no-store，
 *   主站（/images/ /avatar/ /og.png 收藏图标）和 /blog/（og.png）照旧；PR2 的过渡规则「三站 .xml 一律 404」在合并 PR3 删掉（网关按子站前缀验会话）
 * - space/web/static/_headers：子站缓存规则在 @gen-security-headers 段外（gen-csp 不管）
 * - 子站的中文内容文件都在 front matter 写了 url: /<站>/zh/…；子站目录里没有只该在域名根上的文件；奇趣、日刻的源文件里没有图片
 * - 最后一组对真实构建（先 npm run build 或 CI 的 Build site；没构建就跳过）
 * 运行：node --test tests/space/ui/build/one-site.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (p) => readFileSync(path.join(REPO, p), 'utf8');
const pagesWorker = (await import(pathToFileURL(path.join(REPO, 'space/web/static/_worker.js')).href)).default;
/** 子站（目录名 = URL 第一段 = content/<站>/、layouts/<站>/、assets/<站>/、static/<站>/） */
const SITES = Object.freeze(['blog', 'curio', 'daymark']);
/** 只在域名根上生效、只许主站提供的 Pages 文件 */
const ROOT_ONLY = Object.freeze(['_worker.js', '_headers', '_redirects', 'robots.txt']);
const PUB = path.join(REPO, 'space/web/public');

const IMG = /\.(png|apng|jpe?g|jfif|pjpeg|pjp|gif|webp|avif|svgz?|ico|cur|bmp|tiff?|heic|heif|jxl)$/i;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HOST = 'https://styrigx.com';

/* ---------------- space/web/static/_worker.js ---------------- */

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
  for (const host of ['styrigx-space.pages.dev', 'abc123.styrigx-space.pages.dev', 'www.styrigx.com']) {
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
  for (const p of ['/', '/theme/', '/blog/', '/curio/en/', '/daymark/']) {
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

test('_worker.js：合并 PR3 删掉 PR2 的过渡规则——三站 .xml 原样交给静态文件（会话由网关子站关口验，见 tests/workers/space-core/subsites.test.mjs）', async () => {
  const xml = (p) => () => new Response('<rss>' + p + '</rss>', { headers: { 'Content-Type': 'application/rss+xml' } });
  const assets = assetsWith({
    '/blog/rss.xml': xml('a'), '/blog/en/rss.xml': xml('b'), '/curio/sitemap.xml': xml('d'), '/sitemap.xml': xml('main'),
    '/blog/manifest.json': () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
  });
  for (const p of ['/blog/rss.xml', '/blog/en/rss.xml', '/curio/sitemap.xml', '/sitemap.xml', '/blog/manifest.json', '/blog/']) {
    assert.equal((await pagesWorker.fetch(new Request(HOST + p), { ASSETS: assets })).status, 200, p);
  }
  assert.doesNotMatch(read('space/web/static/_worker.js'), /NO_XML_PREFIXES/);
});

/* ---------------- 根文件归属 / 包内容 ---------------- */

test('_headers：子站缓存规则在 @gen-security-headers 段外，/js/ /css/ 一年 immutable、博客字体一周', () => {
  const h = read('space/web/static/_headers');
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

test('一个 Hugo 站：只有 space/web/hugo.yaml 一份配置、baseURL 是 https://styrigx.com/，子站是 content/<站>/ 分区', () => {
  assert.match(read('space/web/hugo.yaml'), /^baseURL: 'https:\/\/styrigx\.com\/'$/m);
  assert.equal(existsSync(path.join(REPO, 'atlas')), false, '子站包 atlas/ 已并进 space/web/');
  for (const site of SITES) {
    assert.ok(existsSync(path.join(REPO, 'space/web/content', site, '_index.md')), site);
    assert.ok(existsSync(path.join(REPO, 'space/web/layouts', site, 'baseof.html')), site);
    assert.equal(existsSync(path.join(REPO, 'space/web/content', site, 'zh')), false, site + '：中文用 .zh.md 后缀，不放 zh/ 目录');
  }
});

test('子站的中文页都在 front matter 写了 url: /<站>/zh/…（Hugo 的语言前缀会给成 /zh/<站>/…）', () => {
  const bad = [];
  const walk = (dir, want) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, want);
      else if (e.name.endsWith('.zh.md') && !new RegExp('^url: ' + want.replace(/\//g, '\\/'), 'm').test(readFileSync(p, 'utf8'))) bad.push(path.relative(REPO, p));
    }
  };
  for (const site of SITES) walk(path.join(REPO, 'space/web/content', site), '/' + site + '/zh/');
  walk(path.join(REPO, 'space/web/content/tags'), '/blog/zh/tags/');
  assert.deepEqual(bad, []);
});

test('子站目录不带 Pages 配置和根文件，也没有 Pages Functions', () => {
  for (const site of SITES) {
    for (const f of ['_worker.js', '_headers', '_redirects', 'robots.txt', 'functions']) {
      assert.equal(existsSync(path.join(REPO, 'space/web/static', site, f)), false, `space/web/static/${site}/${f}`);
    }
  }
  assert.equal(read('space/web/static/robots.txt'), 'User-agent: *\nDisallow: /\n');
});

test('奇趣、日刻的源文件（content / layouts / assets / static / data 下的 <站>/）里没有图片文件（图片只能走接口 Worker 的 /<站>/api/*，先验会话）', () => {
  const skip = new Set(['public', 'resources', 'node_modules']);
  const bad = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(path.join(dir, e.name), rel + e.name + '/'); }
      else if (IMG.test(e.name)) bad.push(rel + e.name);
    }
  };
  for (const site of ['curio', 'daymark']) {
    for (const d of ['content', 'layouts', 'layouts/partials', 'assets', 'static', 'data']) {
      const dir = path.join(REPO, 'space/web', d, site);
      if (existsSync(dir)) walk(dir, `space/web/${d}/${site}/`);
    }
  }
  assert.deepEqual(bad, []);
});

/* ---------------- 真实构建拼树 ---------------- */

test('真实构建：根文件归主站、三站各在前缀下（中文 /<站>/zh/）、站内地址都带本站前缀、/curio/ /daymark/ 没有图片', (t) => {
  if (!SITES.every((s) => existsSync(path.join(PUB, s, 'index.html')))) { t.skip('还没构建（先 npm run build）'); return; }
  const out = PUB;
  for (const f of ['_worker.js', '_headers', '_redirects', 'robots.txt', '404.html', 'index.html']) assert.ok(existsSync(path.join(out, f)), f);
  assert.equal(readFileSync(path.join(out, '_worker.js'), 'utf8'), read('space/web/static/_worker.js'));
  for (const s of SITES) {
    for (const f of ['index.html', 'zh/index.html', '404.html', 'zh/404.html']) assert.ok(existsSync(path.join(out, s, f)), s + '/' + f);
    assert.equal(existsSync(path.join(out, s, 'en')), false, s + '/en/ 不该存在（P4-3 PR-4c：旧 /en/ 删除不 301）');
    assert.equal(existsSync(path.join(out, 'zh', s)), false, 'zh/' + s + '/ 不该存在（子站中文在 /' + s + '/zh/）');
    for (const n of ROOT_ONLY) assert.equal(existsSync(path.join(out, s, n)), false, s + '/' + n);
    const html = readFileSync(path.join(out, s, 'index.html'), 'utf8');
    const refs = [...html.matchAll(/(?:href|src)="?(\/[^"\s>]*)/g)].map((m) => m[1]);
    assert.ok(refs.length > 3, s);
    /* 合并 PR3：导航（2026-11-04 P5-1 起在快捷面板导航页）里另两个子站是同源相对地址 /<站>/（中文 /<站>/zh/，P4-3 PR-4c），主站项 / 账号 / 头像是 https://styrigx.com 绝对地址，其余站内地址都带本站前缀 */
    const others = SITES.filter((x) => x !== s).map((x) => '/' + x + '/');
    assert.deepEqual(refs.filter((r) => !r.startsWith('/' + s + '/') && !others.includes(r)), [], s + '：站内地址都带 /' + s + '/（另两站的导航项除外）');
    assert.deepEqual(others.filter((o) => !refs.includes(o)), [], s + '：导航页里另两站是相对地址');
    assert.doesNotMatch(html, /atlas\.styrigx\.com/, s + '：不再有旧图志域名');
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
