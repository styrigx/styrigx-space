/**
 * @fileoverview 聊天页（/chat/）：联网检索问答。POST /api/chat（网关验锁屏会话 + 只许站长），回答按 SSE 流式显示。
 *
 * - 对话只存 sessionStorage（sgx-chat-convo，关掉标签页就没了），「新对话」清空；服务器不存。
 * - 发送：按钮；桌面（精确指针）Enter 发送、Shift+Enter 换行；手机 Enter 换行。流式中输入框禁用，按钮变「停止」（中断请求，已收到的部分保留）。
 * - 来源：回答下面一排小 chip（域名 + 标题），新标签页打开。
 * - 错误：401 → 「会话已过期」卡 + 重新解锁（同状态页：重新载入走锁屏）；403 owner_only → 「聊天仅主人可用」卡（访客：页面一开就是这张卡）；
 *   rate_limited → 「今天的免费额度用完了」；no_key → 「聊天还没配置」；400 → 对话太长；其他（upstream / 断网）→ 出错 + 重试。
 * 渲染（Markdown、来源、SSE 解析、裁剪对话）全在 lib/chat-view.js（纯函数，单测覆盖）；这里只管 DOM 和请求。
 */
import { on } from '../lib/events.js';
import { loadI18n } from '../lib/i18n.js';
import { buildPayload, createSseParser, errorInfo, esc, renderMarkdown, renderSources } from '../lib/chat-view.js';
import { followKeyboard } from '../shell/vk.js';

export const CHAT_API = '/api/chat';
export const CONVO_KEY = 'sgx-chat-convo';

/**
 * @typedef {{role:'user'|'model', text:string, sources?:Array<{title:string, uri:string}>, stopped?:boolean, err?:string}} Msg
 */

/** @returns {Msg[]} */
function loadConvo() {
  try {
    const j = JSON.parse(sessionStorage.getItem(CONVO_KEY) || 'null');
    if (j && j.v === 1 && Array.isArray(j.msgs)) return j.msgs.filter((/** @type {any} */ m) => m && (m.role === 'user' || m.role === 'model') && typeof m.text === 'string');
  } catch (e) {}
  return [];
}

/** @param {Msg[]} msgs */
function saveConvo(msgs) {
  try {
    if (msgs.length) sessionStorage.setItem(CONVO_KEY, JSON.stringify({ v: 1, msgs }));
    else sessionStorage.removeItem(CONVO_KEY);
  } catch (e) {}
}

function init() {
  const root = document.getElementById('chat-root');
  if (!root) return;
  const { t } = loadI18n('sgx-i18n-chat');
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const list = $('chat-list');
  const empty = $('chat-empty');
  const gate = $('chat-gate');
  const form = /** @type {HTMLFormElement} */ ($('chat-composer'));
  const input = /** @type {HTMLTextAreaElement} */ ($('chat-input'));
  const sendBtn = /** @type {HTMLButtonElement} */ ($('chat-send'));
  const newBtn = /** @type {HTMLButtonElement} */ ($('chat-new'));

  /** @type {Msg[]} */
  let msgs = loadConvo();
  /** @type {AbortController|null} */
  let ctl = null;
  /** 页面级的拦截（会话过期 / 访客 / 没配置）：只显示那张卡，输入框关掉 */
  /** @type {''|'auth'|'owner'} */
  let gated = '';

  const finePointer = (() => {
    try { return matchMedia('(hover: hover) and (pointer: fine)').matches; } catch (e) { return false; }
  })();

  /** 最后一条消息的底边离输入栏顶边还有多远（> 0 = 被挡住 / 在下面） */
  function overshoot() {
    const last = list.lastElementChild;
    if (!last) return 0;
    return last.getBoundingClientRect().bottom - (form.getBoundingClientRect().top - 16);
  }
  /** 用户停在最下面附近（流式时才跟着往下滚；往上翻看旧消息时不打扰） */
  function nearBottom() {
    return overshoot() < 160;
  }
  /** 把最后一条滚到输入栏正上方（内容不够一屏时不动，开头不会被顶栏盖住） */
  function toBottom() {
    const d = overshoot();
    if (d > 0) window.scrollBy(0, d);
  }

  /** @param {Msg} m @param {number} i @param {boolean} [live] 正在流的那条 */
  function msgHtml(m, i, live) {
    if (m.role === 'user') {
      return '<li class="chat-msg" data-role="user" data-i="' + i + '"><div class="chat-bubble">' + esc(m.text).replace(/\n/g, '<br>') + '</div></li>';
    }
    const body = m.text ? renderMarkdown(m.text) : (live ? '<p class="chat-typing" aria-label="' + esc(t('thinking')) + '"><span></span><span></span><span></span></p>' : '');
    const stopped = m.stopped ? '<p class="chat-note">' + esc(t('stopped')) + '</p>' : '';
    return '<li class="chat-msg" data-role="model" data-i="' + i + '"' + (live ? ' data-live="1" aria-busy="true"' : '') + '>'
      + '<div class="chat-md">' + body + '</div>' + stopped + renderSources(m.sources || [], t('sources')) + '</li>';
  }

  /** 气泡下的错误行（不进对话记录，只跟在最后一条用户消息后面） @param {string} code */
  function errHtml(code) {
    const info = errorInfo(code);
    return '<li class="chat-msg chat-err" data-role="error" data-code="' + esc(code) + '" role="alert"><p class="chat-err-txt">' + esc(t(info.key)) + '</p>'
      + (info.retry ? '<button type="button" class="chat-err-btn" data-action="retry">' + esc(t('retry')) + '</button>' : '') + '</li>';
  }

  /** @param {string} [errCode] */
  function renderAll(errCode) {
    list.innerHTML = msgs.map((m, i) => msgHtml(m, i)).join('') + (errCode ? errHtml(errCode) : '');
    syncChrome();
  }

  function syncChrome() {
    const has = msgs.length > 0;
    empty.hidden = has || !!gated;
    list.hidden = !!gated;
    newBtn.disabled = (!has && !ctl) || !!gated;
    const busy = !!ctl;
    root.setAttribute('data-busy', busy ? '1' : '0');
    input.disabled = busy || !!gated;
    sendBtn.setAttribute('data-mode', busy ? 'stop' : 'send');
    sendBtn.setAttribute('aria-label', t(busy ? 'stop' : 'send'));
    sendBtn.title = t(busy ? 'stop' : 'send');
    sendBtn.disabled = !!gated || (!busy && !input.value.trim());
  }

  /** @param {'auth'|'owner'} kind */
  function showGate(kind) {
    gated = kind;
    const title = /** @type {HTMLElement} */ (gate.querySelector('[data-c="title"]'));
    const sub = /** @type {HTMLElement} */ (gate.querySelector('[data-c="sub"]'));
    const btn = /** @type {HTMLElement} */ (gate.querySelector('[data-c="btn"]'));
    gate.setAttribute('data-kind', kind);
    title.textContent = t(kind === 'auth' ? 'errAuth' : 'ownerOnly');
    sub.textContent = t(kind === 'auth' ? 'errAuthSub' : 'ownerOnlySub');
    btn.hidden = kind !== 'auth';
    btn.textContent = t('unlock');
    gate.hidden = false;
    form.setAttribute('data-gated', '1');
    syncChrome();
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }

  /** 发送当前对话（最后一条是 user），流式接收回答 */
  async function ask() {
    const payload = buildPayload(msgs);
    if (!payload || ctl) return;
    const c = new AbortController();
    ctl = c;
    /** @type {Msg} */
    const ans = { role: 'model', text: '' };
    const idx = msgs.length;
    renderAll();
    list.insertAdjacentHTML('beforeend', msgHtml(ans, idx, true));
    toBottom();
    const liveEl = () => /** @type {HTMLElement|null} */ (list.querySelector('[data-live="1"]'));
    let raf = 0;
    const paint = () => {
      raf = 0;
      const el = liveEl();
      if (!el) return;
      const stick = nearBottom();
      el.outerHTML = msgHtml(ans, idx, true);
      if (stick) toBottom();
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };

    /** @type {string} */
    let errCode = '';
    let done = false;
    try {
      const r = await fetch(CHAT_API, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ messages: payload }),
        signal: c.signal,
      });
      const ct = r.headers.get('Content-Type') || '';
      if (!r.ok || !r.body || ct.indexOf('text/event-stream') === -1) {
        let j = null;
        try { j = await r.json(); } catch (e) {}
        const code = (j && j.error) || '';
        if (r.status === 401) errCode = 'unauthorized';
        else if (r.status === 403 && (code === 'owner_only' || code === 'role')) errCode = 'owner_only';
        else if (r.status === 429 || code === 'rate_limited') errCode = 'rate_limited';
        else if (code === 'no_key') errCode = 'no_key';
        else if (r.status === 400) errCode = 'bad_request';
        else errCode = 'upstream';
      } else {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        const parser = createSseParser((ev) => {
          if (!ev || done || errCode) return;
          if (ev.t === 'delta' && typeof ev.text === 'string') {
            ans.text += ev.text;
            schedule();
          } else if (ev.t === 'sources' && Array.isArray(ev.items)) {
            ans.sources = ev.items;
            schedule();
          } else if (ev.t === 'done') {
            done = true;
          } else if (ev.t === 'error') {
            errCode = String(ev.code || 'upstream');
          }
        });
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          parser.push(dec.decode(value, { stream: true }));
          if (done || errCode) break;
        }
        parser.push(dec.decode());
        parser.end();
        if (!done && !errCode) errCode = 'upstream';
        try { reader.cancel(); } catch (e) {}
      }
    } catch (e) {
      if (c.signal.aborted) {
        if (ans.text) ans.stopped = true;
      } else errCode = 'upstream';
    }
    if (raf) cancelAnimationFrame(raf);
    ctl = null;
    if (c.signal.aborted && !ans.text) errCode = '';
    if (errCode === 'unauthorized' || errCode === 'owner_only') {
      /* 回答作废；对话保留（重新解锁后还在） */
      renderAll();
      showGate(errCode === 'unauthorized' ? 'auth' : 'owner');
      return;
    }
    if (ans.text && (!errCode || c.signal.aborted)) {
      msgs.push(ans);
      errCode = '';
    } else if (ans.text && errCode) {
      /* 流到一半断了：已收到的留着，后面跟错误行 */
      ans.stopped = true;
      msgs.push(ans);
    }
    saveConvo(msgs);
    const stick = nearBottom();
    renderAll(errCode || undefined);
    if (stick || errCode) toBottom();
    if (finePointer) input.focus();
  }

  /** @param {string} text */
  function send(text) {
    const q = text.trim();
    if (!q || ctl || gated) return;
    msgs.push({ role: 'user', text: q.slice(0, 4000) });
    saveConvo(msgs);
    input.value = '';
    autosize();
    ask();
  }

  on(form, 'submit', (e) => {
    e.preventDefault();
    if (ctl) {
      ctl.abort();
      return;
    }
    send(input.value);
  });
  on(input, 'input', () => {
    autosize();
    syncChrome();
  });
  on(input, 'keydown', (e) => {
    const ke = /** @type {KeyboardEvent} */ (e);
    if (ke.key !== 'Enter' || ke.shiftKey || ke.isComposing || ke.keyCode === 229 || !finePointer) return;
    ke.preventDefault();
    send(input.value);
  });
  on(newBtn, 'click', () => {
    if (ctl) ctl.abort();
    msgs = [];
    saveConvo(msgs);
    renderAll();
    input.value = '';
    autosize();
    syncChrome();
    window.scrollTo(0, 0);
    if (finePointer) input.focus();
  });
  on(empty, 'click', (e) => {
    const chip = /** @type {HTMLElement} */ (e.target).closest('[data-prompt]');
    if (chip) send(chip.getAttribute('data-prompt') || chip.textContent || '');
  });
  on(list, 'click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('[data-action="retry"]');
    if (!btn) return;
    /* 重试：去掉没答完的半截回答，重新问最后一个问题 */
    while (msgs.length && msgs[msgs.length - 1].role === 'model' && msgs[msgs.length - 1].stopped) msgs.pop();
    ask();
  });
  on(gate, 'click', (e) => {
    if (/** @type {HTMLElement} */ (e.target).closest('[data-c="btn"]')) location.reload();
  });

  /* 手机：键盘弹起时输入栏跟着上移（同站内其他底部输入，shell/vk.js） */
  followKeyboard(form, /** @type {any} */ (input));

  renderAll();
  /* 访客：网关在 <html> 注入 data-sgx-role="visitor"，不用等一次请求失败 */
  if (document.documentElement.getAttribute('data-sgx-role') === 'visitor') showGate('owner');
  /* 上次停在一个没有回答的问题上（刷新 / 断网）：给一个重试 */
  else if (msgs.length && msgs[msgs.length - 1].role === 'user') renderAll('upstream');
  if (msgs.length) toBottom();
  root.removeAttribute('aria-busy');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
