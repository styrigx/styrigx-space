/**
 * @fileoverview AI 窗口的内容（2026-11-04 P5-1，第 4 件前端，方案 5.5）：站内对话助手，四个站同一份。
 * 共享外壳组件：gen-common 原样复制成 space/web/shared/shell/ai.js；窗口的开合 / 互斥由 topbar.js（主站 topbar/panel.js）管，这里只管窗口里面。
 * 只许 import term/**（终端统一 T1，gen-common 核对）：外壳字符串表读取、按键提示行英文底用 term/core/strings.js。
 *
 * - 问：POST /api/ai（同源，credentials: same-origin）{ q, lang, history } → text/event-stream：event delta…（回答分段）→ done（2026-11-06 起不再有 event hits，不显示来源卡片：链接只出现在模型写的正文里）；
 *   出错时 event error。响应头 X-Styrigx-AI-Scope: private | public 只用来在底部小字说明「包含私密内容 / 仅公开内容」。
 *   网关的错误码（P4-1）：401 unauthorized（没进站）· 429 cooldown / busy · 400 too-long · 413 too-large · 502 / 503 upstream。
 * - 历史只存本地 localStorage sgx-ai-history（P4-3 后续 §3.3：{v:2, cur, chats:[{id, title, time, msgs:[{role, text, ts, rate?}]}]}，多份对话，每份最多 50 条，
 *   最多 20 份、超了删最旧的；title = 首问前 20 字；cur = 当前对话 id。读到 v1 {v:1, msgs} 包成一份对话写回 v2；旧记录里可能还带 hits，读出来不渲染）；
 *   四站同源所以同一台设备上是同一份（同源带来的，不是同步）；
 *   prefs/cloud-sync.js 的白名单不收这个键，不跨设备。发给服务端的 history 只带最近 6 条 {role, text}（服务端再截 2000 字）。
 * - 头部一行（2026-11 PR-5 按设计稿 ai-v1）：G 徽标 · Gray AI / 副标题 · 模型胶囊（data-ai-model）· 新对话（data-ai-clear）· 历史（data-ai-history：窗口内的列表视图）· ×（topbar.js 接）；
 *   头像（账号页）不在 AI 窗口里了（设计稿没有；账号入口是顶栏头像）。回答下是来源卡片（站内链接）和建议问题。联系挪到底部那行「仅公开内容 · 联系我」（data-ai-contact：mailto:<对外联系邮箱>）。
 *   邮箱（2026-11-07 个人资料）：模板按各站传入的默认值（data/common/profile.yaml 的 email）画 href；挂载和每次打开时再读本机缓存
 *   localStorage sgx-profile（主站 prefs/profile.js 进门后从 GET /api/profile 写的；四站同源同一份），有改过的合法邮箱就换上。这里不发请求。
 *   底部小字的「仅公开内容 / 包含私密内容」在 data-ai-scope 上。空态显示开场白（助手气泡样式，不存历史）。
 * - 每条助手回答下（§3.4）：复制 / 重试（重问前面那条提问，替换这条回答）/ 👍 / 👎（只存本地，记在该条消息的 rate 上，再点取消）。
 * - 模型（P4-2d）：账号页「AI 模型」一行把选择存在 localStorage sgx-ai-model（进云同步，换设备跟着走）；这里发问时有就带上 body.model，
 *   2026-11 PR-5（设计稿 ai-v1）起 AI 窗口头部也能切（模型胶囊 → 头部下方单选，同一个键）。服务端只在有账号会话时采纳（没登录带了也忽略，一律默认模型），不在登记里 → 400 bad_model：
 *   清掉本地选择、不带 model 自动重发一次（只重发一次；再错按普通错误显示）。清掉时派发 sgx-settings-changed，主站的云同步把删除推上去。
 *   响应头 X-Styrigx-AI-Model（这次用的模型 id）只用于排查，这里不显示。
 * - 键盘（P4-3 PR-3）：输入框聚焦时订阅键盘高度（调用方传入 opts.keyboard = 共享外壳 vk.js 的 onKeyboardHeight），写到 #sgx-ai 的 --sgx-kb：
 *   窗口下沿抬到键盘上沿，消息列表在窗口内压缩，标题栏和输入框都留在可视区；键盘高度从有到 0 而输入框仍聚焦（系统手势收键盘）→ 自动 blur()。
 *   粗指针（触屏）打开窗口不自动聚焦、点发送后 blur() 收键盘；细指针（桌面）照旧打开即聚焦，发送后焦点回输入框（鼠标点发送也一样，§4）。
 *   触屏点发送按钮在 touchstart 就 preventDefault、touchend 提交：不让输入框先失焦收键盘、按钮下移把这次点击吃掉（§5）。
 * - 停止：回答进行中发送按钮变停止按钮（data-stop，读屏名「停止」），点它接 abort()；已收到的部分保留，答完 / 停下后变回发送。
 * - 回答渲染（2026-11 AI 语义召回）：助手回答按有限 Markdown 渲染（mdParse → renderMd）：段落、换行、列表（- / * / 1.）、**粗体**、链接 [文字](地址) 和裸网址；
 *   其余一律当纯文本（只用 createElement / textContent 拼 DOM，不用 innerHTML，HTML 天然转义）。链接只认 http(s) 和站内绝对路径（/…），别的协议当文字。
 *   链接文字带虚下划线 + ↗（参照 ChatGPT 安卓）；站内链接同页打开（关窗口后跳转），站外新标签 + rel=noopener。
 *   长网址不当链接文字：同一条回答里有 [标题](同一地址) 就用那个标题，否则显示「域名/…」。
 *   event: sources（gemini 联网来源）→ 在回答末尾追加「来源」一段（- [标题](地址)），随回答存进历史。
 */
import { KH_EN, shellSection } from '../term/core/strings.js';

export const AI_API = '/api/ai';
export const HISTORY_KEY = 'sgx-ai-history';
export const HISTORY_MAX = 50;
/** 历史列表最多存几份对话 / 标题取首问前几个字（P4-3 后续 §3.3） */
export const CHATS_MAX = 20;
export const TITLE_MAX = 20;
export const SEND_HISTORY = 6;
export const Q_MAX = 200;
/** 账号页选的模型 id（P4-2d；四站同源同一份；prefs/cloud-sync.js 的 EXTRA 收这个键） */
export const MODEL_KEY = 'sgx-ai-model';
/** 个人资料本机缓存（主站 prefs/profile.js PROFILE_CACHE_KEY 同一个键；{v:1, p:{email…}, t}） */
export const PROFILE_KEY = 'sgx-profile';
/** 邮箱格式（与主站 prefs/profile.js EMAIL_RE 同一条） */
const EMAIL_RE = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\.]{2,}$/;

/** 请人进站（= auth/sudo.js SUDO_EVENT；本文件只许 import term/**，抄一份）：顶栏终端预填 su （v6 割接；topbar/panel.js 接） @param {Document} doc */
function askSudo(doc) {
  try { doc.dispatchEvent(new CustomEvent('sgx:sudo')); } catch (e) {}
}
/** 英文底（源文本，没有页面字符串表时用）；页面上以 #sgx-i18n-frame 的 ai 节为准——已是「英文 ← 页面语言」的合并，缺键回退英文（语言包化 2026-11-07） */
const STR_EN = {
  greet: "Hi, I'm Gray's AI assistant. Ask about this site, or talk through whatever you're working on.",
  histEmpty: "No past chats yet",
  untitled: "(Untitled)",
  copy: "Copy",
  copied: "Copied",
  retry: "Retry",
  up: "Helpful",
  down: "Not helpful",
  thinking: "Searching this site…",
  scopePublic: "Public content only",
  scopePrivate: "Includes private content",
  unauthorized: "Gray AI opens after you sign in: su",
  locked: "Locked. Sign in with su to use Gray AI",
  cooldown: "Too many questions. Try again in a minute",
  busy: "Lots of people are asking right now. Try again shortly",
  tooLong: "That question is too long (200 characters max)",
  quota: "Today’s quota is used up. Come back tomorrow",
  forbidden: "Your current user can’t use Gray AI",
  fail: "Couldn’t get an answer. Please try again",
  send: "Send",
  stop: "Stop",
  sources: "Sources",
  newTab: "(opens in a new tab)",
  sug1: "What have you been listening to?",
  sug2: "Today’s daymark",
  sug3: "What devices do you use?"
};
/** @param {Document} doc @returns {Record<string, string>} */
function shellStr(doc) {
  return Object.assign({}, STR_EN, shellSection(doc, 'ai'));
}

/** @typedef {{role: 'user'|'assistant', text: string, ts: number, error?: boolean, rate?: 'up'|'down'}} Msg */
/** @typedef {{id: string, title: string, time: number, msgs: Msg[]}} Chat */
/** @typedef {{cur: string, chats: Chat[]}} Chats */

/** 新对话 id：时间戳 + 随机 */
export function newChatId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}
/** 对话标题：首问截断到 20 字 @param {Msg[]} msgs */
export function chatTitle(msgs) {
  const q = msgs.find(function (m) { return m.role === 'user' && m.text; });
  return q ? [...q.text.replace(/\s+/g, ' ').trim()].slice(0, TITLE_MAX).join('') : '';
}
/** 一份对话的消息：只留合法的、最近 50 条；👍/👎 只认 up / down；旧记录里的 hits 等字段丢掉 @param {any} arr @returns {Msg[]} */
function cleanMsgs(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(function (/** @type {any} */ m) {
    return m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text && !m.error;
  }).slice(-HISTORY_MAX).map(function (/** @type {any} */ m) {
    /** @type {Msg} */
    const x = { role: m.role, text: m.text, ts: typeof m.ts === 'number' ? m.ts : 0 };
    if (m.role === 'assistant' && (m.rate === 'up' || m.rate === 'down')) x.rate = m.rate;
    return x;
  });
}
/** @param {Msg[]} msgs */
function lastTs(msgs) {
  return msgs.length ? msgs[msgs.length - 1].ts || 0 : 0;
}
/**
 * 读本地历史（{v:2, cur, chats:[{id, title, time, msgs}]}）。读到 v1（单份对话 {v:1, msgs}）→ 包成一份对话，写回 v2。坏了 = 空。
 * @param {Storage|null} [store] @returns {Chats}
 */
export function loadChats(store) {
  /** @type {Chats} */
  const none = { cur: '', chats: [] };
  try {
    const s = store || window.localStorage;
    const j = JSON.parse(s.getItem(HISTORY_KEY) || 'null');
    if (!j) return none;
    if (j.v === 1) {
      const msgs = cleanMsgs(j.msgs);
      if (!msgs.length) { s.removeItem(HISTORY_KEY); return none; }
      const c = { id: newChatId(), title: chatTitle(msgs), time: lastTs(msgs), msgs: msgs };
      /** @type {Chats} */
      const d = { cur: c.id, chats: [c] };
      saveChats(d, s);
      return d;
    }
    if (j.v !== 2 || !Array.isArray(j.chats)) return none;
    /** @type {Chat[]} */
    const chats = [];
    for (const c of j.chats) {
      if (!c || typeof c.id !== 'string' || !c.id) continue;
      const msgs = cleanMsgs(c.msgs);
      if (!msgs.length) continue;
      chats.push({ id: c.id, title: typeof c.title === 'string' && c.title ? c.title : chatTitle(msgs), time: typeof c.time === 'number' ? c.time : lastTs(msgs), msgs: msgs });
    }
    chats.sort(function (a, b) { return b.time - a.time; });
    return { cur: typeof j.cur === 'string' ? j.cur : '', chats: chats.slice(0, CHATS_MAX) };
  } catch (e) {
    return none;
  }
}
/** 存本地历史：空对话不存；按时间倒序，最多 20 份（超了删最旧的）；一份都没有 = 删 key @param {Chats} d @param {Storage|null} [store] */
export function saveChats(d, store) {
  try {
    const s = store || window.localStorage;
    const chats = d.chats.map(function (c) {
      const msgs = cleanMsgs(c.msgs);
      return { id: c.id, title: c.title || chatTitle(msgs), time: c.time, msgs: msgs };
    }).filter(function (c) { return c.msgs.length; });
    chats.sort(function (a, b) { return b.time - a.time; });
    const keep = chats.slice(0, CHATS_MAX);
    if (!keep.length) s.removeItem(HISTORY_KEY);
    else s.setItem(HISTORY_KEY, JSON.stringify({ v: 2, cur: d.cur, chats: keep }));
  } catch (e) {}
}
/** 发给服务端的历史：最近 6 条 {role, text}（不带出错的） @param {Msg[]} msgs */
export function historyForServer(msgs) {
  return msgs.filter(function (m) { return !m.error && m.text; }).slice(-SEND_HISTORY).map(function (m) { return { role: m.role, text: m.text }; });
}
/** 读账号页选的模型（没有 / 读不到 / 不像 id = ''，不带 model） @param {Storage|null} [store] */
export function loadModel(store) {
  try {
    const s = store || window.localStorage;
    const v = s.getItem(MODEL_KEY) || '';
    return v.length <= 128 ? v : '';
  } catch (e) {
    return '';
  }
}
/** 本机缓存里改过的对外联系邮箱（没有 / 坏了 / 不像邮箱 = ''，用模板默认值） @param {Storage|null} [store] */
export function cachedEmail(store) {
  try {
    const j = JSON.parse((store || window.localStorage).getItem(PROFILE_KEY) || 'null');
    const e = j && j.v === 1 && j.p && typeof j.p.email === 'string' ? j.p.email.trim() : '';
    return e && e.length <= 254 && EMAIL_RE.test(e) ? e : '';
  } catch (e) {
    return '';
  }
}
/** 清掉模型选择（服务端说 bad_model：被下架了），并告诉主站的云同步这是本机改动 @param {Storage|null} [store] */
export function clearModel(store) {
  try { (store || window.localStorage).removeItem(MODEL_KEY); } catch (e) {}
  try { window.dispatchEvent(new Event('sgx-settings-changed')); } catch (e) {}
}
/** 400 bad_model：选中的模型不在登记里（P4-2d） @param {number} status @param {any} j */
export function isBadModel(status, j) {
  return status === 400 && !!j && j.error === 'bad_model';
}
/** 网关 / 服务端错误 → 文案键 @param {number} status @param {any} j */
export function errKey(status, j) {
  const e = j && typeof j.error === 'string' ? j.error : '';
  if (status === 401) return 'unauthorized';
  /* 2b：有 v6 身份但不在 ai 组（网关 403 forbidden）：不是「没登录」，不上锁、不预填 su */
  if (status === 403 && e === 'forbidden') return 'forbidden';
  if (status === 429) return e === 'busy' ? 'busy' : 'cooldown';
  if (status === 400 && e === 'too-long') return 'tooLong';
  if (status === 413) return 'tooLong';
  if (e === 'quota') return 'quota';
  return 'fail';
}

/* ---- 有限 Markdown（2026-11 AI 语义召回）---- */

/** @typedef {{t: 'text', v: string} | {t: 'b', v: string} | {t: 'a', text: string, href: string} | {t: 'br'}} MdInline */
/** @typedef {{t: 'p', c: MdInline[]} | {t: 'ul'|'ol', items: MdInline[][]}} MdBlock */

const MD_INLINE = /\*\*([^*\n]+?)\*\*|\[([^\]\n]{1,300})\]\(\s*<?([^\s()<>]+)>?\s*\)|(https?:\/\/[^\s<>()\[\]"'`]*[^\s<>()\[\]"'`.,;:!?。，；：！？、）」』])/g;
const MD_UL = /^\s{0,3}[-*•]\s+(.*)$/;
const MD_OL = /^\s{0,3}\d{1,3}[.)、]\s+(.*)$/;

/** 文字看起来就是网址（不当链接文字用） @param {string} s */
function looksUrl(s) {
  return /^\s*(https?:\/\/|www\.)/i.test(s);
}
/** 长网址 → 显示用的短名：域名，有路径就加「/…」 @param {string} href */
export function shortLabel(href) {
  try {
    const u = new URL(href, 'https://styrigx.com');
    const host = u.hostname.replace(/^www\./, '');
    return host + (u.pathname.length > 1 || u.search ? '/…' : '');
  } catch (e) {
    return href.slice(0, 40);
  }
}
/**
 * 一行文字 → 行内片段。titles：同一条回答里 [标题](地址) 给过的标题，裸网址 / 文字就是网址的链接用它当文字。
 * @param {string} line @param {Map<string, string>} titles @returns {MdInline[]}
 */
function mdInline(line, titles) {
  /** @type {MdInline[]} */
  const out = [];
  let last = 0;
  MD_INLINE.lastIndex = 0;
  let m;
  while ((m = MD_INLINE.exec(line))) {
    if (m.index > last) out.push({ t: 'text', v: line.slice(last, m.index) });
    if (m[1] != null) out.push({ t: 'b', v: m[1] });
    else {
      const href = m[3] != null ? m[3] : m[4];
      let text = m[2] != null ? m[2].trim() : '';
      if (!text || looksUrl(text) || text === href) text = titles.get(href) || shortLabel(href);
      out.push({ t: 'a', text: text, href: href });
    }
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ t: 'text', v: line.slice(last) });
  return out;
}
/**
 * 回答原文 → 块（段落 / 无序列表 / 有序列表）。纯函数，不碰 DOM；不认的语法原样当文字（标题的 # 去掉）。
 * @param {string} text @returns {MdBlock[]}
 */
export function mdParse(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  /** @type {Map<string, string>} */
  const titles = new Map();
  const tre = /\[([^\]\n]{1,300})\]\(\s*<?([^\s()<>]+)>?\s*\)/g;
  let tm;
  while ((tm = tre.exec(src))) {
    const label = tm[1].trim();
    if (label && !looksUrl(label) && !titles.has(tm[2])) titles.set(tm[2], label);
  }
  /** @type {MdBlock[]} */
  const blocks = [];
  /** @type {MdInline[]|null} */
  let para = null;
  /** @type {{t: 'ul'|'ol', items: MdInline[][]}|null} */
  let list = null;
  for (const raw of src.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { para = null; list = null; continue; }
    const ul = MD_UL.exec(line);
    const ol = ul ? null : MD_OL.exec(line);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (!list || list.t !== kind) { list = { t: kind, items: [] }; blocks.push(list); }
      para = null;
      list.items.push(mdInline(/** @type {RegExpExecArray} */ (ul || ol)[1], titles));
      continue;
    }
    list = null;
    const body = line.replace(/^\s{0,3}#{1,6}\s+/, '');
    if (!para) { para = []; blocks.push({ t: 'p', c: para }); }
    else para.push({ t: 'br' });
    para.push(...mdInline(body, titles));
  }
  return blocks;
}
/**
 * 链接地址能不能点、是不是站内：只认 http(s) 和站内绝对路径（/…，不认 //…）。不能点 → null。
 * @param {string} href @param {{host: string, origin: string}} here 当前页（location）
 * @returns {{href: string, internal: boolean}|null}
 */
export function linkInfo(href, here) {
  const h = String(href || '').trim();
  if (/^\/(?!\/)/.test(h)) return { href: h, internal: true };
  let u;
  try { u = new URL(h); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return { href: u.href, internal: !!here && u.host === here.host };
}
/**
 * 块 → DOM（只用 createElement / textContent）。onInternal(url)：站内链接点击（不带修饰键）时调用，交给调用方关窗口后跳转。
 * @param {Document} doc @param {string} text @param {{here?: {host: string, origin: string}, newTab?: string, onInternal?: (url: string) => void}} [o]
 * @returns {DocumentFragment}
 */
export function renderMd(doc, text, o) {
  const opt = o || {};
  const here = opt.here || (typeof location !== 'undefined' ? location : { host: '', origin: '' });
  const frag = doc.createDocumentFragment();
  /** @param {Node} parent @param {MdInline[]} parts */
  const inline = function (parent, parts) {
    for (const p of parts) {
      if (p.t === 'br') parent.appendChild(doc.createElement('br'));
      else if (p.t === 'b') { const b = doc.createElement('strong'); b.textContent = p.v; parent.appendChild(b); }
      else if (p.t === 'a') {
        const li = linkInfo(p.href, here);
        if (!li) { parent.appendChild(doc.createTextNode(p.text)); continue; }
        const a = doc.createElement('a');
        a.className = 'sgx-ai-link';
        a.href = li.href;
        const tx = doc.createElement('span');
        tx.className = 'sgx-ai-link-text';
        tx.textContent = p.text;
        a.appendChild(tx);
        const ic = doc.createElement('span');
        ic.className = 'sgx-ai-link-icon';
        ic.setAttribute('aria-hidden', 'true');
        ic.textContent = '↗';
        a.appendChild(ic);
        if (li.internal) {
          if (opt.onInternal) {
            const go = opt.onInternal;
            a.addEventListener('click', function (e) {
              if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              go(li.href);
            });
          }
        } else {
          a.target = '_blank';
          a.rel = 'noopener';
          if (opt.newTab) a.setAttribute('aria-label', p.text + ' ' + opt.newTab);
        }
        parent.appendChild(a);
      } else parent.appendChild(doc.createTextNode(p.v));
    }
  };
  for (const b of mdParse(text)) {
    if (b.t === 'p') { const el = doc.createElement('p'); inline(el, b.c); frag.appendChild(el); }
    else {
      const el = doc.createElement(b.t);
      for (const it of b.items) { const li = doc.createElement('li'); inline(li, it); el.appendChild(li); }
      frag.appendChild(el);
    }
  }
  return frag;
}
/** gemini 联网来源 → 追加到回答末尾的一段（- [标题](地址)；标题里的方括号换成圆括号，免得断开链接语法） @param {any} items @param {string} label */
export function sourcesBlock(items, label) {
  const list = (Array.isArray(items) ? items : []).filter(function (/** @type {any} */ x) {
    return x && typeof x.url === 'string' && /^https?:\/\//i.test(x.url);
  }).slice(0, 8);
  if (!list.length) return '';
  return '\n\n' + label + '\n' + list.map(function (/** @type {any} */ x) {
    const tl = String(x.title || '').replace(/[\[\]]/g, function (c) { return c === '[' ? '(' : ')'; }).replace(/\s+/g, ' ').trim() || shortLabel(x.url);
    return '- [' + tl + '](' + x.url.replace(/[()\s]/g, function (c) { return c === '(' ? '%28' : c === ')' ? '%29' : '%20'; }) + ')';
  }).join('\n');
}

/**
 * 读 SSE：按空行切事件，回调 (event, data)。 @param {ReadableStream<Uint8Array>} body @param {(ev: string, data: any) => void} on
 */
export async function readSse(body, on) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const flush = function (/** @type {string} */ chunk) {
    let ev = 'message';
    const data = [];
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return;
    let d = null;
    try { d = JSON.parse(data.join('\n')); } catch (e) { d = null; }
    on(ev, d);
  };
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true }).replace(/\r\n/g, '\n');
    let k;
    while ((k = buf.indexOf('\n\n')) >= 0) {
      flush(buf.slice(0, k));
      buf = buf.slice(k + 2);
    }
  }
  buf += dec.decode();
  if (buf.trim()) flush(buf);
}

/**
 * 挂到 AI 窗口（#sgx-ai）上。topbar.js 第一次打开窗口时调用。
 * @param {HTMLDialogElement} dlg
 * @param {{ lang?: 'zh'|'en', close?: (after?: () => void) => void, navigate?: (url: string) => void, fetch?: typeof fetch, api?: string, store?: Storage,
 *   keyboard?: (cb: (h: number) => void) => () => void, coarse?: () => boolean }} [opts]
 *   keyboard：订阅键盘高度（px），返回退订函数（共享外壳 vk.js 的 onKeyboardHeight）；不传 = 不跟键盘。coarse：是否触屏（默认 matchMedia('(pointer: coarse)')）
 */
export function mountAiChat(dlg, opts) {
  const o = opts || {};
  const doc = dlg.ownerDocument;
  const t = shellStr(doc);
  const list = /** @type {HTMLElement} */ (dlg.querySelector('[data-ai-list]'));
  const form = /** @type {HTMLFormElement} */ (dlg.querySelector('[data-ai-form]'));
  const input = /** @type {HTMLTextAreaElement} */ (dlg.querySelector('[data-ai-in]'));
  const send = /** @type {HTMLButtonElement|null} */ (form && form.querySelector('button[type="submit"]'));
  const clear = /** @type {HTMLButtonElement|null} */ (dlg.querySelector('[data-ai-clear]'));
  const histBtn = /** @type {HTMLButtonElement|null} */ (dlg.querySelector('[data-ai-history]'));
  const hist = /** @type {HTMLElement|null} */ (dlg.querySelector('[data-ai-hist]'));
  const scope = /** @type {HTMLElement|null} */ (dlg.querySelector('[data-ai-scope]'));
  const contact = /** @type {HTMLAnchorElement|null} */ (dlg.querySelector('[data-ai-contact]'));
  if (!list || !form || !input) return {};
  /** 「联系我」换成本机缓存里改过的邮箱（没有就保持模板默认值） */
  function syncContact() {
    const e = cachedEmail(o.store);
    if (contact && e) {
      contact.setAttribute('href', 'mailto:' + e);
      /* 设计稿 ai-v1：底部右边直接显示邮箱（模板画的就是邮箱时跟着换） */
      const em = contact.querySelector('[data-ai-email]');
      if (em) em.textContent = e;
    }
  }
  syncContact();
  const doFetch = o.fetch || window.fetch.bind(window);
  /** @type {Chats} */
  let data = loadChats(o.store);
  /** 当前对话的 id（还没问过的新对话不在 data.chats 里） */
  let cur = '';
  /** @type {Msg[]} */
  let msgs = [];
  let busy = false;
  let histOpen = false;
  /** 回答进行中的那条（渲染时不带操作行） @type {Msg|null} */
  let live = null;
  /** @type {AbortController|null} */
  let ctl = null;
  const coarse = o.coarse || function () {
    try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { return false; }
  };

  /* 按键提示行（Gray 2026-11-09 细节 1；同 term/view/keyhint.js，这里只画几行，英文底用 term/core/strings.js 的 KH_EN）：桌面「enter 发送 · shift+enter 换行 · esc 关闭」，
     触屏换成「‹ 返回」按钮 = 关窗口（每个终端状态都有出口）。文案 #sgx-i18n-frame 的 kh 节 */
  (function () {
    const el = /** @type {HTMLElement|null} */ (dlg.querySelector('[data-ai-kh]'));
    if (!el) return;
    /** @type {Record<string, string>} */
    const K = Object.assign({ ai: KH_EN.ai, back: KH_EN.back, backAria: KH_EN.backAria }, shellSection(doc, 'kh'));
    el.textContent = '';
    if (coarse()) {
      if (!o.close) { el.hidden = true; return; }
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'sgx-kh-b';
      b.setAttribute('data-kh-back', '');
      b.setAttribute('aria-label', K.backAria);
      b.textContent = K.back;
      b.addEventListener('click', function (e) { e.preventDefault(); if (o.close) o.close(); });
      el.appendChild(b);
    } else {
      const k = doc.createElement('span');
      k.className = 'sgx-kh-k';
      k.setAttribute('aria-hidden', 'true');
      k.setAttribute('translate', 'no');
      k.textContent = K.ai;
      el.appendChild(k);
    }
    el.hidden = false;
  })();

  /** 从 data 取当前对话（cur 不在列表里 = 新对话，空） */
  function pickCurrent() {
    cur = data.cur || newChatId();
    const c = data.chats.find(function (x) { return x.id === cur; });
    msgs = c ? c.msgs.slice() : [];
  }
  /** 把当前对话写回历史列表（空对话不存）并存本地 */
  function persist() {
    const keep = msgs.filter(function (m) { return !m.error; });
    let c = data.chats.find(function (x) { return x.id === cur; });
    if (keep.length) {
      /* 新对话、或这份多了消息：挪到最前（最新的在前）。不能只靠 time 排：同一毫秒 / 时间被冻结时 time 相同，排序保持原顺序 */
      if (!c) { c = { id: cur, title: '', time: 0, msgs: [] }; data.chats.unshift(c); }
      else if (keep.length > c.msgs.length) { data.chats.splice(data.chats.indexOf(c), 1); data.chats.unshift(c); }
      c.msgs = keep;
      if (!c.title) c.title = chatTitle(keep);
      c.time = Math.max(c.time, keep[keep.length - 1].ts || Date.now());
    }
    data.cur = cur;
    saveChats(data, o.store);
  }
  pickCurrent();

  /* ---- 键盘跟随（P4-3 PR-3） ---- */
  /** @type {(() => void)|null} */
  let stopKb = null;
  let kbSeen = false;
  /** @param {number} h */
  function kbSet(h) {
    const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 4;
    dlg.style.setProperty('--sgx-kb', (h > 0 ? Math.round(h) : 0) + 'px');
    dlg.toggleAttribute('data-kb', h > 0);
    if (atEnd) list.scrollTop = list.scrollHeight;
  }
  function kbStop() {
    const s = stopKb;
    stopKb = null;
    kbSeen = false;
    if (s) { try { s(); } catch (e) {} }
    kbSet(0);
  }
  function kbStart() {
    if (stopKb || !o.keyboard) return;
    kbSeen = false;
    try {
      stopKb = o.keyboard(function (h) {
        if (h > 0) { kbSeen = true; kbSet(h); return; }
        /* 键盘升起过、现在收了而输入框还聚焦（系统返回 / 手势收键盘）→ 交出焦点，下次点输入框再弹 */
        if (kbSeen && doc.activeElement === input) { input.blur(); return; }
        kbSet(0);
      }) || null;
    } catch (e) {
      stopKb = null;
    }
  }
  input.addEventListener('focus', kbStart);
  input.addEventListener('blur', function () {
    /* 整个页面失焦（三星 Pass / 指纹窗口盖上来）不算离开输入框：跟着键盘高度走，焦点回来继续（同 vk.js followKeyboard） */
    try { if (!doc.hasFocus()) return; } catch (e) {}
    kbStop();
  });
  dlg.addEventListener('close', kbStop);

  /** @param {string} text @param {string} label @param {string} op */
  function opBtn(text, label, op) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'sgx-ai-op';
    b.setAttribute('data-op', op);
    b.textContent = text;
    if (label) b.setAttribute('aria-label', label);
    return b;
  }
  /** 复制到剪贴板（不支持 Clipboard API 时退回 execCommand） @param {string} text */
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    } catch (e) {}
    return new Promise(function (res, rej) {
      const ta = doc.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      dlg.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = doc.execCommand('copy'); } catch (e) {}
      ta.remove();
      if (ok) res(undefined); else rej(new Error('copy'));
    });
  }
  /** 助手回答下的操作行：复制 / 重试 / 👍 / 👎（出错的那条只给重试） @param {Msg} m */
  function ops(m) {
    const row = doc.createElement('div');
    row.className = 'sgx-ai-ops';
    const i = msgs.indexOf(m);
    const canRetry = i > 0 && msgs[i - 1].role === 'user';
    if (!m.error) {
      const cp = opBtn(t.copy, '', 'copy');
      cp.addEventListener('click', function () {
        copyText(m.text).then(function () {
          cp.textContent = t.copied;
          setTimeout(function () { cp.textContent = t.copy; }, 1500);
        }, function () {});
      });
      row.appendChild(cp);
    }
    if (canRetry) {
      const rt = opBtn(t.retry, '', 'retry');
      rt.disabled = busy;
      rt.addEventListener('click', function () { retry(m); });
      row.appendChild(rt);
    }
    if (!m.error) {
      const up = opBtn('👍', t.up, 'up');
      const dn = opBtn('👎', t.down, 'down');
      const paint = function () {
        up.setAttribute('aria-pressed', String(m.rate === 'up'));
        dn.setAttribute('aria-pressed', String(m.rate === 'down'));
      };
      /** @param {'up'|'down'} v */
      const rate = function (v) {
        if (m.rate === v) delete m.rate; else m.rate = v;
        paint();
        persist();
      };
      up.addEventListener('click', function () { rate('up'); });
      dn.addEventListener('click', function () { rate('down'); });
      paint();
      row.appendChild(up);
      row.appendChild(dn);
    }
    return row;
  }
  /** 站内链接：关窗口后同页跳转 @param {string} url */
  function goInternal(url) {
    const nav = o.navigate || function (/** @type {string} */ u) { location.href = u; };
    if (o.close) o.close(function () { nav(url); }); else nav(url);
  }
  /** 助手回答的正文：有限 Markdown（出错的提示照旧纯文本） @param {HTMLElement} tx @param {string} text */
  function paintAnswer(tx, text) {
    tx.replaceChildren(renderMd(doc, text, { newTab: t.newTab, onInternal: goInternal }));
  }
  /** @param {Msg} m @returns {HTMLElement} */
  function bubble(m) {
    const el = doc.createElement('div');
    el.className = 'sgx-ai-msg';
    el.setAttribute('data-role', m.role);
    if (m.error) el.setAttribute('data-state', 'error');
    const md = m.role === 'assistant' && !m.error;
    const tx = doc.createElement('span'); /* 仍是 span（e2e 按 .sgx-ai-msg > span 取正文）；Markdown 时 display:block */
    if (md) { tx.className = 'sgx-ai-md'; paintAnswer(tx, m.text); }
    else tx.textContent = m.text;
    el.appendChild(tx);
    if (m.role !== 'assistant') return el;
    /* 助手回答：气泡 + 下面一行操作（回答进行中的那条先不带） */
    const turn = doc.createElement('div');
    turn.className = 'sgx-ai-turn';
    turn.appendChild(el);
    if (m === live) turn.setAttribute('data-live', '');
    else if (m.text) {
      const cards = srcCards(m.text);
      if (cards) turn.appendChild(cards);
      turn.appendChild(ops(m));
    }
    return turn;
  }
  /**
   * 来源卡片（设计稿 ai-v1）：回答里出现的站内链接 [标题](/路径)，去重后最多 3 条，卡片 = 路径前两段（blog/post）+ 标题；点了关窗口再跳（同正文里的站内链接）。
   * 正文里的链接照旧可点；这里只是把站内去处再列一遍。
   * @param {string} text @returns {HTMLElement|null}
   */
  function srcCards(text) {
    const re = /\[([^\]\n]{1,120})\]\((\/[^)\s]*)\)/g;
    /** @type {Array<[string, string]>} */
    const seen = [];
    let mm;
    while ((mm = re.exec(text)) && seen.length < 3) {
      const href = mm[2];
      if (href.indexOf('//') === 0 || seen.some(function (x) { return x[1] === href; })) continue;
      seen.push([mm[1], href]);
    }
    if (!seen.length) return null;
    const box = doc.createElement('div');
    box.className = 'sgx-ai-srcs';
    for (const [title, href] of seen) {
      const a = doc.createElement('a');
      a.className = 'sgx-ai-src';
      a.href = href;
      const segs = href.split(/[?#]/)[0].split('/').filter(Boolean).filter(function (x) { return x !== 'zh' && x !== 'en'; });
      const lab = doc.createElement('code');
      lab.textContent = segs.slice(0, 2).join('/') || '~';
      lab.setAttribute('translate', 'no');
      const ti = doc.createElement('span');
      ti.textContent = title;
      a.appendChild(lab);
      a.appendChild(ti);
      a.addEventListener('click', function (e) {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        goInternal(href);
      });
      box.appendChild(a);
    }
    return box;
  }
  /** 建议问题（设计稿 ai-v1 回答下面那排小块）：点一下 = 直接问这一句；回答进行中不显示 */
  function sugRow() {
    const row = doc.createElement('div');
    row.className = 'sgx-ai-sugs';
    for (const k of ['sug1', 'sug2', 'sug3']) {
      const q = t[k];
      if (!q) continue;
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'sgx-ai-sug';
      b.textContent = q;
      b.addEventListener('click', function () { if (!busy) ask(q); });
      row.appendChild(b);
    }
    return row;
  }
  function render() {
    list.replaceChildren();
    if (!msgs.length) {
      /* 空态：开场白，助手气泡样式，不存进历史、不带操作行 */
      const el = doc.createElement('div');
      el.className = 'sgx-ai-msg';
      el.setAttribute('data-role', 'assistant');
      el.setAttribute('data-greet', '');
      const tx = doc.createElement('span');
      tx.textContent = t.greet;
      el.appendChild(tx);
      list.appendChild(el);
    } else {
      for (const m of msgs) list.appendChild(bubble(m));
    }
    if (!busy) list.appendChild(sugRow());
    if (clear) clear.disabled = !msgs.length || busy;
    if (histBtn) histBtn.disabled = busy;
    list.scrollTop = list.scrollHeight;
  }
  /** @param {number} ts */
  function fmtTime(ts) {
    try {
      const d = new Date(ts);
      const now = new Date();
      const sameDay = d.toDateString() === now.toDateString();
      const loc = doc.documentElement.lang || 'en'; /* 按页面语言交给 Intl（语言包化 2026-11-07） */
      return sameDay
        ? d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', hour12: false })
        : d.toLocaleString(loc, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    } catch (e) {
      return '';
    }
  }
  /** 历史列表（窗口内的视图，按时间倒序；点一条载入；输入框里正在写的字不动） */
  function renderHist() {
    if (!hist) return;
    hist.replaceChildren();
    if (!data.chats.length) {
      const p = doc.createElement('p');
      p.className = 'sgx-ai-hist-empty';
      p.textContent = t.histEmpty;
      hist.appendChild(p);
      return;
    }
    /* 倒序：最新的在前（persist 把有新消息的那份挪到最前；time 相同时稳定排序保持这个顺序） */
    for (const c of data.chats.slice().sort(function (a, b) { return b.time - a.time; })) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'sgx-ai-hist-item';
      b.setAttribute('data-chat', c.id);
      if (c.id === cur) b.setAttribute('aria-current', 'true');
      const ti = doc.createElement('span');
      ti.className = 'sgx-ai-hist-title';
      ti.textContent = c.title || t.untitled;
      const tm = doc.createElement('span');
      tm.className = 'sgx-ai-hist-time';
      tm.textContent = fmtTime(c.time);
      b.appendChild(ti);
      b.appendChild(tm);
      b.addEventListener('click', function () {
        if (busy) return;
        cur = c.id;
        msgs = c.msgs.slice();
        data.cur = cur;
        saveChats(data, o.store);
        showHist(false);
        render();
      });
      hist.appendChild(b);
    }
  }
  /** @param {boolean} v */
  function showHist(v) {
    histOpen = v;
    if (hist) {
      if (v) renderHist();
      hist.hidden = !v;
    }
    if (histBtn) histBtn.setAttribute('aria-expanded', String(v));
  }
  function setBusy(/** @type {boolean} */ v) {
    /* 顶栏头像外圈的弧转快一档（等回答时；topbar/panel.js mountAvBusy 收 sgx-busy 事件，2026-11-09） */
    if (v !== busy) { try { doc.dispatchEvent(new CustomEvent('sgx-busy', { detail: v })); } catch (e) {} }
    busy = v;
    if (send) {
      send.disabled = false;
      send.toggleAttribute('data-stop', v);
      send.setAttribute('aria-label', v ? t.stop : t.send);
    }
    if (clear) clear.disabled = v || !msgs.length;
    if (histBtn) histBtn.disabled = v;
    dlg.toggleAttribute('aria-busy', v);
  }
  /** @param {string|null} s */
  function setScope(s) {
    if (scope) scope.textContent = s === 'private' ? t.scopePrivate : t.scopePublic;
  }

  /** 没进站（接口 401）：模型胶囊换锁标、不发问（见下面「模型」一节 setLocked） */
  let locked = false;
  /**
   * 问一句。redo = 重试：替换这条回答（不追加），历史只带它前面那条提问之前的对话。
   * @param {string} q @param {Msg} [redo]
   */
  async function ask(q, redo) {
    if (busy) return;
    q = q.trim();
    if (!q) return;
    /* 没进站（v5 S3 三处上锁之一）：不发问，打开终端预填 su ；输入框里的问题留着 */
    if (locked) { askSudo(doc); return; }
    if (histOpen) showHist(false);
    if ([...q].length > Q_MAX) {
      msgs.push({ role: 'assistant', text: t.tooLong, ts: Date.now(), error: true });
      render();
      return;
    }
    /** @type {Msg} */
    let ans;
    let history;
    if (redo) {
      const i = msgs.indexOf(redo);
      history = historyForServer(msgs.slice(0, i - 1));
      ans = redo;
      ans.text = '';
      ans.ts = Date.now();
      delete ans.error;
      delete ans.rate;
    } else {
      history = historyForServer(msgs);
      msgs.push({ role: 'user', text: q, ts: Date.now() });
      ans = { role: 'assistant', text: '', ts: Date.now() };
      msgs.push(ans);
    }
    live = ans;
    setBusy(true);
    render();
    const liveEl = /** @type {HTMLElement|null} */ (list.querySelector('[data-live] .sgx-ai-msg'));
    const liveText = /** @type {HTMLElement|null} */ (liveEl && liveEl.firstChild);
    /* 等第一段回答时一行输出式的提示「› 正在查站内内容…」（Gray 2026-11-09 细节 3；消息区是 aria-live，读屏照念） */
    if (liveText) liveText.textContent = '› ' + t.thinking;
    ctl = typeof AbortController === 'function' ? new AbortController() : null;
    let failed = '';
    /** @type {Record<string, any>} */
    const payload = { q, lang: o.lang || doc.documentElement.lang || 'en', history };
    let model = loadModel(o.store);
    try {
      let res;
      for (let retried = false; ; retried = true) {
        res = await doFetch(o.api || AI_API, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(model ? Object.assign({}, payload, { model: model }) : payload),
          signal: ctl ? ctl.signal : undefined,
        });
        if (res.ok && res.body) break;
        let j = null;
        try { j = await res.json(); } catch (e) {}
        /* 选中的模型被下架：清掉本地选择，用默认模型重发一次（只一次） */
        if (model && !retried && isBadModel(res.status, j)) {
          clearModel(o.store);
          model = '';
          continue;
        }
        failed = errKey(res.status, j);
        break;
      }
      if (!failed) {
        setScope(res.headers.get('X-Styrigx-AI-Scope'));
        await readSse(res.body, function (ev, d) {
          if (ev === 'delta' && d && typeof d.text === 'string') {
            ans.text += d.text;
            if (liveText) paintAnswer(liveText, ans.text);
            list.scrollTop = list.scrollHeight;
          } else if (ev === 'sources' && d && ans.text) {
            ans.text += sourcesBlock(d.items, t.sources);
          } else if (ev === 'error') failed = errKey(0, d);
        });
        if (!ans.text && !failed) failed = 'fail';
      }
    } catch (e) {
      failed = e && /** @type {any} */ (e).name === 'AbortError' ? '' : 'fail';
      if (!failed && !ans.text) msgs.splice(msgs.indexOf(ans), 1);
    } finally {
      ctl = null;
    }
    if (failed === 'unauthorized') setLocked(true);
    if (failed) {
      if (ans.text) ans.text += '\n\n' + /** @type {any} */ (t)[failed];
      else { ans.text = /** @type {any} */ (t)[failed]; ans.error = true; }
    }
    live = null;
    setBusy(false);
    persist();
    render();
  }
  /** 重试：取这条回答前面那条提问重新问，替换这条回答 @param {Msg} m */
  function retry(m) {
    if (busy) return;
    const i = msgs.indexOf(m);
    if (i < 1 || msgs[i - 1].role !== 'user') return;
    ask(msgs[i - 1].text, m);
  }

  /* ---------- tty4（终端统一 T6c，设计稿 v1.5 §2.3 / §8.4）：以 $ 开头的输入是命令，走站内终端同一张命令表 ----------
     命令和输出只在窗口里显示，不进 AI 对话、不存 sgx-ai-history；命令自己的历史在 sgx-term-hist-4（↑↓ 只在输入以 $ 开头时翻它）。
     输出是临时的：下一次问 AI、换对话时整份重画就没了。 */
  const CMD_RE = /^\s*\$/;
  /** 去掉开头的 $ @param {string} v */
  const cmdPart = function (v) { return v.replace(/^\s*\$\s?/, ''); };
  /** @returns {any} */
  const t4 = function () { return typeof o.term === 'function' ? o.term() : null; };
  /** 一条输出 → 几行纯文字 @param {any} x @returns {string[]} */
  function outLines(x) {
    const segs = function (/** @type {any[]} */ sg) { return sg.map(function (z) { return z[1]; }).join(''); };
    if (x.t === 'help') return [segs(x.head)].concat(x.rows.map(function (/** @type {any[]} */ r) { return r[0] + '  ' + r[1]; }));
    return [segs(x.seg)];
  }
  /** 往对话列表里加一块（在建议问题那排前面） @param {string} role @param {string[]} lines */
  function termBlock(role, lines) {
    const el = doc.createElement('div');
    el.className = 'sgx-ai-msg';
    el.setAttribute('data-role', role);
    el.setAttribute('data-term', '');
    el.setAttribute('translate', 'no');
    const tx = doc.createElement('span');
    lines.forEach(function (l) { const d = doc.createElement('div'); d.textContent = l; tx.appendChild(d); });
    el.appendChild(tx);
    list.insertBefore(el, list.querySelector('.sgx-ai-sugs'));
    list.scrollTop = list.scrollHeight;
  }
  /** @param {string} line 去掉 $ 后的命令 */
  function runCmd(line) {
    const T = t4();
    if (!T || !T.shell) return;
    if (histOpen) showHist(false);
    termBlock('user', ['$ ' + line.trim()]);
    /** @param {any} r */
    const done = function (r) {
      if (!r) return;
      if (r.clear) list.querySelectorAll('[data-term]').forEach(function (n) { n.remove(); });
      else {
        /** @type {string[]} */
        let ls = [];
        (r.out || []).forEach(function (/** @type {any} */ x) { ls = ls.concat(outLines(x)); });
        if (ls.length) termBlock('assistant', ls);
      }
      if (r.after) r.after();
    };
    const r = T.shell.exec(line);
    if (r && typeof r.then === 'function') r.then(done, function () {});
    else done(r);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    const q = input.value;
    if (CMD_RE.test(q) && t4()) {
      input.value = '';
      if (cmdPart(q).trim()) runCmd(cmdPart(q));
      return;
    }
    input.value = '';
    /* 发出去之后：触屏收键盘看回答；桌面焦点回输入框接着问（鼠标点发送时焦点在按钮上）。空的不算发 */
    if (q.trim()) {
      if (coarse()) { try { input.blur(); } catch (e2) {} }
      else { try { input.focus({ preventScroll: true }); } catch (e2) {} }
    }
    ask(q);
  });
  /* 回答进行中，发送按钮是停止按钮：点它中断这次回答 */
  if (send) {
    send.addEventListener('click', function (e) {
      if (!busy) return;
      e.preventDefault();
      if (ctl) ctl.abort();
    });
    /*
     * 触屏（P4-3 后续 §5）：键盘弹着时点发送，手指一按下输入框就失焦 → 键盘收起、窗口下沿落回底部、发送按钮跟着下移，
     * 抬手时 click 落空，消息没发。按下时 preventDefault（焦点不离开输入框，窗口不动，也不再派生 click），
     * 抬手时手指还在按钮上就当一次点击：回答中 = 停止，否则提交（submit 里照旧收键盘）。
     */
    /** @type {DOMRect|null} */
    let downRect = null;
    send.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { downRect = null; return; }
      e.preventDefault();
      downRect = send.getBoundingClientRect();
    }, { passive: false });
    send.addEventListener('touchcancel', function () { downRect = null; });
    send.addEventListener('touchend', function (e) {
      const r = downRect;
      downRect = null;
      if (!r) return;
      e.preventDefault();
      const p = e.changedTouches && e.changedTouches[0];
      if (!p || p.clientX < r.left || p.clientX > r.right || p.clientY < r.top || p.clientY > r.bottom) return;
      if (busy) { if (ctl) ctl.abort(); return; }
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true }));
    }, { passive: false });
  }
  /* 回车发送，Shift+回车换行（输入法组字中不算）；回答进行中回车不发、也不中断 */
  input.addEventListener('keydown', function (e) {
    /* tty4：输入以 $ 开头时 ↑↓ 翻命令历史、Tab 补全；其余照旧 */
    if (!e.isComposing && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && CMD_RE.test(input.value) && t4()) {
      const T = t4();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const v = e.key === 'ArrowUp' ? T.shell.prev(cmdPart(input.value)) : T.shell.next();
        if (v !== null) {
          e.preventDefault();
          input.value = '$ ' + v;
          try { input.setSelectionRange(input.value.length, input.value.length); } catch (err) {}
        }
        return;
      }
      if (e.key === 'Tab' && cmdPart(input.value).trim() && T.complete) {
        e.preventDefault();
        const c = T.complete(cmdPart(input.value));
        if (c.options.length > 1 && c.line === cmdPart(input.value)) termBlock('assistant', [c.options.join('  ')]);
        input.value = '$ ' + c.line;
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (busy) return;
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });
  /* 新对话：当前对话已在历史里（每问一次就存），开一份空的新对话 */
  if (clear) {
    clear.addEventListener('click', function () {
      if (busy) return;
      persist();
      cur = newChatId();
      msgs = [];
      data.cur = cur;
      saveChats(data, o.store);
      showHist(false);
      render();
      /* 同打开时：触屏不自动聚焦（程序化聚焦弹键盘；桌面版网站下浏览器还会放大到输入框），桌面回输入框且不滚动 */
      if (!coarse()) { try { input.focus({ preventScroll: true }); } catch (e) {} }
    });
  }
  if (histBtn) {
    histBtn.addEventListener('click', function () {
      if (busy) return;
      if (!histOpen) data = loadChats(o.store);
      showHist(!histOpen);
    });
  }
  /* ---------- 模型（设计稿 ai-v1 头部「Gemma 4 ▾」）：GET /api/ai → { default, models, canChoose }（同账号页 AI 模型一行）；
     显示当前生效的模型；canChoose（有账号会话）时点开在头部下面展开单选，选中写 sgx-ai-model 并派发 sgx-settings-changed（云同步跟着走）；
     不能选时只显示、点了不展开；读不到就不显示。
     没进站（GET / POST /api/ai 回 401；v5 S3 三处上锁之一）：同一个小矩形里换成锁标（.is-locked），点了 / 发问都发 sgx:sudo ---------- */
  const mBtn = /** @type {HTMLButtonElement|null} */ (dlg.querySelector('[data-ai-model]'));
  const mName = /** @type {HTMLElement|null} */ (dlg.querySelector('[data-ai-model-name]'));
  const mList = /** @type {HTMLElement|null} */ (dlg.querySelector('[data-ai-models]'));
  /** @type {any} */
  let models = null;
  const modelLabel = mBtn ? mBtn.getAttribute('aria-label') || '' : '';
  const store = function () { return o.store || window.localStorage; };
  function curModel() {
    if (!models) return null;
    let mine = '';
    try { mine = store().getItem(MODEL_KEY) || ''; } catch (e) {}
    const ls = /** @type {any[]} */ (models.models);
    return (models.canChoose && ls.find(function (m) { return m && m.id === mine; })) || ls.find(function (m) { return m && m.id === models.default; }) || ls[0] || null;
  }
  /** @param {boolean} v */
  function showModels(v) {
    if (!mList || !mBtn) return;
    mList.hidden = !v;
    mBtn.setAttribute('aria-expanded', String(v));
    if (!v) return;
    mList.replaceChildren();
    const c = curModel();
    for (const m of /** @type {any[]} */ (models.models)) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'sgx-ai-mopt';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(!!c && c.id === m.id));
      b.setAttribute('translate', 'no');
      b.textContent = String(m.label || m.id);
      b.addEventListener('click', function () {
        try { store().setItem(MODEL_KEY, String(m.id)); } catch (e) {}
        try { window.dispatchEvent(new Event('sgx-settings-changed')); } catch (e) {}
        paintModel();
        showModels(false);
        try { mBtn.focus({ preventScroll: true }); } catch (e) {}
      });
      mList.appendChild(b);
    }
  }
  /** @param {boolean} v */
  function setLocked(v) {
    locked = v;
    if (!mBtn) return;
    mBtn.classList.toggle('is-locked', v);
    if (v) {
      mBtn.hidden = false;
      mBtn.removeAttribute('aria-disabled');
      mBtn.setAttribute('aria-label', t.locked);
      showModels(false);
    } else {
      mBtn.setAttribute('aria-label', modelLabel);
    }
  }
  function paintModel() {
    const c = curModel();
    if (!mBtn || !mName || !c || locked) return;
    mName.textContent = String(c.label || c.id);
    mBtn.hidden = false;
    if (models.canChoose) mBtn.removeAttribute('aria-disabled'); else mBtn.setAttribute('aria-disabled', 'true');
  }
  function loadModels() {
    if (!mBtn) return;
    Promise.resolve().then(function () { return doFetch('/api/ai', { method: 'GET', credentials: 'same-origin' }); })
      .then(function (r) {
        if (r && r.status === 401) { setLocked(true); return null; }
        if (r && r.ok) setLocked(false);
        return r && r.ok ? r.json() : null;
      })
      .then(function (j) {
        if (!j || !Array.isArray(j.models) || !j.models.length) return;
        models = j;
        paintModel();
      }, function () {});
  }
  /* 2c：v6 su / exit / lock 之后页面标记就地切（window 'sgx:session'，detail.live）：登录了当场解锁、重取模型（不在 ai 组的问了再回 403 forbidden 文案）；
     回访客当场上锁。守卫首帧那次没有 live，不管 */
  const win = doc.defaultView || window;
  win.addEventListener('sgx:session', function (/** @type {any} */ e) {
    const d = e && e.detail;
    if (!d || !d.live) return;
    if (d.ok) { setLocked(false); loadModels(); } else setLocked(true);
  });
  if (mBtn) {
    mBtn.addEventListener('click', function () {
      if (locked) { askSudo(doc); return; }
      if (!models || !models.canChoose) return;
      showModels(mList ? mList.hidden : false);
    });
  }
  if (mList) {
    mList.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); showModels(false); if (mBtn) mBtn.focus(); }
    });
  }
  /* 别的标签页 / 子站改了历史（同源同一份）：下次打开时重读 */
  render();
  setScope(null);
  return {
    onOpen: function () {
      syncContact();
      loadModels();
      showModels(false);
      if (!busy) {
        data = loadChats(o.store);
        pickCurrent();
        showHist(false);
        render();
      }
      /* 触屏不自动聚焦（程序化聚焦会弹键盘盖住输入框）；桌面照旧 */
      if (!coarse()) { try { input.focus({ preventScroll: true }); } catch (e) {} }
    },
    ask: ask,
    abort: function () { if (ctl) ctl.abort(); },
  };
}
