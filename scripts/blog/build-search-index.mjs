#!/usr/bin/env node
/**
 * 生成博客在全站搜索里的索引（styrigx-search-index 读 KV 的 site:blog）。
 * 格式见主站 styrigx-space workers/search-index/src/rank.js 顶部：
 *   { site: 'blog', generated, items: [{ id, type: 'post', lang, title, subtitle?, text?, url, private? }] }
 *
 * 来源：
 *   - web/content/<lang>/post/*.md 的 front matter：标题、描述、标签、draft、private
 *     （draft: true 跳过；private: true 标 private，只给管理员搜到——和 index.sitemap0.xml 的 .Params.private 是同一个开关）
 *   - hugo 构建后的 web/public/[en/]post/<文件名>/index.html：正文（<section id="article-start"> 里，短代码 / Markdown 已渲染好），
 *     去掉代码块标题栏和行号、HTML 标签，压成纯文本，最多 2000 字。
 *     网址按 hugo.yaml 的 permalinks（/post/:contentbasename/，英文带 /en/）拼，并核对构建产物里确实有这一页——
 *     没有就报错（网址规则改了 → 这里红，不会把错地址写进索引）。
 *
 * 用法：npm run build 之后 node scripts/build-search-index.mjs [--out <文件>]（默认 web/public 外的 search-index.blog.json）
 *   不写进 web/public/：正文含 private 文章，不能随 Pages 发出去。deploy.yml 在 main 上把它写进 KV。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* 2026-11-02 并进 styrigx-space：仓库根是 REPO，博客页面包在 web/blog/ */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 博客在图志下的地址（不带结尾斜杠）；条目链接 = SITE_URL + 产物里的相对地址 */
export const SITE_URL = 'https://atlas.styrigx.com/blog';
export const TEXT_MAX = 2000;
export const SUBTITLE_MAX = 120;
const LANGS = /** @type {const} */ (['zh', 'en']);

/** @param {string} s */
function unquote(s) {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const q = s[0];
    s = s.slice(1, -1);
    return q === '"' ? s.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : s.replace(/''/g, "'");
  }
  return s;
}

/**
 * 只读本仓库文章用到的 front matter 写法：`key: 值`、`key: ["a", "b"]`、`key:` 下一行起 `  - a`、true/false。
 * @param {string} md
 * @returns {Record<string, any>}
 */
export function parseFrontMatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  /** @type {Record<string, any>} */
  const fm = {};
  if (!m) return fm;
  /** @type {string|null} */
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      fm[listKey].push(unquote(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    const v = raw.replace(/\s+#.*$/, '').trim();
    listKey = null;
    if (v === '') {
      fm[key] = [];
      listKey = key;
    } else if (v.startsWith('[') && v.endsWith(']')) {
      const inner = v.slice(1, -1).trim();
      fm[key] = inner ? (inner.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^,]+/g) || []).map(unquote).map((x) => x.trim()).filter(Boolean) : [];
    } else if (/^(true|false)$/i.test(v)) {
      fm[key] = v.toLowerCase() === 'true';
    } else {
      fm[key] = unquote(raw.trim());
    }
  }
  return fm;
}

/** Goldmark typographer / 常见命名实体（&amp; 最后解，避免二次解码） */
const NAMED = /** @type {Record<string, string>} */ ({
  nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', laquo: '\u00ab', raquo: '\u00bb', middot: '\u00b7', times: '\u00d7', copy: '\u00a9',
});

/** @param {string} s */
export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (n === 'amp' ? m : NAMED[n] ?? m))
    .replace(/&amp;/g, '&');
}

/**
 * 文章页 HTML → 正文纯文本（只取 <section id="article-start"> 里的内容）。
 * @param {string} html
 * @param {number} [max]
 */
export function articleText(html, max = TEXT_MAX) {
  const m = html.match(/<section id="article-start"[^>]*>([\s\S]*?)<\/section>\s*<\/article>/);
  if (!m) return '';
  const body = m[1]
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<figcaption class="code-head"[\s\S]*?<\/figcaption>/g, ' ') // 代码块标题栏（语言 · 复制按钮）
    .replace(/<span class="ln"[^>]*>[^<]*<\/span>/g, '') // 行号
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(p|div|h[1-6]|li|ul|ol|pre|tr|td|th|table|blockquote|figure|section|br|hr|span class="line")\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  const text = decodeEntities(body).replace(/\s+/g, ' ').trim();
  return [...text].slice(0, max).join('');
}

/** @param {string} s @param {number} max */
function clip(s, max) {
  const a = [...String(s || '').replace(/\s+/g, ' ').trim()];
  return a.length > max ? a.slice(0, max - 1).join('') + '…' : a.join('');
}

/**
 * @param {{ contentDir?: string, publicDir?: string, now?: Date }} [opt]
 */
export function build(opt = {}) {
  const contentDir = opt.contentDir || path.join(REPO, 'web/blog/content');
  const publicDir = opt.publicDir || path.join(REPO, 'web/blog/public');
  const now = opt.now || new Date();
  if (!existsSync(publicDir)) throw new Error('build-search-index: ' + publicDir + ' 不存在：先跑 npm run build');
  /** @type {any[]} */
  const items = [];
  for (const lang of LANGS) {
    const dir = path.join(contentDir, lang, 'post');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.md') && !n.startsWith('_')).sort()) {
      const fm = parseFrontMatter(readFileSync(path.join(dir, name), 'utf8'));
      if (fm.draft === true) continue;
      if (fm.date && !Number.isNaN(Date.parse(fm.date)) && Date.parse(fm.date) > now.getTime()) continue; // hugo 默认不发未来文章
      const slug = name.replace(/\.md$/, '');
      const rel = (lang === 'en' ? '/en' : '') + '/post/' + slug + '/';
      const file = path.join(publicDir, rel, 'index.html');
      if (!existsSync(file)) throw new Error('build-search-index: 构建产物里没有 ' + rel + '（' + lang + '/post/' + name + '）');
      const html = readFileSync(file, 'utf8');
      const h1 = html.match(/<h1>([^<]*)<\/h1>/);
      const title = String(fm.title || (h1 ? decodeEntities(h1[1]) : '')).trim();
      if (!title) continue;
      const tags = Array.isArray(fm.tags) ? fm.tags : [];
      /** @type {any} */
      const it = {
        id: 'post-' + slug + (lang === 'en' ? '-en' : ''),
        type: 'post',
        lang,
        title,
        subtitle: clip(fm.description || fm.summary || tags[0] || '', SUBTITLE_MAX),
        text: articleText(html),
        url: SITE_URL + rel,
      };
      if (fm.private === true) it.private = true;
      items.push(it);
    }
  }
  return { site: 'blog', generated: now.toISOString(), items };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? process.argv[i + 1] : path.join(REPO, 'search-index.blog.json');
  const ix = build();
  const posts = ix.items.filter((x) => x.type === 'post').length;
  if (posts === 0) {
    console.error('build-search-index: 0 篇文章，不写');
    process.exit(1);
  }
  writeFileSync(out, JSON.stringify(ix));
  console.log('build-search-index: ' + posts + ' 篇文章（zh ' + ix.items.filter((x) => x.lang === 'zh').length + ' / en ' + ix.items.filter((x) => x.lang === 'en').length + '）→ ' + path.relative(REPO, out));
}
