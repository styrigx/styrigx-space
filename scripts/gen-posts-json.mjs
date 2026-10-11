/**
 * 从博客仓库生成文章列表 data/posts.json（P0-2）。
 *
 * 背景：layouts/index.filesindex.json 用 resources.GetRemote 抓博客 rss.xml，
 * 但博客有锁屏，rss 被 302，模板静默跳过，type=post 为 0。
 * 方案：CI 用 GitHub API 读博客仓库的公开文章，生成本地 JSON，模板改读 site.Data.posts。
 *
 * 用法：BLOG_TOKEN=xxx node scripts/gen-posts-json.mjs
 *   BLOG_TOKEN 可选（公开仓库匿名可读，但有 rate limit；CI 建议配只读 token）
 *   输出：data/posts.json（[{title, url, date, lang}]）
 *
 * 失败条件（exit 非 0，构建失败）：
 * - API 请求失败或非 200
 * - 文章数为 0
 */
import { writeFileSync } from 'fs';

const BLOG_OWNER = 'styrigx';
const BLOG_REPO = 'styrigx-blog';
const TOKEN = process.env.BLOG_TOKEN || '';

async function ghApi(path) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'styrigx-space-ci',
  };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${path}`);
  }
  return res.json();
}

async function getPosts(langDir, lang) {
  const items = await ghApi(`/repos/${BLOG_OWNER}/${BLOG_REPO}/contents/src/content/blog/${langDir}`);
  const posts = [];
  for (const item of items) {
    if (item.type !== 'file' || !item.name.endsWith('.md')) continue;
    // 读文件内容解析 frontmatter
    const file = await ghApi(`/repos/${BLOG_OWNER}/${BLOG_REPO}/contents/${item.path}`);
    const content = Buffer.from(file.content, 'base64').toString('utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const fm = fmMatch[1];
    // 排除草稿和私有
    if (/^draft:\s*true/m.test(fm)) continue;
    if (/^private:\s*true/m.test(fm)) continue;
    const title = (fm.match(/^title:\s*["']?(.+?)["']?$/m) || [])[1]?.trim();
    const date = (fm.match(/^date:\s*(\d{4}-\d{2}-\d{2})/m) || [])[1]?.trim();
    if (!title || !date) continue;
    // URL：https://blog.styrigx.com/post/<slug>/ 或 /en/post/<slug>/
    const slug = item.name.replace(/\.md$/, '');
    const url = lang === 'en'
      ? `https://blog.styrigx.com/en/post/${slug}/`
      : `https://blog.styrigx.com/post/${slug}/`;
    posts.push({ title, url, date, lang });
  }
  return posts;
}

const zhPosts = await getPosts('zh', 'zh');
const enPosts = await getPosts('en', 'en');
const allPosts = [...zhPosts, ...enPosts].sort((a, b) => b.date.localeCompare(a.date));

console.log(`Found ${zhPosts.length} zh posts, ${enPosts.length} en posts`);

if (allPosts.length === 0) {
  console.error('ERROR: No blog posts found, failing build');
  process.exit(1);
}

writeFileSync('data/posts.json', JSON.stringify(allPosts, null, 2) + '\n');
console.log(`Wrote data/posts.json with ${allPosts.length} posts`);
