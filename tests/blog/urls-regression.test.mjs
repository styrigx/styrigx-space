/**
 * 网址与 RSS 回归测试：起一个模拟图志 Pages 的服务（space/web/public/blog/ 挂在 /blog/ 下，前缀外一律 404），
 * 核对博客页面在 /blog/ 下都是 200、RSS 结构、页面部件、页内链接都带 /blog 前缀。
 *
 * 跑法：先 `npm run build`（Tailwind + hugo --minify -s space/web）生成 space/web/public/blog/，
 * 再 `node --test tests/urls-regression.test.mjs`。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { existsSync } from 'node:fs';

const DIST = new URL('../../space/web/public/blog/', import.meta.url).pathname.replace(/\/$/, '');
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

/* P4-3 PR-4c（§6.8）：英文在无前缀地址，中文在 /blog/zh/ */
const URLS_200 = [
  '/blog/',
  '/blog/zh/',
  '/blog/tags/ai/',
  '/blog/zh/tags/ai/',
  '/blog/post/2026-10-07-muse-playbook/',
  '/blog/zh/post/2026-10-07-muse-playbook/',
  '/blog/rss.xml',
  '/blog/zh/rss.xml',
  '/blog/sitemap-index.xml',
];

describe('网址回归（图志 /blog/ 下）', () => {
  let server;
  let base;

  before(async () => {
    assert.ok(existsSync(DIST), 'space/web/public/blog/ 不存在：请先跑构建');
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
    for (const url of ['/', '/zh/', '/post/2026-10-07-muse-playbook/', '/rss.xml', '/blog/about/', '/blog/archives/', '/blog/zh/about/']) {
      assert.equal((await fetch(base + url)).status, 404, url);
    }
  });

  it('旧的 /blog/en/… 一律 404（PR-4c 删除不 301）', async () => {
    for (const url of ['/blog/en/', '/blog/en/post/2026-10-07-muse-playbook/', '/blog/en/rss.xml', '/blog/en/tags/ai/']) {
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

  it('/blog/zh/rss.xml 是 RSS 且包含条目', async () => {
    const res = await fetch(base + '/blog/zh/rss.xml');
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
    /* 2026-11 顶栏 v3：四站同一个 tmux 页脚（sgx-foot），博客自己的版权页脚 / Powered by 仍然没有 */
    assert.equal((html.match(/<footer/g) || []).length, 1, '只有一个页脚');
    assert.match(html, /<footer class="sgx-foot"/, '是共享 tmux 页脚');
    assert.match(html, /data-win="blog" aria-current="page"/, '页脚当前窗口 1:blog');
    assert.doesNotMatch(html, /oui-footer|Powered by/, '没有博客自己的版权页脚');
  });

  it('留言板撤了（2026-10-24）：/guestbook/、/en/guestbook/ 是 404，页面里没有留言板入口和 Giscus', async () => {
    for (const url of ['/blog/guestbook/', '/blog/zh/guestbook/']) assert.equal((await fetch(base + url)).status, 404, url);
    for (const url of ['/blog/', '/blog/zh/', '/blog/zh/post/2026-10-07-muse-playbook/']) {
      const html = await (await fetch(base + url)).text();
      assert.doesNotMatch(html, /guestbook|giscus|留言板/i, url);
    }
  });

  it('列表页：首页 · 文章 · 专题 三个面板 + 首页分区入口，没有归档', async () => {
    const res = await fetch(base + '/blog/zh/');
    const html = await res.text();
    assert.match(html, /<h1 class="sgx-visually-hidden"[^>]*>博客</, '中文首页 h1「博客」只给读屏 / 搜索引擎');
    assert.match(await (await fetch(base + '/blog/')).text(), /<h1 class="sgx-visually-hidden"[^>]*>Blog</, '英文首页 h1「Blog」');
    assert.doesNotMatch(html, /sgx-subpage-head|sgx-subpage-title/, '没有居中大标题区');
    assert.match(html, /note-entry/, '应有文章列表');
    for (const id of ['home', 'posts', 'topics']) {
      assert.match(html, new RegExp(`id="sgx-pane-${id}"`), `面板 ${id}`);
      assert.match(html, new RegExp(`data-entry="${id}"`), `分区入口 ${id}`);
    }
    /* P4-3 PR-4b：顶栏没有分段滑块，页名胶囊 = 站名「博客」（切分区时脚本换成分区名）；
       段式标签 PR（§6.6）：分段搬进页内——文章 / 专题面板各有标题带 + 一条段式标签（当前项服务端写好），首页分区是入口页不放 */
    assert.doesNotMatch(html, /data-sgx-seg(?!s)|data-sgx-tab=/);
    for (const cur of ['posts', 'topics']) {
      assert.match(html, new RegExp(`id="?blog-segs-${cur}"?[^>]*data-sgx-segs`), `段式标签在 ${cur} 面板`);
      assert.match(html, new RegExp(`href="?#${cur}"? data-seg="?${cur}"? aria-current="?page"?`), `${cur} 面板里 ${cur} 是当前项`);
    }
    assert.equal((html.match(/data-sgx-segs/g) || []).length, 2, '只有文章 / 专题两条');
    assert.equal((html.match(/data-sgx-hero/g) || []).length, 2, '文章 / 专题两个面板各一个标题带');
    assert.match(html, /class="?sgx-tb-title"? data-sgx-titles=[^>]*>博客</);
    assert.doesNotMatch(html, /sgx-pane-archive|data-sgx-tab="archive"/, '没有归档页签');
    assert.doesNotMatch(html, /oui-hero/, '旧首页 hero 已删除');
    assert.doesNotMatch(
      html,
      /\s(data-sgx-more|data-sgx-back|data-lang-switcher|data-theme-toggle)[\s>=]/,
      '⋮ / ‹ / 语言 / 主题开关已删除',
    );
  });

  it('专题：鉴权规范系列（中文 2 篇，按 seriesOrder）', async () => {
    const html = await (await fetch(base + '/blog/zh/')).text();
    const card = html.match(/data-series-card="[^"]+"[\s\S]*?<\/article>/);
    assert.ok(card, '应有系列卡');
    assert.match(card[0], /Styrigx UI 鉴权规范/);
    const titles = [...card[0].matchAll(/<a href="\/blog\/zh\/post\/([^"]+)\/"/g)].map((m) => m[1]);
    assert.deepEqual(titles, [
      '2026-10-11-key-spec-whitepaper',
      '2026-10-11-key-spec-whitepaper-v2',
    ]);
  });

  it('系列文章页有系列小块（第 n / N 篇）', async () => {
    const html = await (await fetch(base + '/blog/zh/post/2026-10-11-key-spec-whitepaper-v2/')).text();
    assert.match(html, /sgx-series-block/);
    assert.match(html, /第 2 \/ 2 篇/);
    assert.match(
      html,
      /rel="prev"[^>]*href="\/blog\/zh\/post\/2026-10-11-key-spec-whitepaper\/"|href="\/blog\/zh\/post\/2026-10-11-key-spec-whitepaper\/"[^>]*>\s*<small/,
    );
  });

  it('NAVIGATE（顶栏 v3）：主页 / 博客 / 奇趣 / 日刻 / 旷野（主站项绝对地址、三站之间相对 /<站>/），博客「开」态；头像在顶栏最右和 AI 窗口头部，都去主站账号页；没有搜索框', async () => {
    const html = await (await fetch(base + '/blog/')).text();
    const hrefs = [...html.matchAll(/class="sgx-nav-tile" href="([^"]+)"/g)].map((m) => m[1]);
    /* 对齐 PR-B：05 旷野指向独立页 /wild/ */
    assert.deepEqual(hrefs, ['https://styrigx.com/', '/blog/', '/curio/', '/daymark/', 'https://styrigx.com/wild/']);
    assert.match(html, /class="sgx-nav-tile" href="\/blog\/" data-nav="blog" aria-current="page"/);
    assert.match(html, /<a class="sgx-pop-me-a" href="https:\/\/styrigx\.com\/account\/"><img src="https:\/\/styrigx\.com\/avatar\/192\.webp"/);
    assert.match(html, /<a class="sgx-tb-av" href="https:\/\/styrigx\.com\/account\/"/, '顶栏头像去主站账号页');
    assert.doesNotMatch(html, /sgx-drawer|sgx-tb-nav\b/, '抽屉和九宫格删了');
    assert.doesNotMatch(html, /book\.styrigx\.com/, '书库已下线');
    assert.doesNotMatch(html, /atlas\.styrigx\.com/, '合并 PR3：不再有旧图志域名');
    const zh = await (await fetch(base + '/blog/zh/')).text();
    const zhHrefs = [...zh.matchAll(/class="sgx-nav-tile" href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(zhHrefs, ['https://styrigx.com/zh/', '/blog/zh/', '/curio/zh/', '/daymark/zh/', 'https://styrigx.com/zh/wild/']);
    assert.match(zh, /<a class="sgx-pop-me-a" href="https:\/\/styrigx\.com\/zh\/account\/"/);
  });

  it('文章页：长条只有页名（文章标题）+ 阅读进度（顶栏 v3 起不显示，读屏照读），没有页签；分享本页在 NAVIGATE；正文里没有内联目录；顶栏不放目录（窄屏目录入口暂不放，宽屏目录卡照旧）', async () => {
    const html = await (await fetch(base + '/blog/zh/post/2026-10-07-muse-playbook/')).text();
    const pill = html.match(/<div class="sgx-tb-pill[\s\S]*?<\/div>/)[0];
    assert.doesNotMatch(pill, /sgx-seg/);
    const title = html.match(/<h1[^>]*>([^<]+)<\/h1>/)[1].trim();
    assert.match(pill, new RegExp('<span class="sgx-tb-title">' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</span>'));
    assert.match(pill, /data-sgx-progress/);
    const set = html.match(/<dialog id="sgx-nav"[\s\S]*?<\/dialog>/)[0];
    assert.match(set, /<button type="button" class="sgx-nav-btn" data-qp="share" data-sgx-share aria-label="分享本页">/, '分享本页 = NAVIGATE 的 share 按钮');
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
