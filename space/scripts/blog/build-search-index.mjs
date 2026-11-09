#!/usr/bin/env node
/**
 * 生成博客在全站索引里的条目（styrigx-ai 召回时读 KV styrigx-space-core（进站 v3 L2b 前 styrigx-space-gateway，再之前 styrigx-search-index）的 site:blog；P4-2b 起由 deploy-ai-worker 写）。
 * 格式见主站 styrigx-space workers/ai/src/core/rank.js 顶部：
 *   { site: 'blog', generated, items: [{ id, type: 'post', lang, title, subtitle?, text?, url, private? }] }
 *
 * 来源：
 *   - space/web/content/blog/post/<文件名>.md（英文）/ <文件名>.zh.md（中文）的 front matter：标题、描述、标签、draft、private
 *     （draft: true 跳过；private: true 标 private，只给账号已登录的人搜到——和 index.sitemap0.xml 的 .Params.private 是同一个开关）
 *   - hugo 构建后的 space/web/public/blog/[zh/]post/<文件名>/index.html：正文（<section id="article-start"> 里，短代码 / Markdown 已渲染好），
 *     去掉代码块标题栏和行号、HTML 标签，压成纯文本，最多 TEXT_MAX 字（2026-11 AI 语义召回起 24000 字 ≈ 全文：
 *     styrigx-ai 的 Cron 把正文切段写进 Vectorize；关键词召回仍只取前 600 字进上下文）。
 *     网址按 hugo.yaml 的 permalinks（/blog/post/:contentbasename/，中文 /blog/zh/post/…：中文文章 front matter 的 url，前缀规则同主站 lib/lang-path.js）拼，并核对构建产物里确实有这一页——
 *     没有就报错（网址规则改了 → 这里红，不会把错地址写进索引）。
 *
 * 用法：npm run build 之后 node space/scripts/blog/build-search-index.mjs [--out <文件>]（默认仓库根的 search-index.blog.json）
 *   不写进 space/web/public/：正文含 private 文章，不能随 Pages 发出去。deploy.yml 在 main 上把它写进 KV。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { langPath } from '../../../space/web/assets/js/lib/lang-path.js';

/* 仓库根是 REPO；博客是主站 Hugo 站 space/web/ 的 blog 分区（2026-11 合站） */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** 博客的地址（不带结尾斜杠，= https://styrigx.com/ + blog 分区）；条目链接 = SITE_URL + 产物里的相对地址。
 *  合并 PR2 起跟 baseURL 一起改到主域名；本仓库到合并 PR3 才上传 site:blog，之前线上索引仍由 styrigx-atlas 仓库写 */
export const SITE_URL = 'https://styrigx.com/blog';
export const TEXT_MAX = 24000;
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
 * @param {{ contentDir?: string, publicDir?: string, now?: Date }} [opt] contentDir = 博客分区内容目录（下有 post/），publicDir = 博客产物目录（public/blog）
 */
export function build(opt = {}) {
  const contentDir = opt.contentDir || path.join(REPO, 'space/web/content/blog');
  const publicDir = opt.publicDir || path.join(REPO, 'space/web/public/blog');
  const now = opt.now || new Date();
  if (!existsSync(publicDir)) throw new Error('build-search-index: ' + publicDir + ' 不存在：先跑 npm run build');
  /** @type {any[]} */
  const items = [];
  for (const lang of LANGS) {
    /* 合站：同一目录，英文 <文件名>.md、中文 <文件名>.zh.md（Hugo 按文件名后缀分语言） */
    const dir = path.join(contentDir, 'post');
    if (!existsSync(dir)) continue;
    const ofLang = (n) => n.endsWith('.md') && !n.startsWith('_') && (lang === 'en' ? !/\.[a-z]{2,3}\.md$/.test(n) : n.endsWith('.' + lang + '.md'));
    for (const name of readdirSync(dir).filter(ofLang).sort()) {
      const fm = parseFrontMatter(readFileSync(path.join(dir, name), 'utf8'));
      if (fm.draft === true) continue;
      if (fm.date && !Number.isNaN(Date.parse(fm.date)) && Date.parse(fm.date) > now.getTime()) continue; // hugo 默认不发未来文章
      const slug = name.replace(/(\.[a-z]{2,3})?\.md$/, '');
      const rel = langPath('/blog/post/' + slug + '/', lang).slice('/blog'.length);
      const file = path.join(publicDir, rel, 'index.html');
      if (!existsSync(file)) throw new Error('build-search-index: 构建产物里没有 ' + rel + '（post/' + name + '）');
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
