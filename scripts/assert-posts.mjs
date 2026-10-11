/**
 * 断言：public/files-index.json 中 type=post 条目数 > 0（P0-2）。
 * 每条 post 的 url 非空且以 https://blog.styrigx.com 开头。
 * 失败时 exit 非 0，CI 失败。
 */
import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('public/files-index.json', 'utf-8'));
const posts = (data.items || []).filter((it) => it.type === 'post');

console.log(`Found ${posts.length} posts in files-index.json`);

if (posts.length === 0) {
  console.error('ERROR: No posts in files-index.json (type=post count is 0)');
  process.exit(1);
}

const zhPosts = posts.filter((p) => p.lang === 'zh');
const enPosts = posts.filter((p) => p.lang === 'en');
console.log(`  zh: ${zhPosts.length}, en: ${enPosts.length}`);

if (zhPosts.length === 0) {
  console.error('ERROR: No zh posts');
  process.exit(1);
}
if (enPosts.length === 0) {
  console.error('ERROR: No en posts');
  process.exit(1);
}

for (const p of posts) {
  if (!p.url || !p.url.startsWith('https://blog.styrigx.com')) {
    console.error(`ERROR: Invalid post URL: ${JSON.stringify(p)}`);
    process.exit(1);
  }
}

console.log('All post assertions passed');
