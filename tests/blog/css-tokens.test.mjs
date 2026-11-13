/**
 * 样式只用共享外壳的色彩角色（--sgx-*）：博客自己的样式里不能再出现旧主题的别名令牌
 * --paper-* / --m-* / --glass-*（别名层已删除）。共享外壳样式（2026-11 合站后直接 @import 主站的 assets/common/css/tokens.css、shell.css）不在这里管；
 * main.css 是 space/scripts/blog/build-css.mjs 的生成物（不进仓库，里面拼了外壳副本），也跳过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSS_ROOT = path.join(REPO, 'space/web/assets/blog/css');
const SKIP = new Set(['sgx-shell.css', 'main.css']);
const LEGACY = /--(paper|m|glass)-[a-z0-9-]*/g;

function cssFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...cssFiles(p));
    else if (name.endsWith('.css') && !(dir === CSS_ROOT && SKIP.has(name))) out.push(p);
  }
  return out;
}

test('space/web/assets/blog/css 里没有 --paper-* / --m-* / --glass-* 令牌（不含共享外壳副本）', () => {
  const files = cssFiles(CSS_ROOT);
  assert.ok(files.length > 0, '没找到 space/web/assets/blog/css 下的样式文件');
  const hits = [];
  for (const f of files) {
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const m = line.match(LEGACY);
        if (m) hits.push(`${path.relative(REPO, f)}:${i + 1}  ${[...new Set(m)].join(' ')}`);
      });
  }
  assert.deepEqual(hits, [], `还有旧令牌：\n${hits.join('\n')}`);
});

test('回到顶部按钮用博客自己的 .scroll-top-button（2026-11-04 P5-1 共享外壳的顶栏圆钮 .sgx-tb-nav 删了，不再借用）', () => {
  const partial = readFileSync(path.join(REPO, 'space/web/layouts/partials/blog/scroll-top.html'), 'utf8');
  assert.match(partial, /<button class="scroll-top-button"/);
  assert.doesNotMatch(partial, /class="[^"]*sgx-tb-nav/);
  const css = readFileSync(path.join(REPO, 'space/web/assets/blog/css/blog/components.css'), 'utf8');
  assert.match(css, /\.scroll-top-button \{[^}]*border-radius: 999px;/);
});
