/**
 * 从博客仓库生成文章列表数据（CI 用）。
 * 
 * 背景：Hugo 构建时通过 resources.GetRemote 抓博客 rss.xml，
 * 但博客加了锁屏，rss 也被 302 到锁屏页，抓不到就静默跳过，
 * 导致门户搜索索引里文章数为 0。
 * 
 * 方案：CI 里 checkout 博客仓库，直接读文章文件生成 data/blog-posts.yaml，
 * 模板改读本地数据。rss 不从锁屏放出来（会把文章公开）。
 * 
 * 用法：node scripts/gen-blog-posts.mjs <blog-repo-path>
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const blogPath = process.argv[2] || '../styrigx-blog';
const outPath = 'data/blog-posts.yaml';

function getPosts(dir, lang) {
  const posts = [];
  const postsDir = join(blogPath, dir);
  if (!existsSync(postsDir)) return posts;
  
  for (const file of readdirSync(postsDir)) {
    if (!file.endsWith('.md')) continue;
    const content = readFileSync(join(postsDir, file), 'utf8');
    // 解析 frontmatter
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) continue;
    const fm = match[1];
    const title = (fm.match(/^title:\s*["']?(.+?)["']?$/m) || [])[1] || file;
    const date = (fm.match(/^date:\s*(.+)$/m) || [])[1] || '';
    const slug = file.replace(/\.md$/, '');
    const url = lang === 'en' 
      ? `https://blog.styrigx.com/en/post/${slug}/`
      : `https://blog.styrigx.com/post/${slug}/`;
    posts.push({ title: title.trim(), url, lang, date: date.trim() });
  }
  return posts;
}

const zhPosts = getPosts('content/post', 'zh');
const enPosts = getPosts('content/en/post', 'en');
const allPosts = [...zhPosts, ...enPosts];

// 生成 YAML
let yaml = '# 自动生成：博客文章列表（CI 从博客仓库读取）\n';
yaml += `# 生成时间：${new Date().toISOString()}\n`;
for (const p of allPosts) {
  yaml += `- title: "${p.title.replace(/"/g, '\\"')}"\n`;
  yaml += `  url: ${p.url}\n`;
  yaml += `  lang: ${p.lang}\n`;
  if (p.date) yaml += `  date: ${p.date}\n`;
}

writeFileSync(outPath, yaml);
console.log(`Generated ${outPath}: ${allPosts.length} posts (${zhPosts.length} zh, ${enPosts.length} en)`);

// 断言：文章数 > 0
if (allPosts.length === 0) {
  console.error('ERROR: No blog posts found!');
  process.exit(1);
}
