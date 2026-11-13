#!/usr/bin/env node
/**
 * 构建博客 CSS → space/web/assets/blog/css/main.css（不进仓库；Hugo 再压缩 + 加内容指纹，见 partials/head.html）。
 * 和主站 space/scripts/build/build-css.cjs 同一个做法：
 *   1. @tailwindcss/cli（版本见 package.json）单独构建 space/web/assets/blog/css/tw-input.css；
 *   2. 博客自己的样式（space/web/assets/blog/css/input.css 按 @import 顺序展开）原样拼在后面，不过 Tailwind 的 lightningcss。
 * 原因：lightningcss 会把 `backdrop-filter: var(…); -webkit-backdrop-filter: var(…)` 合并成只剩 -webkit- 前缀，
 * Chromium（三星浏览器）就没有毛玻璃了（共享外壳的顶栏 / 抽屉都是这种写法）。
 * 用法：node space/scripts/blog/build-css.mjs（node space/scripts/build/build-css.cjs 会顺带跑）
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* 仓库根是 REPO；博客是主站 Hugo 站 space/web/ 的一个分区，样式源在 space/web/assets/blog/css/ */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CSS = path.join(REPO, 'space/web/assets/blog/css');
const out = path.join(CSS, 'main.css');
const tmp = path.join(CSS, '.tw-out.css');

execFileSync('npx', ['--no-install', '@tailwindcss/cli', '-i', path.join(CSS, 'tw-input.css'), '-o', tmp, '--minify'], {
  cwd: path.join(REPO, 'space/web'),
  stdio: 'inherit',
});
const tw = readFileSync(tmp, 'utf8');
unlinkSync(tmp);

/** 展开 @import './x.css';（只认相对路径，按出现顺序） */
function expand(file, seen = new Set()) {
  if (seen.has(file)) throw new Error('循环 @import：' + file);
  seen.add(file);
  return readFileSync(file, 'utf8').replace(/^@import\s+'(\.[^']+)';\s*$/gm, (_, rel) => {
    const f = path.resolve(path.dirname(file), rel);
    if (!existsSync(f)) throw new Error('找不到 ' + rel + '（' + path.relative(REPO, file) + '）');
    return `/* ---- ${path.relative(CSS, f)} ---- */\n` + expand(f, seen);
  });
}

const css = tw + '\n' + expand(path.join(CSS, 'input.css'));
writeFileSync(out, css);
console.log('CSS built:', css.length, 'bytes →', path.relative(REPO, out));
