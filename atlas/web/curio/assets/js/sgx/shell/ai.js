/* @sgx-shell:begin styrigx/styrigx-space@tree:9c4ad417c51d space/web/shared/shell vaf20c15030a1（space/scripts/curio/sync-shell.mjs 写入，勿手改） */
/* ---- ai.js ---- */
/**
 * @fileoverview AI 窗口的内容（2026-11-04 P5-1，第 4 件前端，方案 5.5）：站内对话助手，四个站同一份。
 * 共享外壳组件：gen-shell 原样复制成 space/web/shared/shell/ai.js；窗口的开合 / 互斥由 topbar.js（主站 shell/topbar-panel.js）管，这里只管窗口里面。
 * 自成一体：不 import 任何东西。
 *
 * - 问：POST /api/ai（同源，credentials: same-origin）{ q, lang, history } → text/event-stream：event delta…（回答分段）→ done（2026-11-06 起不再有 event hits，不显示来源卡片：链接只出现在模型写的正文里）；
 *   出错时 event error。响应头 X-Styrigx-AI-Scope: private | public 只用来在底部小字说明「包含私密内容 / 仅公开内容」。
 *   网关的错误码（P4-1）：401 unauthorized（锁屏会话失效）· 429 cooldown / busy · 400 too-long · 413 too-large · 502 / 503 upstream。
 * - 历史只存本地 localStorage sgx-ai-history（P4-3 后续 §3.3：{v:2, cur, chats:[{id, title, time, msgs:[{role, text, ts, rate?}]}]}，多份对话，每份最多 50 条，
 *   最多 20 份、超了删最旧的；title = 首问前 20 字；cur = 当前对话 id。读到 v1 {v:1, msgs} 包成一份对话写回 v2；旧记录里可能还带 hits，读出来不渲染）；
 *   四站同源所以同一台设备上是同一份（同源带来的，不是同步）；
 *   lib/cloud-sync.js 的白名单不收这个键，不跨设备。发给服务端的 history 只带最近 6 条 {role, text}（服务端再截 2000 字）。
 * - 顶部两行（§3.2）：标题 Gray AI；下面一行新对话（data-ai-clear：当前对话已在历史里，开一份空的）/ 历史（data-ai-history：窗口内的列表视图，不是底部弹出窗口）/
 *   联系（data-ai-contact：mailto:ai@styrigx.com）。空态显示开场白（助手气泡样式，不存历史）。
 * - 每条助手回答下（§3.4）：复制 / 重试（重问前面那条提问，替换这条回答）/ 👍 / 👎（只存本地，记在该条消息的 rate 上，再点取消）。
 * - 模型（P4-2d）：账号页「AI 模型」一行把选择存在 localStorage sgx-ai-model（进云同步，换设备跟着走）；这里发问时有就带上 body.model，
 *   窗口里不做切换。服务端只在有账号会话时采纳（没登录带了也忽略，一律默认模型），不在登记里 → 400 bad_model：
 *   清掉本地选择、不带 model 自动重发一次（只重发一次；再错按普通错误显示）。清掉时派发 sgx-settings-changed，主站的云同步把删除推上去。
 *   响应头 X-Styrigx-AI-Model（这次用的模型 id）只用于排查，这里不显示。
 * - 键盘（P4-3 PR-3）：输入框聚焦时订阅键盘高度（调用方传入 opts.keyboard = 共享外壳 vk.js 的 onKeyboardHeight），写到 #sgx-ai 的 --sgx-kb：
 *   窗口下沿抬到键盘上沿，消息列表在窗口内压缩，标题栏和输入框都留在可视区；键盘高度从有到 0 而输入框仍聚焦（系统手势收键盘）→ 自动 blur()。
 *   粗指针（触屏）打开窗口不自动聚焦、点发送后 blur() 收键盘；细指针（桌面）照旧打开即聚焦，发送后焦点回输入框（鼠标点发送也一样，§4）。
 *   触屏点发送按钮在 touchstart 就 preventDefault、touchend 提交：不让输入框先失焦收键盘、按钮下移把这次点击吃掉（§5）。
 * - 停止：回答进行中发送按钮变停止按钮（data-stop，读屏名「停止」），点它接 abort()；已收到的部分保留，答完 / 停下后变回发送。
 */

export const AI_API = '/api/ai';
export const HISTORY_KEY = 'sgx-ai-history';
export const HISTORY_MAX = 50;
/** 历史列表最多存几份对话 / 标题取首问前几个字（P4-3 后续 §3.3） */
export const CHATS_MAX = 20;
export const TITLE_MAX = 20;
export const SEND_HISTORY = 6;
export const Q_MAX = 200;
/** 账号页选的模型 id（P4-2d；四站同源同一份；lib/cloud-sync.js 的 EXTRA 收这个键） */
export const MODEL_KEY = 'sgx-ai-model';

const STR = {
  zh: {
    greet: '你好，我是 Gray 的 AI 助手。想了解站里的内容，或者聊聊你手上的问题，都行。',
    histEmpty: '还没有历史对话',
    untitled: '（无标题）',
    copy: '复制',
    copied: '已复制',
    retry: '重试',
    up: '有用',
    down: '没用',
    thinking: '正在查站内内容…',
    scopePublic: '仅公开内容',
    scopePrivate: '包含私密内容',
    unauthorized: '锁屏会话已失效，请重新解锁后再问',
    cooldown: '问得太快了，请一分钟后再试',
    busy: '现在问的人太多，请稍后再试',
    tooLong: '问题太长了，最多 200 字',
    quota: '今天的额度用完了，明天再来',
    fail: '没能拿到回答，请稍后再试',
    send: '发送',
    stop: '停止',
  },
  en: {
    greet: "Hi, I'm Gray's AI assistant. Ask about this site, or talk through whatever you're working on.",
    histEmpty: 'No past chats yet',
    untitled: '(Untitled)',
    copy: 'Copy',
    copied: 'Copied',
    retry: 'Retry',
    up: 'Helpful',
    down: 'Not helpful',
    thinking: 'Searching this site…',
    scopePublic: 'Public content only',
    scopePrivate: 'Includes private content',
    unauthorized: 'Your session has expired. Unlock again to ask',
    cooldown: 'Too many questions. Try again in a minute',
    busy: 'Lots of people are asking right now. Try again shortly',
    tooLong: 'That question is too long (200 characters max)',
    quota: 'Today’s quota is used up. Come back tomorrow',
    fail: 'Couldn’t get an answer. Please try again',
    send: 'Send',
    stop: 'Stop',
  },
};

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
  if (status === 429) return e === 'busy' ? 'busy' : 'cooldown';
  if (status === 400 && e === 'too-long') return 'tooLong';
  if (status === 413) return 'tooLong';
  if (e === 'quota') return 'quota';
  return 'fail';
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
  const t = o.lang === 'en' ? STR.en : STR.zh;
  const list = /** @type {HTMLElement} */ (dlg.querySelector('[data-ai-list]'));
  const form = /** @type {HTMLFormElement} */ (dlg.querySelector('[data-ai-form]'));
  const input = /** @type {HTMLTextAreaElement} */ (dlg.querySelector('[data-ai-in]'));
  const send = /** @type {HTMLButtonElement|null} */ (form && form.querySelector('button[type="submit"]'));
  const clear = /** @type {HTMLButtonElement|null} */ (dlg.querySelector('[data-ai-clear]'));
  const histBtn = /** @type {HTMLButtonElement|null} */ (dlg.querySelector('[data-ai-history]'));
  const hist = /** @type {HTMLElement|null} */ (dlg.querySelector('[data-ai-hist]'));
  const scope = /** @type {HTMLElement|null} */ (dlg.querySelector('[data-ai-scope]'));
  if (!list || !form || !input) return {};
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
  /** @param {Msg} m @returns {HTMLElement} */
  function bubble(m) {
    const el = doc.createElement('div');
    el.className = 'sgx-ai-msg';
    el.setAttribute('data-role', m.role);
    if (m.error) el.setAttribute('data-state', 'error');
    const tx = doc.createElement('span');
    tx.textContent = m.text;
    el.appendChild(tx);
    if (m.role !== 'assistant') return el;
    /* 助手回答：气泡 + 下面一行操作（回答进行中的那条先不带） */
    const turn = doc.createElement('div');
    turn.className = 'sgx-ai-turn';
    turn.appendChild(el);
    if (m === live) turn.setAttribute('data-live', '');
    else if (m.text) turn.appendChild(ops(m));
    return turn;
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
      const loc = o.lang === 'en' ? 'en-US' : 'zh-CN';
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

  /**
   * 问一句。redo = 重试：替换这条回答（不追加），历史只带它前面那条提问之前的对话。
   * @param {string} q @param {Msg} [redo]
   */
  async function ask(q, redo) {
    if (busy) return;
    q = q.trim();
    if (!q) return;
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
    if (liveText) liveText.textContent = t.thinking;
    ctl = typeof AbortController === 'function' ? new AbortController() : null;
    let failed = '';
    /** @type {Record<string, any>} */
    const payload = { q, lang: o.lang === 'en' ? 'en' : 'zh', history };
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
            if (liveText) liveText.textContent = ans.text;
            list.scrollTop = list.scrollHeight;
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

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    const q = input.value;
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
      try { input.focus(); } catch (e) {}
    });
  }
  if (histBtn) {
    histBtn.addEventListener('click', function () {
      if (busy) return;
      if (!histOpen) data = loadChats(o.store);
      showHist(!histOpen);
    });
  }
  /* 别的标签页 / 子站改了历史（同源同一份）：下次打开时重读 */
  render();
  setScope(null);
  return {
    onOpen: function () {
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
/* @sgx-shell:end */
