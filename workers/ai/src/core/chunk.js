/**
 * @fileoverview 语义召回的切段（纯函数，Cron 写 Vectorize 用；2026-11 AI 语义召回）。
 *
 * 输入是各站索引的条目（KV site:<站名> 的 items，格式见 core/rank.js 文件头：{ id, type, lang, title, subtitle?, text?, url, private? }）。
 * 每条切成若干段：段文本 = 标题（+ 「 — 」副标题）+ 换行 + 正文的一截；正文按 CHUNK_CHARS 字切、相邻两段重叠 CHUNK_OVERLAP 字，
 * 尽量在句号 / 换行处断开。没有正文的条目出一段（只有标题和副标题）。每条最多 MAX_CHUNKS_PER_ITEM 段（博文全文够用）。
 *
 * 向量 id（Vectorize 上限 64 字节）：<站名>:<条目指纹 16 位十六进制>:<段号>。条目指纹 = sha256(站名 + 条目 id（没有 id 用 url）+ 语言) 前 16 位，
 * 和内容无关：内容改了 id 不变，upsert 覆盖；条目删了 / 段数变少，多出来的 id 由 core/vector-sync.js 删掉。
 * metadata（每条向量上限 10 KiB，这里最多约 3 KiB）：site / lang / type / title / subtitle / url / text（这一段的原文，召回时直接进模型上下文）/ private（布尔，
 * 有元数据索引，没有账号会话时按它过滤，同 core/recall.js 的两档）。
 */

/** 每段正文最多多少字（码点）。bge-m3 上下文很长，这里按「一段讲一件事」取 */
export const CHUNK_CHARS = 700;
/** 相邻两段重叠多少字 */
export const CHUNK_OVERLAP = 120;
/** 每条最多切几段（超了后面不要：长文前面通常够答） */
export const MAX_CHUNKS_PER_ITEM = 40;
const TITLE_MAX = 160;
const SUB_MAX = 160;

/** @param {any} s @param {number} n */
function clip(s, n) {
  const a = [...String(s == null ? '' : s).replace(/\s+/g, ' ').trim()];
  return a.length > n ? a.slice(0, n).join('') : a.join('');
}

/**
 * 正文切段（按码点；在 [0.6×size, size] 范围里找最后一个句末 / 换行处断开，找不到就硬切）。
 * @param {string} text @param {number} [size] @param {number} [overlap]
 * @returns {string[]}
 */
export function splitText(text, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP) {
  const chars = [...String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()];
  if (!chars.length) return [];
  if (chars.length <= size) return [chars.join('')];
  const out = [];
  let start = 0;
  while (start < chars.length && out.length < MAX_CHUNKS_PER_ITEM) {
    let end = Math.min(chars.length, start + size);
    if (end < chars.length) {
      const lo = start + Math.floor(size * 0.6);
      for (let i = end - 1; i >= lo; i--) {
        if (/[。！？.!?\n；;]/.test(chars[i])) { end = i + 1; break; }
      }
    }
    const piece = chars.slice(start, end).join('').trim();
    if (piece) out.push(piece);
    if (end >= chars.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

/** sha256 十六进制 @param {string} s */
export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @typedef {{ id: string, text: string, metadata: { site: string, lang: string, type: string, title: string, subtitle: string, url: string, text: string, private: boolean } }} Chunk
 */

/**
 * 一个站的全部条目 → 段（没有 url / 标题的条目跳过）。
 * @param {string} site @param {any[]} items
 * @returns {Promise<Chunk[]>}
 */
export async function chunkItems(site, items) {
  /** @type {Chunk[]} */
  const out = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it.url !== 'string' || typeof it.title !== 'string' || !it.title.trim()) continue;
    const lang = it.lang === 'en' ? 'en' : 'zh';
    const key = site + '\n' + (typeof it.id === 'string' && it.id ? it.id : it.url) + '\n' + lang;
    if (seen.has(key)) continue;
    seen.add(key);
    const fp = (await sha256Hex(key)).slice(0, 16);
    const title = clip(it.title, TITLE_MAX);
    const subtitle = clip(it.subtitle, SUB_MAX);
    const head = subtitle ? title + ' — ' + subtitle : title;
    const parts = splitText(it.text);
    if (!parts.length) parts.push('');
    parts.forEach((p, i) => {
      out.push({
        id: site + ':' + fp + ':' + i,
        text: p ? head + '\n' + p : head,
        metadata: { site, lang, type: String(it.type || ''), title, subtitle, url: it.url, text: p, private: it.private === true },
      });
    });
  }
  return out;
}
