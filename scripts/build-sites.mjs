#!/usr/bin/env node
/**
 * 四包各自构建，再拼成一棵树（合并 PR2）：
 *   主站   node scripts/build-css.cjs --minify → hugo --minify --cleanDestinationDir -s web/atlas      → web/atlas/public/
 *   blog   node scripts/blog/build-css.mjs     → hugo --minify --cleanDestinationDir -s web/blog       → web/blog/public/
 *   curio  tailwindcss -i web/curio/assets/css/input.css -o …/main.css --minify → hugo … -s web/curio  → web/curio/public/
 *   daymark 同 curio                                                                                   → web/daymark/public/
 *   拼树   node scripts/assemble.mjs                                                                    → dist/site/
 *
 * 用法：
 *   node scripts/build-sites.mjs            全部（npm run build）
 *   node scripts/build-sites.mjs --sites    只构建三个子站，不构建主站、不拼树（npm run build:sites；CI 的主站构建要带 SGX_BUILD_SHA，单独一步）
 * 主站构建的环境变量（SGX_BUILD_SHA、SGX_TEST_NO_LOCK …）原样传给 hugo。Hugo 版本见 .github/actions/setup-hugo。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble, SITES } from './assemble.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args) {
  console.log('$ ' + [cmd, ...args].join(' '));
  const r = spawnSync(cmd, args, { cwd: REPO, stdio: 'inherit' });
  if (r.error) throw new Error(`${cmd} 启动失败：${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败（退出码 ${r.status}）`);
}

/** 子站 CSS + Hugo（产物 web/<站>/public/，每次清空重建） */
export function buildSite(site) {
  if (site === 'blog') run(process.execPath, ['scripts/blog/build-css.mjs']);
  else run('npx', ['--no-install', 'tailwindcss', '-i', `web/${site}/assets/css/input.css`, '-o', `web/${site}/assets/css/main.css`, '--minify']);
  run('hugo', ['--minify', '--cleanDestinationDir', '-s', `web/${site}`]);
}

export function buildMain() {
  run(process.execPath, ['scripts/build-css.cjs', '--minify']);
  run('hugo', ['--minify', '--cleanDestinationDir', '-s', 'web/atlas']);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const extra = process.argv.slice(2).filter((a) => a !== '--sites');
  try {
    if (extra.length) throw new Error('build-sites：未知参数 ' + extra.join(' ') + '（用法：node scripts/build-sites.mjs [--sites]）');
    const sitesOnly = process.argv.includes('--sites');
    if (!sitesOnly) buildMain();
    for (const s of SITES) buildSite(s);
    if (!sitesOnly) console.log('assembled ' + path.relative(REPO, assemble()) + '/');
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}
