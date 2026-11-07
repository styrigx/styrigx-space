/**
 * @fileoverview 给模型的消息：系统提示 + 站内内容（召回结果）+ 截断后的历史 + 这次的问题（方案 5.2）。纯函数。
 *
 * 封顶（方案 5.6 单次封顶）：问题 q 最长 Q_MAX 字（超了由 api/ask.js 回 400）；历史最多 HISTORY_MAX 条、
 * 总长 HISTORY_CHARS 字（从最近的往回取，取满为止）；上下文条数和每条长度在 core/recall.js。
 * 系统提示（P4-3 PR-2，改法 1）：站内内容能答就只按站内答、末尾列用到的链接；本站功能 / 设置 / 账号的问题只按站内答，
 * 站内没有就直说、不凭通用知识猜路径；其他问题站内答不了（含召回为空）用通用知识直接答（不加前缀句，2026-11-06 起），
 * 不列链接、不编站内地址。条目标题后「 — 」之后是站内位置（索引副标题 = 面包屑），用来说出页面路径。
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

/** 上下文块的标签（按语言；加语言 = 这里和 SYSTEM 各加一项，缺的语言回退英文） */
const CONTEXT_LABELS = {
  en: { head: 'Site content:', none: '(No relevant site content.)', url: 'URL: ', text: 'Text: ' },
  zh: { head: '站内内容：', none: '（站内没有相关内容。）', url: '地址：', text: '正文：' },
};

const SYSTEM = {
  zh: '你是 Styrigx 的站内助手。先看下面的「站内内容」：能回答就只按站内内容回答，不要编造。' +
    '站内某条内容讲的就是问的东西时，即使说法不同（比如问「开启锁屏」、条目叫「锁屏凭证」），也算站内有，按它回答并给出路径；回答里列了站内链接，就不准说站内没有相关内容。' +
    '问的是本站的功能、设置、账号怎么用时，只能按站内内容回答；站内内容里没有，就直说站内没有找到相关内容，不要凭通用知识猜页面、设置的位置或地址。' +
    '其他问题站内内容答不了（包括站内没有相关内容）时，用通用知识直接回答，直接给答案，不列链接，也不要编造站内地址。' +
    '打招呼、问你是谁这类话，简短地正常回应即可。回答用简体中文，简洁。' +
    '站内条目标题后「 — 」之后是它在站内的位置（如「设置 › 安全」）；说怎么找到某个页面时，按这个位置逐级说出路径，再到这一页。' +
    '用到了站内内容时，回答末尾另起一段列出用到的链接，每行一条，格式「- 标题：地址」，只列站内内容里给出的地址。',
  en: 'You are the on-site assistant for Styrigx. Check the "Site content" below first: if it answers the question, answer only from it and do not make things up. ' +
    'If a site entry is about the thing being asked, even in different words (e.g. the question says "turn on the lock screen" and the entry is "Lock screen credentials"), it counts as covered: answer from it and give the path. If your answer lists site links, never say nothing on the site covers it. ' +
    'Questions about how this site\'s features, settings or account work must be answered only from the site content; if it is not there, say plainly that nothing relevant was found on the site, and do not guess pages, setting locations or URLs from general knowledge. ' +
    'For other questions the site content cannot answer (including when there is no relevant site content), answer directly from general knowledge, giving the answer straight away, with no links and no made-up site URLs. ' +
    'Greetings or questions about who you are: reply briefly and normally. Answer in English, concisely. ' +
    'After " — " in a site entry\'s title comes its location on the site (e.g. "Settings › Security"); when explaining how to find a page, give that path step by step, then the page itself. ' +
    'If you used site content, end with a separate list of those links, one per line as "- Title: URL", using only URLs given in the site content.',
};

/** AI 支持的回答语言（= SYSTEM 的键，英文是默认；ask.js 用它校验请求的 lang） */
export const AI_LANGS = Object.freeze(Object.keys(SYSTEM));

/**
 * @param {Array<{title: string, subtitle?: string, url: string, text?: string}>} hits
 * @param {'zh'|'en'} lang
 */
export function contextBlock(hits, lang) {
  const L = CONTEXT_LABELS[lang] || CONTEXT_LABELS.en;
  const head = L.head;
  if (!hits.length) return head + '\n\n' + L.none;
  const parts = hits.map((h, i) => {
    const title = h.subtitle ? h.title + ' — ' + h.subtitle : h.title;
    const body = String(h.text || '').trim();
    return '[' + (i + 1) + '] ' + title + '\n' + L.url + h.url + (body ? '\n' + L.text + body : '');
  });
  return head + '\n\n' + parts.join('\n\n');
}

/**
 * @param {{q: string, lang: 'zh'|'en', history?: any, hits: Array<{title: string, subtitle?: string, url: string, text?: string}>}} o
 * @returns {Array<{role: 'system'|'user'|'assistant', content: string}>}
 */
export function buildMessages(o) {
  /* P4-3 PR-4c：默认英文（四站默认语言），只有明确 zh 才用中文提示 */
  const lang = AI_LANGS.includes(o.lang) ? o.lang : 'en';
  return [
    { role: 'system', content: SYSTEM[lang] + '\n\n' + contextBlock(o.hits, lang) },
    ...normalizeHistory(o.history),
    /* 模型若输出思考段，由 core/think.js 的过滤去掉 */
    { role: 'user', content: o.q },
  ];
}
