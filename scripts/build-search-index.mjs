#!/usr/bin/env node
/**
 * 生成主站的全站搜索索引 web/public/search-index.json（styrigx-search-index 的 KV site:space）。
 *
 * 来源（都在 hugo 构建后的 web/public/ 里）：
 *   - files-index.json：我的站点、应用（type site / app）。博客文章不在这里：博客自己写 KV site:blog，
 *     主站不再顺带（2026-10-22 删掉 gen-posts-json）；万一 files-index 里混进 type post 也丢掉
 *   - settings/**、en/settings/** 每个页面：标题取 <title> 去掉「 | Styrigx」，类型 setting
 *     账号页（/settings/account/…）标 private（只给站长搜到）；二级页副标题 = 上一级页名（两个「安全与隐私」分得清）
 *   - data/features.yaml 里用户能改的开关（user: true、build: true、有 section 页）：名字 + 选项名，跳到所在设置页
 * 格式见 workers/search-index/src/rank.js 顶部。deploy.yml 的 deploy-search-worker 把它写进 KV。
 *
 * 用法：node scripts/build-search-index.mjs [--out <文件>]（默认 web/public/search-index.json）
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(REPO, 'web/public');
const ORIGIN = 'https://styrigx.com';

/** @param {string} s */
function unesc(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** @param {string} dir @returns {string[]} */
function htmlFiles(dir) {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) out.push(...htmlFiles(p));
    else if (n === 'index.html') out.push(p);
  }
  return out.sort();
}

/** @param {string} html */
export function pageTitle(html) {
  const m = html.match(/<title>([^<]*)<\/title>/);
  if (!m) return '';
  return unesc(m[1]).replace(/\s*\|\s*Styrigx\s*$/, '').trim();
}

export function build() {
  /** @type {any[]} */
  const items = [];
  const fi = JSON.parse(readFileSync(path.join(PUB, 'files-index.json'), 'utf8'));
  for (const x of fi.items || []) {
    if (!x || !x.title || !x.url || x.type === 'post') continue;
    items.push({ id: x.id, type: x.type, lang: x.lang || 'zh', title: x.title, subtitle: x.subtitle || '', url: x.url.startsWith('/') ? ORIGIN + x.url : x.url });
  }
  for (const [lang, base] of [['zh', 'settings'], ['en', 'en/settings']]) {
    for (const f of htmlFiles(path.join(PUB, base))) {
      const rel = '/' + path.relative(PUB, path.dirname(f)).split(path.sep).join('/') + '/';
      const title = pageTitle(readFileSync(f, 'utf8'));
      if (!title || title === 'Styrigx') continue;
      items.push({
        id: 'setting:' + rel,
        type: 'setting',
        lang,
        title,
        subtitle: '',
        url: ORIGIN + rel,
        private: /\/settings\/account\//.test(rel) || undefined,
      });
    }
  }
  /* 二级页副标题 = 上一级页名 */
  const byUrl = new Map(items.filter((x) => x.type === 'setting').map((x) => [x.url, x]));
  for (const x of byUrl.values()) {
    const parent = x.url.replace(/[^/]+\/$/, '');
    const p = byUrl.get(parent);
    if (p && !/\/settings\/$/.test(parent)) x.subtitle = p.title;
  }
  /* 功能开关 */
  const feats = /** @type {any} */ (yaml.load(readFileSync(path.join(REPO, 'web/data/features.yaml'), 'utf8'))).features || [];
  for (const f of feats) {
    if (!f || !f.user || f.build === false || !f.section || !f.name) continue;
    for (const lang of ['zh', 'en']) {
      const url = ORIGIN + (lang === 'en' ? '/en' : '') + '/settings/' + f.section + '/';
      const page = byUrl.get(url);
      if (!page || !f.name[lang]) continue;
      items.push({
        id: 'feature:' + f.id + ':' + lang,
        type: 'setting',
        lang,
        title: f.name[lang],
        subtitle: page.title,
        text: (f.options || []).map((/** @type {any} */ o) => o[lang] || '').join(' '),
        url,
      });
    }
  }
  return { site: 'space', generated: new Date().toISOString(), items };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? process.argv[i + 1] : path.join(PUB, 'search-index.json');
  const ix = build();
  writeFileSync(out, JSON.stringify(ix));
  console.log('build-search-index: ' + ix.items.length + ' 条 → ' + path.relative(REPO, out));
}
