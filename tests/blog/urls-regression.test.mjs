/**
 * 网址与 RSS 回归测试：起一个模拟图志 Pages 的服务（atlas/web/blog/public/ 挂在 /blog/ 下，前缀外一律 404），
 * 核对博客页面在 /blog/ 下都是 200、RSS 结构、页面部件、页内链接都带 /blog 前缀。
 *
 * 跑法：先 `npm run build`（Tailwind + hugo --minify -s atlas/web/blog）生成 atlas/web/blog/public/，
 * 再 `node --test tests/urls-regression.test.mjs`。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { existsSync } from 'node:fs';

const DIST = new URL('../../atlas/web/blog/public/', import.meta.url).pathname.replace(/\/$/, '');
const MIME = {
  '.html': 'text/html',
  '.xml': 'application/rss+xml',
};

function serve() {
  return createServer(async (req, res) => {
    const full = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    /* 图志下博客只在 /blog/ 前缀里（/blog 不带斜杠时 Pages 会补，这里按同一个目录处理） */
    if (full !== '/blog' && !full.startsWith('/blog/')) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let path = full.slice('/blog'.length) || '/';
    if (path.endsWith('/')) path += 'index.html';
    // /post/xxx -> /post/xxx/index.html
    let file = join(DIST, path);
    const stat = existsSync(file) ? await import('node:fs').then((m) => m.statSync(file)) : null;
    if (stat?.isDirectory()) file = join(file, 'index.html');
    else if (!existsSync(file) && existsSync(file + '.html')) file = file + '.html';
    else if (!existsSync(file) && existsSync(join(DIST, path, 'index.html'))) {
      file = join(DIST, path, 'index.html');
    }
    try {
      const body = await readFile(file);
      const ext = extname(file);
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'text/plain' });
      res.end(body);
    } catch {
      // 404.html 回退（Cloudflare Pages 行为近似）
      try {
        const body = await readFile(join(DIST, '404.html'));
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    }
  });
}

const URLS_200 = [
  '/blog/',
  '/blog/en/',
  '/blog/tags/ai/',
  '/blog/post/2026-10-07-muse-playbook/',
  '/blog/en/post/2026-10-07-muse-playbook/',
  '/blog/rss.xml',
  '/blog/en/rss.xml',
  '/blog/sitemap-index.xml',
];

describe('网址回归（图志 /blog/ 下）', () => {
  let server;
  let base;

  before(async () => {
    assert.ok(existsSync(DIST), 'atlas/web/blog/public/ 不存在：请先跑构建');
    server = serve();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  for (const url of URLS_200) {
    it(`${url} 返回 200`, async () => {
      const res = await fetch(base + url);
      assert.equal(res.status, 200, `${url} 期望 200，实际 ${res.status}`);
    });
  }

  it('前缀外的地址（旧的根路径、/about/、/archives/）一律 404，不留兼容', async () => {
    for (const url of ['/', '/en/', '/post/2026-10-07-muse-playbook/', '/rss.xml', '/blog/about/', '/blog/archives/', '/blog/en/about/']) {
      assert.equal((await fetch(base + url)).status, 404, url);
    }
  });

  it('/blog/rss.xml 是 RSS 且包含文章条目', async () => {
    const res = await fetch(base + '/blog/rss.xml');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /<rss[^>]*>/, '应为 RSS 文档');
    assert.match(text, /<item>/, '应包含 <item> 条目');
    assert.match(text, /muse-playbook/i, '应包含已知文章');
  });

  it('/blog/en/rss.xml 是 RSS 且包含条目', async () => {
    const res = await fetch(base + '/blog/en/rss.xml');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /<rss[^>]*>/);
    assert.match(text, /<item>/);
  });

  it('文章页包含 One UI 标记且正文完整', async () => {
    const res = await fetch(base + '/blog/post/2026-10-07-muse-playbook/');
    const html = await res.text();
    assert.match(html, /oui-article-paper/, '应有 One UI 文章纸面');
    assert.doesNotMatch(html, /pagefind/, '站内搜索已删除');
    assert.doesNotMatch(html, /giscus|comment-section|data-comment/i, '文章页没有评论');
    assert.doesNotMatch(html, /<footer|oui-footer|©|Powered by/, '没有版权页脚');
  });

  it('留言板撤了（2026-10-24）：/guestbook/、/en/guestbook/ 是 404，页面里没有留言板入口和 Giscus', async () => {
    for (const url of ['/blog/guestbook/', '/blog/en/guestbook/']) assert.equal((await fetch(base + url)).status, 404, url);
    for (const url of ['/blog/', '/blog/en/', '/blog/post/2026-10-07-muse-playbook/']) {
      const html = await (await fetch(base + url)).text();
      assert.doesNotMatch(html, /guestbook|giscus|留言板/i, url);
    }
  });

  it('列表页：首页 · 文章 · 专题 三个面板，没有归档', async () => {
    const res = await fetch(base + '/blog/');
    const html = await res.text();
    assert.match(html, /<h1 class="sgx-visually-hidden"[^>]*>博客</, '首页 h1「博客」只给读屏 / 搜索引擎');
    assert.doesNotMatch(html, /sgx-subpage-head|sgx-subpage-title/, '没有居中大标题区');
    assert.match(html, /note-entry/, '应有文章列表');
    for (const id of ['home', 'posts', 'topics']) {
      assert.match(html, new RegExp(`id="sgx-pane-${id}"`), `面板 ${id}`);
      assert.match(html, new RegExp(`data-sgx-tab="${id}"`), `页签 ${id}`);
    }
    assert.doesNotMatch(html, /sgx-pane-archive|data-sgx-tab="archive"/, '没有归档页签');
    assert.doesNotMatch(html, /oui-hero/, '旧首页 hero 已删除');
    assert.doesNotMatch(
      html,
      /\s(data-sgx-more|data-sgx-back|data-lang-switcher|data-theme-toggle)[\s>=]/,
      '⋮ / ‹ / 语言 / 主题开关已删除',
    );
  });

  it('专题：鉴权规范系列（中文 2 篇，按 seriesOrder）', async () => {
    const html = await (await fetch(base + '/blog/')).text();
    const card = html.match(/data-series-card="[^"]+"[\s\S]*?<\/article>/);
    assert.ok(card, '应有系列卡');
    assert.match(card[0], /Styrigx UI 鉴权规范/);
    const titles = [...card[0].matchAll(/<a href="\/blog\/post\/([^"]+)\/"/g)].map((m) => m[1]);
    assert.deepEqual(titles, [
      '2026-10-11-key-spec-whitepaper',
      '2026-10-11-key-spec-whitepaper-v2',
    ]);
  });

  it('系列文章页有系列小块（第 n / N 篇）', async () => {
    const html = await (await fetch(base + '/blog/post/2026-10-11-key-spec-whitepaper-v2/')).text();
    assert.match(html, /sgx-series-block/);
    assert.match(html, /第 2 \/ 2 篇/);
    assert.match(
      html,
      /rel="prev"[^>]*href="\/blog\/post\/2026-10-11-key-spec-whitepaper\/"|href="\/blog\/post\/2026-10-11-key-spec-whitepaper\/"[^>]*>\s*<small/,
    );
  });

  it('快捷面板导航页（2026-11-04 P5-1 替代抽屉）：主站 / 奇趣 / 日刻 / 博客（主站项绝对地址、三站之间相对 /<站>/），博客高亮；头像去主站账号页；没有搜索框', async () => {
    const html = await (await fetch(base + '/blog/')).text();
    const hrefs = [...html.matchAll(/class="sgx-qp-nav-item" href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(hrefs, ['https://styrigx.com/', '/curio/', '/daymark/', '/blog/']);
    assert.match(html, /class="sgx-qp-nav-item" href="\/blog\/" data-nav="blog" aria-current="page"/);
    assert.match(html, /<a class="sgx-tb-btn sgx-tb-me" href="https:\/\/styrigx\.com\/account\/"[^>]*><img src="https:\/\/styrigx\.com\/avatar\/192\.webp"/);
    assert.doesNotMatch(html, /sgx-drawer|sgx-tb-nav\b/, '抽屉和九宫格删了');
    assert.doesNotMatch(html, /book\.styrigx\.com/, '书库已下线');
    assert.doesNotMatch(html, /atlas\.styrigx\.com/, '合并 PR3：不再有旧图志域名');
    const en = await (await fetch(base + '/blog/en/')).text();
    const enHrefs = [...en.matchAll(/class="sgx-qp-nav-item" href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(enHrefs, ['https://styrigx.com/en/', '/curio/en/', '/daymark/en/', '/blog/en/']);
    assert.match(en, /<a class="sgx-tb-btn sgx-tb-me" href="https:\/\/styrigx\.com\/en\/account\/"/);
  });

  it('文章页：长条只有页名（文章标题）+ 阅读进度细线，没有页签；分享本页在快捷面板第 2 页；正文里没有内联目录；顶栏不放目录（窄屏目录入口暂不放，宽屏目录卡照旧）', async () => {
    const html = await (await fetch(base + '/blog/post/2026-10-07-muse-playbook/')).text();
    const pill = html.match(/<div class="sgx-tb-pill[\s\S]*?<\/div>/)[0];
    assert.doesNotMatch(pill, /sgx-seg/);
    const title = html.match(/<h1[^>]*>([^<]+)<\/h1>/)[1].trim();
    assert.match(pill, new RegExp('<span class="sgx-tb-title">' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</span>'));
    assert.match(pill, /data-sgx-progress/);
    const set = html.match(/<section class="sgx-qp-page" id="sgx-qp-page-set"[\s\S]*?<\/section>/)[0];
    assert.match(set, /<button type="button" class="sgx-qp-tile" data-qp="share" data-sgx-share>[\s\S]*?分享本页/, '分享本页 = 快捷设置页磁贴');
    assert.doesNotMatch(html, /sgx-tb-end|sgx-tb-share|sgx-tb-gbtn/, '没有右圆 / 右胶囊了');
    assert.doesNotMatch(html, /sgx-prog-title|sgx-toc-sheet|mobile-article-toc/);
    assert.doesNotMatch(html, /sgx-drawer-toc/, '抽屉删了，目录不进顶栏');
    assert.match(html, /data-toc-root|sidebar-toc/, '宽屏目录卡照旧（toc-items / toc-tree 接口保留）');
  });

  it('404.html 存在且为 One UI 样式', async () => {
    const res = await fetch(base + '/blog/does-not-exist-xyz');
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.match(html, /oui-notfound/, '应为 One UI 404');
  });
});
