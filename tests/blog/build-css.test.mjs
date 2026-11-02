/**
 * 构建产物检查：顶栏 / 抽屉的毛玻璃在最终压缩后的 CSS 里必须同时保留标准写法和 -webkit- 前缀。
 * 背景：lightningcss（Tailwind 4 内置）会把两行合并成只剩 -webkit-backdrop-filter，Chromium（三星浏览器）就没有模糊了；
 * 所以 scripts/build-css.mjs 只让 Tailwind 处理 tw-input.css，博客 / 共享外壳的样式拼在后面交给 Hugo 压缩。
 * 这个测试读 web/public/css/main.min.*.css，必须先 npm run build。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSS_DIR = path.join(REPO, 'web/blog/public/css');

function builtCss() {
  assert.ok(existsSync(CSS_DIR), 'web/blog/public/css 不存在：先 npm run build');
  const files = readdirSync(CSS_DIR).filter((f) => /^main\.min\..+\.css$/.test(f));
  assert.equal(files.length, 1, `web/blog/public/css 里应该正好一个 main.min.*.css，实际：${files.join(', ') || '无'}`);
  return { file: files[0], css: readFileSync(path.join(CSS_DIR, files[0]), 'utf8') };
}

/** 找出选择器列表里包含 selector 的所有规则块（不进 @supports 的降级块，那里只有纯色背景） */
function rulesFor(css, selector) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sels = m[1].split(',').map((s) => s.trim());
    if (sels.includes(selector)) out.push(m[2]);
  }
  return out;
}

const hasStd = (body) => /(^|[;{\s])backdrop-filter\s*:/.test(body);
const hasWebkit = (body) => /-webkit-backdrop-filter\s*:/.test(body);

/* 两种写法可以在同一条规则里，也可以分开（主站共享外壳可能把标准写法放进 @supports (backdrop-filter: …) 防止被压缩器合并）；
   只要求最终 CSS 里两种都在、值都是 --sgx-mat-filter。降级块 @supports not (…) 里只有纯色背景，不影响判断。 */
for (const selector of ['.sgx-tb-pill', '.sgx-tb-nav', '.sgx-drawer-sheet']) {
  test(`${selector}：构建后的 CSS 同时有 backdrop-filter 和 -webkit-backdrop-filter`, () => {
    const { file, css } = builtCss();
    const glass = rulesFor(css, selector).filter((b) => hasStd(b) || hasWebkit(b));
    assert.ok(glass.length > 0, `${file} 里 ${selector} 没有任何 backdrop-filter 规则`);
    assert.ok(
      glass.some((b) => /(^|;)backdrop-filter:var\(--sgx-mat-filter\)/.test(b)),
      `${selector} 丢了标准 backdrop-filter（Chromium / 三星浏览器没有毛玻璃）：\n${glass.join('\n')}`,
    );
    assert.ok(
      glass.some((b) => /-webkit-backdrop-filter:var\(--sgx-mat-filter\)/.test(b)),
      `${selector} 丢了 -webkit-backdrop-filter（Safari 没有毛玻璃）：\n${glass.join('\n')}`,
    );
  });
}

