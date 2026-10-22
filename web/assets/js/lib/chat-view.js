/**
 * @fileoverview 聊天页（/chat/）的纯函数：安全的轻量 Markdown 渲染、来源 chip、SSE 解析、发给 /api/chat 的对话裁剪、
 *   模型切换（GET /api/chat 列表解析、选哪个、面板行 HTML、回答脚注）。
 * 没有 DOM、没有请求（apps/chat.js 负责），node --test 直接测（tests/web/ui/chat-view.test.mjs）。
 *
 * Markdown 只认这些：段落（空行分段，段内换行 = <br>）、#–###### 标题（渲染成加粗段落）、- / * / + / 1. 列表、> 引用、
 * ``` 代码块、`行内代码`、**粗体**、*斜体*、[文字](链接)、裸露的 http(s) 地址。
 * 安全：先把所有文字 HTML 转义再拼标签，模型输出里的 <script>、onerror= 之类只会原样显示成文字；
 * 链接只放行 http:// / https://（javascript:、data: 等一律只留文字），新标签页打开，rel="noopener noreferrer"。
 */

/** HTML 转义（文字和属性都用它） @param {any} s */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
}

/** 只放行 http(s) 绝对地址（不含空白 / 控制字符）；否则 '' @param {any} u */
export function safeUrl(u) {
  const s = String(u == null ? '' : u).trim();
  if (!/^https?:\/\/[^\s]+$/i.test(s)) return '';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return '';
  return s;
}

/** @param {string} href @param {string} inner 已经是安全 HTML */
function linkHtml(href, inner) {
  return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + inner + '</a>';
}

/** 粗体 / 斜体（在已转义的文字上做） @param {string} s */
function emphasis(s) {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>');
}

/* 占位符：\u0001序号\u0001（输入里的 \u0001 先删掉，转义不碰它） */
const PH = '\u0001';
const PH_RE = /\u0001(\d+)\u0001/g;

/**
 * 行内：`代码`、[文字](链接)、裸地址 先换成占位符（各自已经是安全 HTML），剩下的转义 + 粗斜体，最后换回来。
 * @param {string} raw
 * @returns {string}
 */
export function renderInline(raw) {
  /** @type {string[]} */
  const slots = [];
  const put = (/** @type {string} */ html) => PH + (slots.push(html) - 1) + PH;
  let s = String(raw == null ? '' : raw).split(PH).join('');
  s = s.replace(/`([^`\n]+)`/g, (_, code) => put('<code>' + esc(code) + '</code>'));
  s = s.replace(/\[([^\]\n]+)\]\(\s*([^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g, (_, text, url) => {
    const inner = emphasis(esc(text));
    const href = safeUrl(url);
    return put(href ? linkHtml(href, inner) : inner);
  });
  s = s.replace(/https?:\/\/[^\s<>"'`\u0001）)\]】，。、；！？]+/gi, (m) => {
    let url = m;
    let tail = '';
    while (/[.,;:!?'"*_]$/.test(url)) {
      tail = url.slice(-1) + tail;
      url = url.slice(0, -1);
    }
    const href = safeUrl(url);
    return (href ? put(linkHtml(href, esc(url))) : url) + tail;
  });
  s = emphasis(esc(s));
  return s.replace(PH_RE, (_, i) => slots[Number(i)] || '');
}

const FENCE_RE = /^\s{0,3}(```|~~~)\s*([\w+#.-]*)\s*$/;
const HEAD_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

/**
 * 轻量 Markdown → 安全 HTML。流式时文字不完整也能渲染（没闭合的代码块一直延到末尾）。
 * @param {string} text
 * @returns {string}
 */
export function renderMarkdown(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  let para = [];
  /** @type {{type:'ul'|'ol', start:number, items:string[]}|null} */
  let list = null;
  /** @type {string[]|null} */
  let quote = null;

  const flushPara = () => {
    if (para.length) out.push('<p>' + para.map(renderInline).join('<br>') + '</p>');
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const open = list.type === 'ol' ? (list.start > 1 ? '<ol start="' + list.start + '">' : '<ol>') : '<ul>';
    out.push(open + list.items.map((it) => '<li>' + it + '</li>').join('') + (list.type === 'ol' ? '</ol>' : '</ul>'));
    list = null;
  };
  const flushQuote = () => {
    if (quote) out.push('<blockquote>' + quote.map(renderInline).join('<br>') + '</blockquote>');
    quote = null;
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushAll();
      /** @type {string[]} */
      const code = [];
      let j = i + 1;
      while (j < lines.length && !new RegExp('^\\s{0,3}' + (fence[1] === '```' ? '```' : '~~~') + '\\s*$').test(lines[j])) code.push(lines[j++]);
      i = j;
      out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    if (HR_RE.test(line) && !para.length) {
      flushAll();
      out.push('<hr>');
      continue;
    }
    const head = HEAD_RE.exec(line);
    if (head) {
      flushAll();
      out.push('<p class="chat-h">' + renderInline(head[2]) + '</p>');
      continue;
    }
    const q = QUOTE_RE.exec(line);
    if (q) {
      flushPara();
      flushList();
      (quote || (quote = [])).push(q[1]);
      continue;
    }
    flushQuote();
    const ul = UL_RE.exec(line);
    const ol = ul ? null : OL_RE.exec(line);
    if (ul || ol) {
      flushPara();
      const type = ul ? 'ul' : 'ol';
      const body = ul ? ul[2] : /** @type {RegExpExecArray} */ (ol)[3];
      const nested = (ul ? ul[1] : /** @type {RegExpExecArray} */ (ol)[1]).length >= 2;
      if (list && (list.type === type || nested)) {
        list.items.push(renderInline(body));
      } else {
        flushList();
        list = { type, start: ol ? Math.max(1, Number(ol[2])) : 1, items: [renderInline(body)] };
      }
      continue;
    }
    if (list && /^\s+\S/.test(line)) {
      /* 列表项的续行（缩进） */
      list.items[list.items.length - 1] += '<br>' + renderInline(line.trim());
      continue;
    }
    flushList();
    para.push(line);
  }
  flushAll();
  return out.join('');
}

/** 「example.com」这类纯域名 @param {string} s */
function looksLikeHost(s) {
  return /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(s);
}

/**
 * 来源 chip 的文字：{ host, title }。
 * Gemini 搜索接地的 uri 是 vertexaisearch.cloud.google.com 的跳转地址，title 一般就是来源域名——
 * 所以 title 像域名就把它当域名；否则域名取 uri 的主机名（跳转地址的主机名不显示）。
 * @param {{title?:string, uri?:string}} s
 */
export function sourceLabel(s) {
  const title = String((s && s.title) || '').trim();
  let host = '';
  try {
    host = new URL(String((s && s.uri) || '')).hostname.replace(/^www\./, '');
  } catch (e) {
    host = '';
  }
  if (host === 'vertexaisearch.cloud.google.com') host = '';
  if (looksLikeHost(title)) return { host: title.replace(/^www\./, ''), title: '' };
  if (!host && !title) return { host: '', title: '' };
  return { host: host || title, title: host ? title : '' };
}

/**
 * 来源 chip 列表 HTML（只放 http(s)，最多 8 个）。
 * @param {Array<{title?:string, uri?:string}>} items
 * @param {string} label 无障碍标签（「来源」/ Sources）
 */
export function renderSources(items, label) {
  const ok = (items || []).filter((s) => s && safeUrl(s.uri)).slice(0, 8);
  if (!ok.length) return '';
  return '<ul class="chat-srcs" aria-label="' + esc(label) + '">' + ok.map((s) => {
    const l = sourceLabel(s);
    const title = l.title ? '<span class="chat-src-title">' + esc(l.title) + '</span>' : '';
    return '<li><a class="chat-src" href="' + esc(safeUrl(s.uri)) + '" target="_blank" rel="noopener noreferrer" title="' + esc(l.title || l.host) + '">'
      + '<span class="chat-src-host">' + esc(l.host || '…') + '</span>' + title + '</a></li>';
  }).join('') + '</ul>';
}

/**
 * SSE 解析器：push(文字块) 逐段喂，每个完整事件的 data 解析成 JSON 回调 onEvent；坏 JSON 跳过。
 * @param {(ev: any) => void} onEvent
 */
export function createSseParser(onEvent) {
  let buf = '';
  /** @param {string} block */
  const handle = (block) => {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    let ev;
    try {
      ev = JSON.parse(data);
    } catch (e) {
      return;
    }
    onEvent(ev);
  };
  return {
    /** @param {string} chunk */
    push(chunk) {
      buf += chunk;
      let m;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        handle(block);
      }
    },
    end() {
      if (buf.trim()) handle(buf);
      buf = '';
    },
  };
}

/* 与 workers/auth-gateway/functions/api/chat.js 的上限一致 */
export const MAX_MESSAGES = 20;
export const MAX_TEXT = 4000;
export const MAX_TOTAL = 24000;

/**
 * 本地对话 → /api/chat 的 messages：去掉空的、相邻同角色合并、单条截到 4000 字、
 * 从最新往前取（≤ 20 条、合计 ≤ 24000 字），开头必须是 user。最后一条不是 user → null（不该发）。
 * @param {Array<{role:string, text:string}>} msgs
 * @returns {Array<{role:'user'|'model', text:string}>|null}
 */
export function buildPayload(msgs) {
  /** @type {Array<{role:'user'|'model', text:string}>} */
  const merged = [];
  for (const m of msgs || []) {
    if (!m || (m.role !== 'user' && m.role !== 'model')) continue;
    const text = String(m.text || '').trim();
    if (!text) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.text += '\n\n' + text;
    else merged.push({ role: m.role, text });
  }
  for (const m of merged) if (m.text.length > MAX_TEXT) m.text = m.text.slice(0, MAX_TEXT);
  if (!merged.length || merged[merged.length - 1].role !== 'user') return null;
  /** @type {Array<{role:'user'|'model', text:string}>} */
  const out = [];
  let total = 0;
  for (let i = merged.length - 1; i >= 0; i--) {
    if (out.length >= MAX_MESSAGES || total + merged[i].text.length > MAX_TOTAL) break;
    total += merged[i].text.length;
    out.unshift(merged[i]);
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out.length ? out : null;
}

/**
 * 错误码 → 文案 key + 是否给「重试」/「换模型」（pick：按钮打开模型面板；只有模型切换能用时 canPick = true 才给）。
 * @param {string} code rate_limited | model_unavailable | bad_model | no_key | owner_only | unauthorized | bad_request | upstream | network
 * @param {boolean} [canPick] 模型切换在不在（模型列表拿到了、≥ 2 个）
 * @returns {{key:string, retry:boolean, pick?:boolean}}
 */
export function errorInfo(code, canPick) {
  switch (code) {
    case 'rate_limited': return canPick ? { key: 'errRateModel', retry: false, pick: true } : { key: 'errRate', retry: false };
    case 'model_unavailable': return canPick ? { key: 'errModel', retry: false, pick: true } : { key: 'errModel', retry: true };
    case 'bad_model': return { key: 'errBadModel', retry: true };
    case 'no_key': return { key: 'errNoKey', retry: false };
    case 'bad_request': return { key: 'errTooLong', retry: false };
    default: return { key: 'errUpstream', retry: true };
  }
}

/**
 * @typedef {{id:string, label:string, search:boolean}} ChatModel
 */

/**
 * GET /api/chat 的回答 → { def, models }；形状不对 / 没有模型 → null（页面就不显示模型切换，用服务器默认）。
 * 只留 id 是非空字符串的条目（去重），label 兜底 id，search 只认 true；def 不在列表里 → 第一个。
 * @param {any} j
 * @returns {{def:string, models:ChatModel[]}|null}
 */
export function parseModels(j) {
  if (!j || j.ok !== true || !Array.isArray(j.models)) return null;
  /** @type {ChatModel[]} */
  const models = [];
  for (const m of j.models) {
    if (!m || typeof m.id !== 'string' || !m.id || m.id.length > 100 || models.some((x) => x.id === m.id)) continue;
    const label = typeof m.label === 'string' && m.label.trim() ? m.label.trim().slice(0, 60) : m.id;
    models.push({ id: m.id, label, search: m.search === true });
  }
  if (!models.length) return null;
  const def = typeof j.default === 'string' && models.some((x) => x.id === j.default) ? j.default : models[0].id;
  return { def, models };
}

/**
 * 当前模型：本地存的还在列表里就用它，否则默认。
 * @param {{def:string, models:ChatModel[]}} list
 * @param {string|null|undefined} stored localStorage sgx-chat-model
 */
export function pickModel(list, stored) {
  return typeof stored === 'string' && list.models.some((m) => m.id === stored) ? stored : list.def;
}

/** Gemini 四角星（品牌小图标，currentColor） */
export const SPARKLE_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12 2c.35 4.9 2.6 8.65 10 10-7.4 1.35-9.65 5.1-10 10-.35-4.9-2.6-8.65-10-10 7.4-1.35 9.65-5.1 10-10z"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/**
 * 模型面板的行（role="option"，当前那个 aria-selected="true" + 右边对勾、tabindex=0，其余 -1）。
 * 每行：四角星 · 名字（大字）· 紧跟名字的小药丸（联网 = 强调色；不联网 = 灰）· 最右对勾。
 * @param {ChatModel[]} models
 * @param {string} current
 * @param {{web:string, noWeb:string}} labels
 */
export function modelOptionsHtml(models, current, labels) {
  return models.map((m) => {
    const sel = m.id === current;
    const badge = m.search
      ? '<span class="chat-ms-badge" data-web="1">' + esc(labels.web) + '</span>'
      : '<span class="chat-ms-badge" data-web="0">' + esc(labels.noWeb) + '</span>';
    return '<li class="chat-ms-opt" role="option" data-id="' + esc(m.id) + '"'
      + ' aria-selected="' + (sel ? 'true' : 'false') + '" tabindex="' + (sel ? '0' : '-1') + '">'
      + '<span class="chat-ms-ic">' + SPARKLE_SVG + '</span>'
      + '<span class="chat-ms-name"><span class="chat-ms-lbl">' + esc(m.label) + '</span>' + badge + '</span>'
      + '<span class="chat-ms-check">' + (sel ? CHECK_SVG : '') + '</span></li>';
  }).join('');
}

/**
 * 回答气泡下的模型脚注文字：「Gemini 3.8 Flash」；这次没联网（工具被拒重试）→「Gemini 2.5 Flash · 未联网」。没有模型名 → ''。
 * @param {string|undefined} label @param {boolean|undefined} noWeb @param {string} noWebText
 */
export function modelFootText(label, noWeb, noWebText) {
  if (!label) return '';
  return noWeb ? label + ' · ' + noWebText : label;
}
