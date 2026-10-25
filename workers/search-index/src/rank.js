/**
 * @fileoverview 全站搜索的分词和打分（纯函数，单测直接测）。
 *
 * 索引条目（KV site:<站名> 的值是 { site, generated, items: Item[] }）：
 *   { id, type, lang: 'zh'|'en', title, subtitle?, text?, url, private?: boolean }
 *   - type：post 文章 / setting 设置页 / app 应用 / site 站点 / quote 句子 / item 收藏 …（各站自己定，前端按 type 分组）
 *   - text：正文摘要（可选，最多约 2000 字，只参与匹配，不回给前端）
 *   - private：只给管理员（admin）搜到；访客永远看不到
 *
 * 匹配：查询拆成词——拉丁字母 / 数字按空格和标点切成词，中日韩按单字 + 相邻两字（二元组）。
 *   每个词都要命中（AND），在标题里命中分最高，副标题其次，正文最低；整句出现在标题里额外加分，标题以它开头再加。
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

/**
 * 查询 → 词表（去重）。CJK 连续段 ≥2 字时取二元组，否则单字；拉丁按非字母数字切。
 * @param {string} q
 * @returns {string[]}
 */
export function tokenize(q) {
  const s = String(q || '').toLowerCase().normalize('NFKC').slice(0, 100);
  /** @type {string[]} */
  const out = [];
  const push = (/** @type {string} */ t) => { if (t && out.indexOf(t) === -1) out.push(t); };
  let latin = '';
  let cjk = '';
  const flushLatin = () => { if (latin) push(latin); latin = ''; };
  const flushCjk = () => {
    if (cjk.length === 1) push(cjk);
    else for (let i = 0; i < cjk.length - 1; i++) push(cjk.slice(i, i + 2));
    cjk = '';
  };
  for (const ch of s) {
    if (CJK.test(ch)) { flushLatin(); cjk += ch; }
    else if (/[\p{L}\p{N}]/u.test(ch)) { flushCjk(); latin += ch; }
    else { flushLatin(); flushCjk(); }
  }
  flushLatin();
  flushCjk();
  return out.slice(0, 12);
}

/**
 * 给一条打分；任何一个词没命中 → 0。
 * @param {{title?: string, subtitle?: string, text?: string}} it
 * @param {string[]} toks
 * @param {string} phrase 小写整句
 */
export function score(it, toks, phrase) {
  const t = String(it.title || '').toLowerCase();
  const d = String(it.subtitle || '').toLowerCase();
  const x = String(it.text || '').toLowerCase();
  let s = 0;
  for (const k of toks) {
    if (t.indexOf(k) !== -1) s += 10;
    else if (d.indexOf(k) !== -1) s += 4;
    else if (x.indexOf(k) !== -1) s += 1;
    else return 0;
  }
  if (phrase && t.indexOf(phrase) !== -1) s += 15;
  if (phrase && t.indexOf(phrase) === 0) s += 10;
  if (t === phrase) s += 20;
  return s;
}

/**
 * 在若干站的索引里搜。
 * @param {Array<{site: string, items: any[]}>} indexes
 * @param {{q: string, lang?: string, admin?: boolean, site?: string, limit?: number}} opt
 * @returns {Array<{site: string, type: string, title: string, subtitle: string, url: string, score: number}>}
 */
export function search(indexes, opt) {
  const phrase = String(opt.q || '').toLowerCase().normalize('NFKC').trim();
  const toks = tokenize(phrase);
  if (!toks.length) return [];
  const limit = Math.max(1, Math.min(50, opt.limit || 20));
  const hits = [];
  for (const ix of indexes) {
    if (!ix || !Array.isArray(ix.items)) continue;
    if (opt.site && ix.site !== opt.site) continue;
    for (const it of ix.items) {
      if (!it || typeof it.url !== 'string' || typeof it.title !== 'string') continue;
      if (it.private && !opt.admin) continue;
      if (opt.lang && (it.lang || 'zh') !== opt.lang) continue;
      const s = score(it, toks, phrase);
      if (s > 0) hits.push({ site: ix.site, type: String(it.type || ''), title: it.title, subtitle: String(it.subtitle || ''), url: it.url, score: s });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.title.length - b.title.length);
  return hits.slice(0, limit);
}
