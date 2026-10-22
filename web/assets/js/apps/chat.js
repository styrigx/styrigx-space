/**
 * @fileoverview 聊天页（/chat/）：联网检索问答。POST /api/chat（网关验锁屏会话 + 只许站长），回答按 SSE 流式显示。
 *
 * - 对话只存 sessionStorage（sgx-chat-convo，关掉标签页就没了），「新对话」清空；服务器不存。
 * - 发送：按钮；桌面（精确指针）Enter 发送、Shift+Enter 换行；手机 Enter 换行。流式中输入框禁用，按钮变「停止」（中断请求，已收到的部分保留）。
 * - 来源：回答下面一排小 chip（域名 + 标题），新标签页打开。
 * - 错误：401 → 「会话已过期」卡 + 重新解锁（同状态页：重新载入走锁屏）；403 owner_only → 「聊天仅主人可用」卡（访客：页面一开就是这张卡）；
 *   rate_limited → 「今天的免费额度用完了」；no_key → 「聊天还没配置」；400 → 对话太长；其他（upstream / 断网）→ 出错 + 重试。
 * - 模型切换（2026-10-22）：GET /api/chat 拿白名单（{ default, models:[{id,label,search}] }），≥ 2 个才在输入栏上方显示小药丸；
 *   点了打开模型面板（模态 <dialog> #chat-ms，shell/modal-sheet.js 开合：点遮罩 / ✕ / Esc / 系统返回关闭；手机底部面板、宽屏贴着药丸）。
 *   选择存 localStorage sgx-chat-model（不在列表里了 → 默认）；POST 带 model。拿不到列表 → 药丸藏着、不带 model（服务器默认）。
 *   每条回答下面一行小字写用的模型；上游拒了搜索工具、不带工具重试的（SSE meta web:false）→「· 未联网」。
 *   这个模型额度用完（429）/ 用不了（model_unavailable）→ 错误行带「换个模型」按钮（打开面板）；bad_model（白名单改了）→ 换回默认 + 重试。
 * 渲染（Markdown、来源、SSE 解析、裁剪对话、模型列表）全在 lib/chat-view.js（纯函数，单测覆盖）；这里只管 DOM 和请求。
 */
import { on } from '../lib/events.js';
import { loadI18n } from '../lib/i18n.js';
import { buildPayload, createSseParser, errorInfo, esc, modelFootText, modelOptionsHtml, parseModels, pickModel, renderMarkdown, renderSources } from '../lib/chat-view.js';
import { followKeyboard } from '../shell/vk.js';
import { modalSheet } from '../shell/modal-sheet.js';

export const CHAT_API = '/api/chat';
export const CONVO_KEY = 'sgx-chat-convo';
/** 选的模型（只是偏好，不是会话状态；名字里不能带 session——check-layers 规则 7） */
export const MODEL_KEY = 'sgx-chat-model';
/** 模型面板滑入 / 滑出时长（与 input.css .chat-ms-sheet 的 transition 一致） */
const MS_MS = 240;

/**
 * @typedef {{role:'user'|'model', text:string, sources?:Array<{title:string, uri:string}>, stopped?:boolean, err?:string, ml?:string, nw?:boolean}} Msg
 * ml = 回答用的模型名（脚注）；nw = 这次没联网（上游拒了工具、不带工具重试）
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
  const modelBtn = /** @type {HTMLButtonElement} */ ($('chat-model'));
  const modelLbl = /** @type {HTMLElement} */ (modelBtn.querySelector('.chat-model-lbl'));
  const msDlg = /** @type {HTMLDialogElement} */ ($('chat-ms'));
  const msList = $('chat-ms-list');

  /** 模型白名单（GET /api/chat）；null = 没拿到（不显示切换、不带 model） */
  /** @type {{def:string, models:Array<{id:string, label:string, search:boolean}>}|null} */
  let models = null;
  /** 当前模型 id */
  let cur = '';
  /** 输入框占位符：联网模型「问点什么，联网查…」（模板里的）；不联网模型换成「问点什么…」 */
  const phWeb = input.getAttribute('placeholder') || '';
  const canPick = () => !!models && models.models.length >= 2;
  const curModel = () => (models ? models.models.find((m) => m.id === cur) || null : null);

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
    const ft = modelFootText(m.ml, m.nw, t('noWebUsed'));
    const foot = ft ? '<p class="chat-foot"' + (m.nw ? ' data-noweb="1"' : '') + '>' + esc(ft) + '</p>' : '';
    return '<li class="chat-msg" data-role="model" data-i="' + i + '"' + (live ? ' data-live="1" aria-busy="true"' : '') + '>'
      + '<div class="chat-md">' + body + '</div>' + stopped + renderSources(m.sources || [], t('sources')) + foot + '</li>';
  }

  /** 气泡下的错误行（不进对话记录，只跟在最后一条用户消息后面） @param {string} code */
  function errHtml(code) {
    const info = errorInfo(code, canPick());
    return '<li class="chat-msg chat-err" data-role="error" data-code="' + esc(code) + '" role="alert"><p class="chat-err-txt">' + esc(t(info.key)) + '</p>'
      + (info.pick ? '<button type="button" class="chat-err-btn" data-action="pick" aria-haspopup="listbox">' + esc(t('pickModel')) + '</button>' : '')
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
    modelBtn.hidden = !canPick() || !!gated;
    modelBtn.disabled = busy;
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
    const mm = curModel();
    if (mm) ans.ml = mm.label;
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
        body: JSON.stringify(mm ? { messages: payload, model: mm.id } : { messages: payload }),
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
        else if (code === 'model_unavailable') errCode = 'model_unavailable';
        else if (code === 'bad_model') errCode = 'bad_model';
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
          } else if (ev.t === 'meta') {
            if (ev.web === false) { ans.nw = true; schedule(); }
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
    /* 白名单改了（选的模型下线）：换回默认，重试就用默认 */
    if (errCode === 'bad_model' && models) setModel(models.def);
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
    if (/** @type {HTMLElement} */ (e.target).closest('[data-action="pick"]')) {
      openModels();
      return;
    }
    const btn = /** @type {HTMLElement} */ (e.target).closest('[data-action="retry"]');
    if (!btn) return;
    /* 重试：去掉没答完的半截回答，重新问最后一个问题 */
    while (msgs.length && msgs[msgs.length - 1].role === 'model' && msgs[msgs.length - 1].stopped) msgs.pop();
    ask();
  });
  on(gate, 'click', (e) => {
    if (/** @type {HTMLElement} */ (e.target).closest('[data-c="btn"]')) location.reload();
  });

  /* ---- 模型切换 ---- */
  /** @param {string} id */
  function setModel(id) {
    cur = id;
    const m = curModel();
    modelLbl.textContent = m ? m.label : '';
    modelBtn.setAttribute('aria-label', t('model') + '：' + (m ? m.label : '') + (m && m.search ? '（' + t('web') + '）' : ''));
    input.setAttribute('placeholder', m && !m.search ? t('phNoWeb') : phWeb);
    try {
      if (models && id === models.def) localStorage.removeItem(MODEL_KEY);
      else localStorage.setItem(MODEL_KEY, id);
    } catch (e) {}
  }
  const ms = modalSheet(msDlg, modelBtn, {
    ms: MS_MS,
    stateKey: 'sgxChatModel',
    onOpen: () => {
      if (!models) return;
      msList.innerHTML = modelOptionsHtml(models.models, cur, { web: t('web'), noWeb: t('noWeb') });
      /* 宽屏：浮层贴在药丸上方、左边对齐（手机是底部面板，CSS 不看这两个变量） */
      const r = modelBtn.getBoundingClientRect();
      msDlg.style.setProperty('--chat-ms-left', Math.max(8, Math.round(r.left)) + 'px');
      msDlg.style.setProperty('--chat-ms-bottom', Math.round(window.innerHeight - r.top + 8) + 'px');
      const sel = /** @type {HTMLElement|null} */ (msList.querySelector('[aria-selected="true"]') || msList.firstElementChild);
      if (sel) sel.focus();
    },
    onClosed: () => {
      if (!modelBtn.hidden) modelBtn.focus();
    },
  });
  function openModels() {
    if (!canPick() || ctl || gated) return;
    ms.open();
  }
  /** @param {HTMLElement} opt */
  function choose(opt) {
    const id = opt.getAttribute('data-id') || '';
    if (models && models.models.some((m) => m.id === id)) setModel(id);
    ms.close();
  }
  on(modelBtn, 'click', (e) => {
    e.stopPropagation();
    if (ms.isOpen()) ms.close();
    else openModels();
  });
  on(msDlg, 'click', (e) => {
    const el = /** @type {HTMLElement} */ (e.target);
    if (el.closest('[data-ms-close]')) { ms.close(); return; }
    const opt = /** @type {HTMLElement|null} */ (el.closest('.chat-ms-opt'));
    if (opt) { choose(opt); return; }
    /* 点遮罩（面板以外）关闭 */
    if (!el.closest('.chat-ms-sheet')) ms.close();
  });
  on(msList, 'keydown', (e) => {
    const ke = /** @type {KeyboardEvent} */ (e);
    const opts = /** @type {HTMLElement[]} */ (Array.from(msList.querySelectorAll('.chat-ms-opt')));
    const i = opts.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    let n = -1;
    if (ke.key === 'ArrowDown') n = Math.min(opts.length - 1, i + 1);
    else if (ke.key === 'ArrowUp') n = Math.max(0, i - 1);
    else if (ke.key === 'Home') n = 0;
    else if (ke.key === 'End') n = opts.length - 1;
    else if ((ke.key === 'Enter' || ke.key === ' ') && i >= 0) {
      ke.preventDefault();
      choose(opts[i]);
      return;
    } else return;
    ke.preventDefault();
    if (opts[n]) opts[n].focus();
  });

  /** 拿模型列表；失败 / 形状不对 → 不显示切换，用服务器默认 */
  async function loadModels() {
    try {
      const r = await fetch(CHAT_API, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!r.ok) return;
      const got = parseModels(await r.json());
      if (!got) return;
      models = got;
      let stored = null;
      try { stored = localStorage.getItem(MODEL_KEY); } catch (e) {}
      setModel(pickModel(got, stored));
      syncChrome();
      /* 错误行（比如上次停在没答的问题上）要按新的 canPick 重画「换个模型」按钮 */
      const er = /** @type {HTMLElement|null} */ (list.querySelector('.chat-err'));
      if (er && !ctl) renderAll(er.getAttribute('data-code') || undefined);
    } catch (e) {}
  }

  /* 手机：键盘弹起时输入栏跟着上移（同站内其他底部输入，shell/vk.js） */
  followKeyboard(form, /** @type {any} */ (input));

  renderAll();
  /* 访客：网关在 <html> 注入 data-sgx-role="visitor"，不用等一次请求失败 */
  if (document.documentElement.getAttribute('data-sgx-role') === 'visitor') showGate('owner');
  /* 上次停在一个没有回答的问题上（刷新 / 断网）：给一个重试 */
  else if (msgs.length && msgs[msgs.length - 1].role === 'user') renderAll('upstream');
  if (msgs.length) toBottom();
  if (!gated) loadModels();
  root.removeAttribute('aria-busy');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
