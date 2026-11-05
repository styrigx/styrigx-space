/**
 * @fileoverview 给模型的消息：系统提示 + 站内内容（召回结果）+ 截断后的历史 + 这次的问题（方案 5.2）。纯函数。
 *
 * 封顶（方案 5.6 单次封顶）：问题 q 最长 Q_MAX 字（超了由 api/ask.js 回 400）；历史最多 HISTORY_MAX 条、
 * 总长 HISTORY_CHARS 字（从最近的往回取，取满为止）；上下文条数和每条长度在 core/recall.js。
 * 系统提示要求只根据给出的站内内容回答、找不到就直说、回答末尾列出用到的链接。
 */

export const Q_MAX = 200;
export const HISTORY_MAX = 6;
export const HISTORY_CHARS = 2000;

/**
 * 历史 → [{ role:'user'|'assistant', content }]，按时间顺序。不认识的条目跳过（不报错：历史只是参考）。
 * 每条接受 { role, text } 或 { role, content }。
 * @param {any} history
 * @returns {Array<{role: 'user'|'assistant', content: string}>}
 */
export function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  /** @type {Array<{role: 'user'|'assistant', content: string}>} */
  const picked = [];
  let total = 0;
  for (let i = history.length - 1; i >= 0 && picked.length < HISTORY_MAX; i--) {
    const m = history[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const raw = typeof m.text === 'string' ? m.text : typeof m.content === 'string' ? m.content : '';
    let content = raw.trim();
    if (!content) continue;
    const room = HISTORY_CHARS - total;
    if (room <= 0) break;
    if (content.length > room) content = content.slice(content.length - room);
    picked.push({ role: m.role, content });
    total += content.length;
  }
  return picked.reverse();
}

const SYSTEM = {
  zh: '你是 Styrigx 的站内助手。只根据下面「站内内容」回答用户的问题，不要编造，也不要用站外知识补充。' +
    '站内内容里找不到答案时，直接说站内没有找到相关内容。回答用简体中文，简洁。' +
    '回答末尾另起一段列出用到的链接，每行一条，格式「- 标题：地址」，只列站内内容里给出的地址。',
  en: 'You are the on-site assistant for Styrigx. Answer only from the "Site content" below; do not make things up or add outside knowledge. ' +
    'If the site content does not contain the answer, say plainly that nothing relevant was found on the site. Answer in English, concisely. ' +
    'End with a separate list of the links you used, one per line as "- Title: URL", using only URLs given in the site content.',
};

/**
 * @param {Array<{title: string, subtitle?: string, url: string, text?: string}>} hits
 * @param {'zh'|'en'} lang
 */
export function contextBlock(hits, lang) {
  const head = lang === 'en' ? 'Site content:' : '站内内容：';
  const parts = hits.map((h, i) => {
    const title = h.subtitle ? h.title + ' — ' + h.subtitle : h.title;
    const body = String(h.text || '').trim();
    return '[' + (i + 1) + '] ' + title + '\n' + (lang === 'en' ? 'URL: ' : '地址：') + h.url + (body ? '\n' + (lang === 'en' ? 'Text: ' : '正文：') + body : '');
  });
  return head + '\n\n' + parts.join('\n\n');
}

/**
 * @param {{q: string, lang: 'zh'|'en', history?: any, hits: Array<{title: string, subtitle?: string, url: string, text?: string}>}} o
 * @returns {Array<{role: 'system'|'user'|'assistant', content: string}>}
 */
export function buildMessages(o) {
  const lang = o.lang === 'en' ? 'en' : 'zh';
  return [
    { role: 'system', content: SYSTEM[lang] + '\n\n' + contextBlock(o.hits, lang) },
    ...normalizeHistory(o.history),
    /* 模型若输出思考段，由 core/think.js 的过滤去掉 */
    { role: 'user', content: o.q },
  ];
}

/** 召回为空时的固定回答（不调模型，省额度） */
export const NOTHING_FOUND = Object.freeze({
  zh: '站内没有找到相关内容。',
  en: 'Nothing relevant was found on the site.',
});
