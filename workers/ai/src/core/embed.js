/**
 * @fileoverview 文本嵌入（Workers AI，2026-11 AI 语义召回）。写入（Cron，core/vector-sync.js）和查询（core/semantic.js）用同一个模型。
 *
 * 模型 @cf/baai/bge-m3：中英双语（多语言），1024 维，Vectorize 索引按余弦（cosine）建（PR 正文「需在 Cloudflare 新建的资源」）。
 * 输入 { text: string[] }，输出 { shape: [n, 1024], data: number[][] }（文档示例同）；也认 { response: number[][] } 以防格式变化。
 */

export const EMBED_MODEL = '@cf/baai/bge-m3';
export const EMBED_DIMS = 1024;
/** 一次调用最多送几段（控制单次请求大小和子请求数） */
export const EMBED_BATCH = 50;
/** 每段送进模型前最多多少字 */
export const EMBED_CHARS = 1200;

/**
 * 嵌入一批文本 → 向量（顺序同输入）。没绑 AI / 返回格式不对 / 维度不对 → 抛错（调用方决定怎么退）。
 * @param {any} env @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embed(env, texts) {
  const ai = env && env.AI;
  if (!ai || typeof ai.run !== 'function') throw new Error('no-ai');
  /** @type {number[][]} */
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH).map((t) => [...String(t || ' ')].slice(0, EMBED_CHARS).join('') || ' ');
    const r = await ai.run(EMBED_MODEL, { text: batch });
    const data = r && Array.isArray(r.data) ? r.data : r && Array.isArray(r.response) ? r.response : null;
    if (!data || data.length !== batch.length) throw new Error('embed-shape');
    for (const v of data) {
      if (!Array.isArray(v) || v.length !== EMBED_DIMS) throw new Error('embed-dims');
      out.push(v);
    }
  }
  return out;
}
