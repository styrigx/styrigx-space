#!/usr/bin/env node
/**
 * 生成主站的全站索引 space/web/public/search-index.json（KV styrigx-search-index 的 site:space，styrigx-ai 召回用；P4-2b 起由 deploy-ai-worker 写）。
 *
 * 来源（都在 hugo 构建后的 space/web/public/ 里）：
 *   - files-index.json：我的站点、应用（type site / app）。博客文章不在这里：博客自己写 KV site:blog，
 *     主站不再顺带
 *   - 旷野页（/、en/）、旷野子页（data/space-cats.yaml 的每个分类：display/**、security/** …，英文加 en/；P4-3 PR-4b 起去掉 settings 一层）、
 *     account/**、en/account/** 每个页面：标题取 <title> 去掉「 | Styrigx」，类型 setting
 *     账号页（/account/…）和旷野里的门内页（临时钥匙 /security/tempkeys/、服务状态 /status/）标 private（只给账号已登录的人搜到）
 *     副标题 = 完整面包屑：从地址逐级取上级页名，用「 › 」连起来，旷野子页最上一级是旷野页（锁屏凭证 → 「旷野 › 安全」；P4-3 PR-2 / PR-4b），
 *     AI 才说得出路径；账号页独立（/account/… 不挂在旷野下）
 *     text = 页面 <main> 里的分组标题、设置行标题和说明，加上上级页里指向本页那一行的说明（锁屏凭证 → 「解锁密码、通行密钥、会话 …」），
 *     截到 TEXT_MAX 字；只给 AI 读（召回里正文权重最低，rank.js / recall.js 不改）
 *   - data/features.yaml 里用户能改的开关（user: true、build: true、有 section 页）：名字 + 选项名，跳到所在设置页
 *   - 功能开关的副标题 = 所在旷野子页的面包屑 + 页名（「旷野 › 显示」）
 * 格式见 workers/ai/src/core/rank.js 顶部。deploy.yml 的 deploy-ai-worker 把它写进 KV。
 *
 * 用法：node space/scripts/build-search-index.mjs [--out <文件>]（默认 space/web/public/search-index.json）
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUB = path.join(REPO, 'space/web/public');
const ORIGIN = 'https://styrigx.com';
/** 面包屑分隔 */
export const CRUMB = ' › ';
/** 每条 text 最多多少字 */
export const TEXT_MAX = 200;

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

/**
 * 页面 <main> 里的文字：分组标题（.set-gh）、设置行（font-medium 标题 + 紧跟的 text-xs 说明），行在 <a href> 里时带上地址。
 * 「正在读取…」这类运行时才填的占位说明不要。
 * @param {string} html
 * @returns {{heads: string[], rows: Array<{title: string, sub: string, href: string}>}}
 */
export function pageText(html) {
  const m = html.match(/<main\b[\s\S]*?<\/main>/);
  const main = (m ? m[0] : '').replace(/<(script|svg|style|template)\b[\s\S]*?<\/\1>/g, '');
  /** @type {string[]} */
  const heads = [];
  /** @type {Array<{title: string, sub: string, href: string}>} */
  const rows = [];
  const clean = (/** @type {string} */ x) => unesc(x).replace(/\s+/g, ' ').trim();
  const re = /<a\b[^>]*\bhref="([^"]*)"[^>]*>|<\/a>|class="set-gh"[^>]*>[\s\S]*?<span>([^<]*)<\/span><\/h2>|class="block font-medium"[^>]*>([^<]*)<\/span>\s*(?:<span class="block text-xs[^"]*"[^>]*>([^<]*)<\/span>)?/g;
  let href = '';
  for (let r; (r = re.exec(main));) {
    if (r[1] !== undefined) href = r[1];
    else if (r[0] === '</a>') href = '';
    else if (r[2] !== undefined) { const t = clean(r[2]); if (t) heads.push(t); }
    else {
      const title = clean(r[3] || '');
      const sub = clean(r[4] || '');
      if (title) rows.push({ title, sub: /…$|\.\.\.$/.test(sub) ? '' : sub, href });
    }
  }
  return { heads, rows };
}

/** @param {string[]} parts */
function joinText(parts) {
  /** @type {string[]} */
  const out = [];
  for (const p of parts) if (p && out.indexOf(p) === -1) out.push(p);
  return out.join(' ').slice(0, TEXT_MAX);
}

/** @param {string} [pub] hugo 产物目录（默认 space/web/public；单测传临时目录） */
export function build(pub = PUB) {
  /** @type {any[]} */
  const items = [];
  const fi = JSON.parse(readFileSync(path.join(pub, 'files-index.json'), 'utf8'));
  for (const x of fi.items || []) {
    if (!x || !x.title || !x.url) continue;
    items.push({ id: x.id, type: x.type, lang: x.lang || 'zh', title: x.title, subtitle: x.subtitle || '', url: x.url.startsWith('/') ? ORIGIN + x.url : x.url });
  }
  /** @type {Map<string, {heads: string[], rows: Array<{title: string, sub: string, href: string}>}>} */
  const pages = new Map();
  /* 旷野页本身（根路径 index.html）+ 各分类子页目录 + 账号页目录 */
  const cats = (/** @type {any} */ (yaml.load(readFileSync(path.join(REPO, 'space/web/data/space-cats.yaml'), 'utf8'))).cats || []).map((/** @type {any} */ c) => String(c.id));
  /** @type {Array<[string, string[]]>} */
  const sources = [];
  for (const [lang, pre] of [['zh', ''], ['en', 'en/']]) {
    const rootHtml = path.join(pub, pre, 'index.html');
    sources.push([lang, existsSync(rootHtml) ? [rootHtml] : []]);
    for (const base of [...cats, 'account']) sources.push([lang, htmlFiles(path.join(pub, pre + base))]);
  }
  for (const [lang, files] of sources) {
    for (const f of files) {
      const rel = ('/' + path.relative(pub, path.dirname(f)).split(path.sep).join('/') + '/').replace(/^\/\/$/, '/');
      const html = readFileSync(f, 'utf8');
      /* 搬走 / 删掉的设置页留下的跳转页（layouts/alias.html）不进索引 */
      if (/<meta http-equiv="?refresh/i.test(html)) continue;
      const title = pageTitle(html);
      if (!title || title === 'Styrigx') continue;
      pages.set(ORIGIN + rel, pageText(html));
      items.push({
        id: 'setting:' + rel,
        type: 'setting',
        lang,
        title,
        subtitle: '',
        url: ORIGIN + rel,
        private: /^\/(en\/)?(account\/|security\/tempkeys\/|status\/)/.test(rel) || undefined,
      });
    }
  }
  /* 副标题 = 完整面包屑（上级页名从高到低）；text = 上级页里指向本页那一行的说明 + 本页的分组标题和设置行 */
  const byUrl = new Map(items.filter((x) => x.type === 'setting').map((x) => [x.url, x]));
  /** @type {Map<string, string>} 页面地址 → 上级页里指向它的那一行的说明 */
  const rowSub = new Map();
  for (const pg of pages.values()) for (const r of pg.rows) if (r.href && r.sub) rowSub.set(ORIGIN + r.href, r.sub);
  for (const x of byUrl.values()) {
    /** @type {string[]} */
    const crumbs = [];
    /* 语言根（/ 或 /en/）= 旷野页：旷野子页的最上一级；旷野页自己和账号页（独立）不挂 */
    const root = ORIGIN + (x.lang === 'en' ? '/en/' : '/');
    const underSpace = x.url !== root && !/^\/(en\/)?account\//.test(x.url.slice(ORIGIN.length));
    for (let u = x.url.replace(/[^/]+\/$/, ''); u.length > root.length; u = u.replace(/[^/]+\/$/, '')) {
      const p = byUrl.get(u);
      if (p) crumbs.unshift(p.title);
    }
    if (underSpace && byUrl.get(root)) crumbs.unshift(/** @type {any} */ (byUrl.get(root)).title);
    x.subtitle = crumbs.join(CRUMB);
    const pg = pages.get(x.url);
    const text = joinText([rowSub.get(x.url) || '', ...(pg ? pg.heads : []), ...(pg ? pg.rows.flatMap((r) => [r.title, r.sub]) : [])]);
    if (text) x.text = text;
  }
  /* 功能开关 */
  const feats = /** @type {any} */ (yaml.load(readFileSync(path.join(REPO, 'space/web/data/features.yaml'), 'utf8'))).features || [];
  for (const f of feats) {
    if (!f || !f.user || f.build === false || !f.section || !f.name) continue;
    for (const lang of ['zh', 'en']) {
      const url = ORIGIN + (lang === 'en' ? '/en' : '') + '/' + f.section + '/';
      const page = byUrl.get(url);
      if (!page || !f.name[lang]) continue;
      items.push({
        id: 'feature:' + f.id + ':' + lang,
        type: 'setting',
        lang,
        title: f.name[lang],
        subtitle: page.subtitle ? page.subtitle + CRUMB + page.title : page.title,
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
  mkdirSync(path.dirname(out), { recursive: true }); // --out 可指向尚不存在的目录（CI 写 $RUNNER_TEMP/search-index/）
  writeFileSync(out, JSON.stringify(ix));
  console.log('build-search-index: ' + ix.items.length + ' 条 → ' + path.relative(REPO, out));
}
