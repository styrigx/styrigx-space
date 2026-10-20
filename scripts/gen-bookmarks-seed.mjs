#!/usr/bin/env node
/**
 * 书签种子：把 web/data/links.yaml（中文）+ web/data/en/links.yaml（英文）合并成
 * workers/auth-gateway/functions/_kernel/bookmarks-seed.js。
 *
 * 种子只在 D1 书签表第一次被读到、而且从没导入过时写进库（见 functions/api/bookmarks.js），之后以库为准。
 * 两份 YAML 必须同序、同网址（一条书签 = 中文名/简介 + 英文名/简介 + 一个网址）。
 *
 * 用法：node scripts/gen-bookmarks-seed.mjs          重新生成
 *       node scripts/gen-bookmarks-seed.mjs --check  只核对（不一致 exit 1，CI 用）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO, 'workers/auth-gateway/functions/_kernel/bookmarks-seed.js');

/**
 * 只认 links.yaml 这一种固定格式：
 * - category: 名字 / sites: / - name: / url: / desc:
 * @param {string} text
 * @returns {{category:string, sites:{name:string,url:string,desc:string}[]}[]}
 */
export function parseLinksYaml(text) {
  const out = [];
  /** @type {any} */ let cat = null;
  /** @type {any} */ let site = null;
  const val = (s) => {
    s = s.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
    return s;
  };
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    let m;
    if ((m = /^- category:\s*(.*)$/.exec(raw))) { cat = { category: val(m[1]), sites: [] }; out.push(cat); site = null; continue; }
    if (/^\s+sites:\s*$/.test(raw)) continue;
    if ((m = /^\s+- name:\s*(.*)$/.exec(raw))) { site = { name: val(m[1]), url: '', desc: '' }; cat.sites.push(site); continue; }
    if ((m = /^\s+(url|desc):\s*(.*)$/.exec(raw)) && site) { site[m[1]] = val(m[2]); continue; }
    throw new Error('links.yaml 看不懂这一行：' + raw);
  }
  return out;
}

export function buildSeed() {
  const zh = parseLinksYaml(readFileSync(path.join(REPO, 'web/data/links.yaml'), 'utf8'));
  const en = parseLinksYaml(readFileSync(path.join(REPO, 'web/data/en/links.yaml'), 'utf8'));
  if (zh.length !== en.length) throw new Error('中英文分类数量不一致');
  return zh.map((c, i) => {
    const e = en[i];
    if (c.sites.length !== e.sites.length) throw new Error('分类「' + c.category + '」中英文条数不一致');
    return {
      name: { zh: c.category, en: e.category },
      links: c.sites.map((s, j) => {
        if (s.url !== e.sites[j].url) throw new Error('网址不一致：' + s.url + ' / ' + e.sites[j].url);
        return { url: s.url, name: { zh: s.name, en: e.sites[j].name }, desc: { zh: s.desc, en: e.sites[j].desc } };
      }),
    };
  });
}

export function render(seed) {
  return (
    '/**\n * 书签种子（由 scripts/gen-bookmarks-seed.mjs 从 web/data/links.yaml + en/links.yaml 生成，不要手改）。\n' +
    ' * 只在 D1 第一次读书签、且从没导入过时写入；之后书签以 D1 为准。\n */\n' +
    'export const BOOKMARKS_SEED = ' + JSON.stringify(seed, null, 2) + ';\n'
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = render(buildSeed());
  if (process.argv.includes('--check')) {
    let cur = '';
    try { cur = readFileSync(OUT, 'utf8'); } catch (e) { /* 没有就算不一致 */ }
    if (cur !== text) { console.error('bookmarks-seed.js 和 links.yaml 不一致：跑 node scripts/gen-bookmarks-seed.mjs'); process.exit(1); }
    console.log('bookmarks seed OK');
  } else {
    writeFileSync(OUT, text);
    console.log('wrote ' + path.relative(REPO, OUT));
  }
}
