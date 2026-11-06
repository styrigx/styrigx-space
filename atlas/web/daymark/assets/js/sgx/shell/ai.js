/* @sgx-shell:begin styrigx/styrigx-space@tree:32a9f7169288 space/web/shared/shell va5bce8668afd（space/scripts/daymark/sync-shell.mjs 写入，勿手改） */
/* ---- ai.js ---- */
/**
 * @fileoverview AI 窗口的内容（2026-11-04 P5-1，第 4 件前端，方案 5.5）：站内对话助手，四个站同一份。
 * 共享外壳组件：gen-shell 原样复制成 space/web/shared/shell/ai.js；窗口的开合 / 互斥由 topbar.js（主站 shell/topbar-panel.js）管，这里只管窗口里面。
 * 自成一体：不 import 任何东西。
 *
 * - 问：POST /api/ai（同源，credentials: same-origin）{ q, lang, history } → text/event-stream：event hits（来源列表）→ delta…（回答分段）→ done；
 *   出错时 event error。响应头 X-Styrigx-AI-Scope: private | public 只用来在底部小字说明「包含私密内容 / 仅公开内容」。
 *   网关的错误码（P4-1）：401 unauthorized（锁屏会话失效）· 429 cooldown / busy · 400 too-long · 413 too-large · 502 / 503 upstream。
 * - 历史只存本地 localStorage sgx-ai-history（{v:1, msgs:[{role, text, hits?, ts}]}，最多 50 条）；四站同源所以同一台设备上是同一份（同源带来的，不是同步）；
 *   lib/cloud-sync.js 的白名单不收这个键，不跨设备。发给服务端的 history 只带最近 6 条 {role, text}（服务端再截 2000 字）。
 * - 清空：删本地历史。AI 窗口就是新的聊天入口；/chat/ 页不换后端，P4-2 退役。
 * - 模型（P4-2d）：账号页「AI 模型」一行把选择存在 localStorage sgx-ai-model（进云同步，换设备跟着走）；这里发问时有就带上 body.model，
 *   窗口里不做切换。服务端只在有账号会话时采纳（没登录带了也忽略，一律默认模型），不在登记里 → 400 bad_model：
 *   清掉本地选择、不带 model 自动重发一次（只重发一次；再错按普通错误显示）。清掉时派发 sgx-settings-changed，主站的云同步把删除推上去。
 *   响应头 X-Styrigx-AI-Model（这次用的模型 id）只用于排查，这里不显示。
 * - 键盘（P4-3 PR-3）：输入框聚焦时订阅键盘高度（调用方传入 opts.keyboard = 共享外壳 vk.js 的 onKeyboardHeight），写到 #sgx-ai 的 --sgx-kb：
 *   窗口下沿抬到键盘上沿，消息列表在窗口内压缩，标题栏和输入框都留在可视区；键盘高度从有到 0 而输入框仍聚焦（系统手势收键盘）→ 自动 blur()。
 *   粗指针（触屏）打开窗口不自动聚焦、点发送后 blur() 收键盘；细指针（桌面）照旧打开即聚焦、发送后焦点留在输入框。
 * - 停止：回答进行中发送按钮变停止按钮（data-stop，读屏名「停止」），点它接 abort()；已收到的部分保留，答完 / 停下后变回发送。
 */

export const AI_API = '/api/ai';
export const HISTORY_KEY = 'sgx-ai-history';
export const HISTORY_MAX = 50;
export const SEND_HISTORY = 6;
export const Q_MAX = 200;
/** 账号页选的模型 id（P4-2d；四站同源同一份；lib/cloud-sync.js 的 EXTRA 收这个键） */
export const MODEL_KEY = 'sgx-ai-model';

const STR = {
  zh: {
    empty: '问一句，回答来自站内内容，并附上来源。',
    thinking: '正在查站内内容…',
    scopePublic: '仅公开内容',
    scopePrivate: '包含私密内容',
    sources: '来源',
    unauthorized: '锁屏会话已失效，请重新解锁后再问',
    cooldown: '问得太快了，请一分钟后再试',
    busy: '现在问的人太多，请稍后再试',
    tooLong: '问题太长了，最多 200 字',
    quota: '今天的额度用完了，明天再来',
    fail: '没能拿到回答，请稍后再试',
    send: '发送',
    stop: '停止',
    site: { space: '主站', blog: '博客', curio: '奇趣', daymark: '日刻' },
  },
  en: {
    empty: 'Ask a question. Answers come from this site, with sources.',
    thinking: 'Searching this site…',
    scopePublic: 'Public content only',
    scopePrivate: 'Includes private content',
    sources: 'Sources',
    unauthorized: 'Your session has expired. Unlock again to ask',
    cooldown: 'Too many questions. Try again in a minute',
    busy: 'Lots of people are asking right now. Try again shortly',
    tooLong: 'That question is too long (200 characters max)',
    quota: 'Today’s quota is used up. Come back tomorrow',
    fail: 'Couldn’t get an answer. Please try again',
    send: 'Send',
    stop: 'Stop',
    site: { space: 'Space', blog: 'Blog', curio: 'Curio', daymark: 'Daymark' },
  },
};

/** @typedef {{role: 'user'|'assistant', text: string, hits?: Array<{site?: string, title: string, subtitle?: string, url: string}>, ts: number, error?: boolean}} Msg */

/** 读本地历史（坏了 / 版本不对 = 空） @param {Storage|null} [store] @returns {Msg[]} */
export function loadHistory(store) {
  try {
    const s = store || window.localStorage;
    const j = JSON.parse(s.getItem(HISTORY_KEY) || 'null');
    if (!j || j.v !== 1 || !Array.isArray(j.msgs)) return [];
    return j.msgs.filter(function (/** @type {any} */ m) {
      return m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string';
    }).slice(-HISTORY_MAX);
  } catch (e) {
    return [];
  }
}
/** 存本地历史（只留最近 50 条；空 = 删 key） @param {Msg[]} msgs @param {Storage|null} [store] */
export function saveHistory(msgs, store) {
  try {
    const s = store || window.localStorage;
    const keep = msgs.filter(function (m) { return !m.error; }).slice(-HISTORY_MAX);
    if (!keep.length) s.removeItem(HISTORY_KEY);
    else s.setItem(HISTORY_KEY, JSON.stringify({ v: 1, msgs: keep }));
  } catch (e) {}
}
/** 发给服务端的历史：最近 6 条 {role, text}（不带来源、不带出错的） @param {Msg[]} msgs */
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
  const scope = /** @type {HTMLElement|null} */ (dlg.querySelector('[data-ai-scope]'));
  if (!list || !form || !input) return {};
  const doFetch = o.fetch || window.fetch.bind(window);
  /** @type {Msg[]} */
  let msgs = loadHistory(o.store);
  let busy = false;
  /** @type {AbortController|null} */
  let ctl = null;
  const coarse = o.coarse || function () {
    try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { return false; }
  };

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

  /** @param {Msg} m */
  function bubble(m) {
    const el = doc.createElement('div');
    el.className = 'sgx-ai-msg';
    el.setAttribute('data-role', m.role);
    if (m.error) el.setAttribute('data-state', 'error');
    const tx = doc.createElement('span');
    tx.textContent = m.text;
    el.appendChild(tx);
    if (m.hits && m.hits.length) {
      const ul = doc.createElement('ul');
      ul.className = 'sgx-ai-hits';
      ul.setAttribute('aria-label', t.sources);
      for (const h of m.hits) {
        if (!h || typeof h.url !== 'string' || !/^(\/|https:\/\/styrigx\.com\/)/.test(h.url)) continue;
        const li = doc.createElement('li');
        const a = doc.createElement('a');
        a.className = 'sgx-ai-hit';
        a.href = h.url;
        const b = doc.createElement('span');
        b.textContent = h.title || h.url;
        const s = doc.createElement('small');
        const siteName = h.site && /** @type {any} */ (t.site)[h.site];
        s.textContent = [siteName, h.subtitle].filter(Boolean).join(' · ');
        a.appendChild(b);
        if (s.textContent) a.appendChild(s);
        li.appendChild(a);
        ul.appendChild(li);
      }
      if (ul.children.length) el.appendChild(ul);
    }
    return el;
  }
  function render() {
    list.replaceChildren();
    if (!msgs.length) {
      const p = doc.createElement('p');
      p.className = 'sgx-ai-empty';
      p.textContent = t.empty;
      list.appendChild(p);
    } else {
      for (const m of msgs) list.appendChild(bubble(m));
    }
    if (clear) clear.disabled = !msgs.length || busy;
    list.scrollTop = list.scrollHeight;
  }
  function setBusy(/** @type {boolean} */ v) {
    busy = v;
    if (send) {
      send.disabled = false;
      send.toggleAttribute('data-stop', v);
      send.setAttribute('aria-label', v ? t.stop : t.send);
    }
    if (clear) clear.disabled = v || !msgs.length;
    dlg.toggleAttribute('aria-busy', v);
  }
  /** @param {string|null} s */
  function setScope(s) {
    if (scope) scope.textContent = s === 'private' ? t.scopePrivate : t.scopePublic;
  }

  async function ask(/** @type {string} */ q) {
    if (busy) return;
    q = q.trim();
    if (!q) return;
    if ([...q].length > Q_MAX) {
      msgs.push({ role: 'assistant', text: t.tooLong, ts: Date.now(), error: true });
      render();
      return;
    }
    const history = historyForServer(msgs);
    msgs.push({ role: 'user', text: q, ts: Date.now() });
    /** @type {Msg} */
    const ans = { role: 'assistant', text: '', ts: Date.now() };
    msgs.push(ans);
    setBusy(true);
    render();
    const live = /** @type {HTMLElement} */ (list.lastElementChild);
    const liveText = /** @type {HTMLElement} */ (live && live.firstChild);
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
          if (ev === 'hits' && d && Array.isArray(d.hits)) ans.hits = d.hits;
          else if (ev === 'delta' && d && typeof d.text === 'string') {
            ans.text += d.text;
            if (liveText) liveText.textContent = ans.text;
            list.scrollTop = list.scrollHeight;
          } else if (ev === 'error') failed = errKey(0, d);
        });
        if (!ans.text && !failed) failed = 'fail';
      }
    } catch (e) {
      failed = e && /** @type {any} */ (e).name === 'AbortError' ? '' : 'fail';
      if (!failed && !ans.text) msgs.pop();
    } finally {
      ctl = null;
    }
    if (failed) {
      if (ans.text) ans.text += '\n\n' + /** @type {any} */ (t)[failed];
      else { ans.text = /** @type {any} */ (t)[failed]; ans.error = true; }
    }
    setBusy(false);
    saveHistory(msgs, o.store);
    render();
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    const q = input.value;
    input.value = '';
    /* 触屏：发出去就收键盘，看回答（桌面焦点留在输入框，接着问）；空的不算发 */
    if (q.trim() && coarse()) { try { input.blur(); } catch (e2) {} }
    ask(q);
  });
  /* 回答进行中，发送按钮是停止按钮：点它中断这次回答 */
  if (send) {
    send.addEventListener('click', function (e) {
      if (!busy) return;
      e.preventDefault();
      if (ctl) ctl.abort();
    });
  }
  /* 回车发送，Shift+回车换行（输入法组字中不算）；回答进行中回车不发、也不中断 */
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (busy) return;
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });
  if (clear) {
    clear.addEventListener('click', function () {
      if (busy) return;
      msgs = [];
      saveHistory(msgs, o.store);
      render();
      try { input.focus(); } catch (e) {}
    });
  }
  /* 来源链接：先关窗口（退掉哨兵）再跳 */
  list.addEventListener('click', function (e) {
    const a = /** @type {HTMLAnchorElement|null} */ (/** @type {Element} */ (e.target).closest('a.sgx-ai-hit'));
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const href = a.href;
    const go = function () { if (o.navigate) o.navigate(href); else location.href = href; };
    if (o.close) o.close(go);
    else go();
  });
  /* 别的标签页 / 子站改了历史（同源同一份）：下次打开时重读 */
  render();
  setScope(null);
  return {
    onOpen: function () {
      if (!busy) { msgs = loadHistory(o.store); render(); }
      /* 触屏不自动聚焦（程序化聚焦会弹键盘盖住输入框）；桌面照旧 */
      if (!coarse()) { try { input.focus({ preventScroll: true }); } catch (e) {} }
    },
    ask: ask,
    abort: function () { if (ctl) ctl.abort(); },
  };
}
/* @sgx-shell:end */
