/**
 * space/scripts/build-search-index.mjs：博客写进全站搜索的索引（KV site:blog）。
 * 前几条用临时目录里的假文章测解析规则（draft 跳过、private 标记、正文去代码块标题栏 / 行号 / 标签、截断）；
 * 最后一条读真实构建（space/web/public/blog/）：每篇文章都在、网址和站点地图一致。
 * 跑法：npm run build 之后 node --test tests/search-index.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, parseFrontMatter, articleText, TEXT_MAX } from '../../space/scripts/blog/build-search-index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const page = (title, body) =>
  `<html><body><article class="article-card"><header class="article-header"><h1>${title}</h1></header>` +
  `<section id="article-start" class="article-content">\n${body}\n</section>\n        </article></body></html>`;

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'blog-ix-'));
  const content = path.join(dir, 'content');
  const pub = path.join(dir, 'public');
  const post = (lang, name, fm, html) => {
    mkdirSync(path.join(content, 'post'), { recursive: true });
    writeFileSync(path.join(content, 'post', name + (lang === 'en' ? '' : '.' + lang) + '.md'), `---\n${fm}\n---\n\nbody\n`);
    if (html == null) return;
    const out = path.join(pub, lang === 'zh' ? 'zh' : '', 'post', name); // P4-3 PR-4c：英文无前缀、中文 /zh/
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'index.html'), html);
  };
  post('zh', '2026-01-01-hello', 'title: 你好世界\ndescription: "第一篇：测试 & 描述"\ndate: 2026-01-01\ntags: ["A", "B"]', page('你好世界',
    '<h2 id="x">小节 &amp; 标题</h2>\n<p>正文<strong>加粗</strong>，链接<a href="/x">这里</a>。</p>\n' +
    '<figure class="code-block"><figcaption class="code-head"><span class="code-lang">bash</span><button>复制</button></figcaption>' +
    '<pre><code><span class="line"><span class="ln">1</span><span class="cl">echo hi</span></span></code></pre></figure>\n<script>alert(1)</script>'));
  post('zh', '2026-01-02-draft', 'title: 草稿\ndraft: true\ndate: 2026-01-02', null);
  post('zh', '2026-01-03-secret', "title: '私密'\nprivate: true\ndate: 2026-01-03\ntags:\n  - 只有标签", page('私密', '<p>' + '字'.repeat(30000) + '</p>'));
  post('en', '2026-01-01-hello', 'title: "Hello &quot;World&quot;"\ndate: 2026-01-01\ntags: ["Tag"]', page('Hello', '<p>don&rsquo;t &mdash; stop</p>'));
  return { dir, content, pub };
}

test('front matter：引号、行内数组、块数组、布尔', () => {
  const fm = parseFrontMatter('---\ntitle: "A: \\"b\\""\ntags: ["x", \'y z\']\nlist:\n  - one\n  - "two"\ndraft: true\nprivate: false\n---\nbody');
  assert.equal(fm.title, 'A: "b"');
  assert.deepEqual(fm.tags, ['x', 'y z']);
  assert.deepEqual(fm.list, ['one', 'two']);
  assert.equal(fm.draft, true);
  assert.equal(fm.private, false);
  assert.deepEqual(parseFrontMatter('no front matter'), {});
});

test('正文纯文本：去标签 / 脚本 / 代码块标题栏 / 行号，解实体，压空白', () => {
  const t = articleText(page('T', '<h2>小节 &amp; 标题</h2><p>a<em>b</em></p><figure class="code-block"><figcaption class="code-head">bash 复制</figcaption><pre><code><span class="line"><span class="ln">12</span><span class="cl">ls -la</span></span></code></pre></figure><script>x()</script><p>don&rsquo;t&nbsp;go &#x4e2d;&#20013;</p>'));
  assert.equal(t, '小节 & 标题 ab ls -la don\u2019t go 中中');
  assert.equal(articleText('<p>没有正文区块</p>'), '');
});

test('索引：跳过草稿，标 private，网址按语言拼，副标题取描述或第一个标签', () => {
  const { dir, content, pub } = fixture();
  try {
    const ix = build({ contentDir: content, publicDir: pub, now: new Date('2026-06-01T00:00:00Z') });
    assert.equal(ix.site, 'blog');
    assert.equal(ix.generated, '2026-06-01T00:00:00.000Z');
    const byId = Object.fromEntries(ix.items.map((x) => [x.id, x]));
    assert.deepEqual(Object.keys(byId).sort(), ['post-2026-01-01-hello', 'post-2026-01-01-hello-en', 'post-2026-01-03-secret']);
    const zh = byId['post-2026-01-01-hello'];
    assert.deepEqual(zh, {
      id: 'post-2026-01-01-hello',
      type: 'post',
      lang: 'zh',
      title: '你好世界',
      subtitle: '第一篇：测试 & 描述',
      text: '小节 & 标题 正文加粗，链接这里。 echo hi',
      url: 'https://styrigx.com/blog/zh/post/2026-01-01-hello/',
    });
    assert.equal(byId['post-2026-01-01-hello-en'].url, 'https://styrigx.com/blog/post/2026-01-01-hello/');
    assert.equal(byId['post-2026-01-01-hello-en'].lang, 'en');
    assert.equal(byId['post-2026-01-01-hello-en'].subtitle, 'Tag');
    assert.equal(byId['post-2026-01-01-hello-en'].text, 'don\u2019t \u2014 stop');
    const sec = byId['post-2026-01-03-secret'];
    assert.equal(sec.private, true);
    assert.equal(sec.subtitle, '只有标签');
    assert.equal([...sec.text].length, TEXT_MAX);
    assert.equal('private' in zh, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('构建产物里缺文章页 → 报错（网址规则变了不许写错地址）；未来日期的文章跳过', () => {
  const { dir, content, pub } = fixture();
  try {
    rmSync(path.join(pub, 'zh'), { recursive: true });
    assert.throws(() => build({ contentDir: content, publicDir: pub }), /构建产物里没有 \/zh\/post\/2026-01-01-hello\//);
    const ix = build({ contentDir: content, publicDir: pub, now: new Date('2025-12-31T00:00:00Z') });
    assert.equal(ix.items.length, 0);
    assert.throws(() => build({ contentDir: content, publicDir: path.join(dir, 'nope') }), /先跑 npm run build/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('真实构建：每篇非草稿文章都在索引里，网址和站点地图一致，有正文', () => {
  const ix = build();
  const posts = ix.items.filter((x) => x.type === 'post');
  assert.ok(posts.length > 0, '索引里没有文章');
  let expected = 0;
  /* 合站后中英文章同在 content/blog/post/（中文 <名>.zh.md） */
  const dir = path.join(ROOT, 'space/web/content/blog/post');
  for (const n of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    if (parseFrontMatter(readFileSync(path.join(dir, n), 'utf8')).draft !== true) expected++;
  }
  assert.equal(posts.length, expected);
  const sitemap = new Set([...readFileSync(path.join(ROOT, 'space/web/public/blog/sitemap-0.xml'), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decodeURI(m[1])));
  for (const p of posts) {
    assert.match(p.url, /^https:\/\/styrigx\.com\/blog\/(zh\/)?post\/[^/]+\/$/);
    if (!p.private) assert.ok(sitemap.has(p.url), p.url + ' 不在站点地图里');
    assert.ok(p.title && p.text.length > 100, p.url + ' 缺标题或正文');
    assert.ok([...p.text].length <= TEXT_MAX);
    assert.equal(p.lang, p.url.includes('/blog/zh/') ? 'zh' : 'en');
  }
  assert.equal(new Set(posts.map((p) => p.id)).size, posts.length, 'id 重复');
});
