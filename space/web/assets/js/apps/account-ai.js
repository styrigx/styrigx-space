/**
 * @fileoverview 账号总览「AI 模型」一行（P4-2d）：登了账号才能换 AI 窗口用的模型，换模型的口子只在这里（AI 窗口里不做切换）。
 *
 * - 这一行在 #acct-main（账号总览）里，总览只在登了账号时显示，所以没登录看不到它（登录区不画这一行）。
 * - 进总览（apps/account.js 确认有账号会话后）调 initAiModelRow：GET /api/ai → { ok, default, models: [{ id, label, provider }], canChoose }
 *   （网关转 styrigx-ai GET /models；canChoose 跟账号结论头走：只有账号会话能切）。
 *   副标题 = 当前生效的模型名：canChoose 且本地选的 id 在列表里 → 它；否则服务端默认模型。
 * - 点这一行 → 行下方展开单选列表 #acct-ai-list（P4-3 §6.7：Gray 立规不做底部弹出窗口；行 aria-expanded，选项 role=radio，当前项打勾），
 *   再点一下收起，Esc 收起回到行上；canChoose=false → 不展开，只提示登录账号后才能切换；
 *   读不到列表 → 副标题「暂时读不到模型列表」，点了再试一次（读到了直接展开）。
 * - 选中即保存并收起，焦点回到行上。
 * - 选中写 localStorage sgx-ai-model（shell/ai-panel.js MODEL_KEY，AI 窗口发问时带上 body.model）并派发 sgx-settings-changed，
 *   lib/cloud-sync.js（EXTRA 收这个键）记修改时间推上云端，换设备跟着走。选的就是默认模型也照样存（以后默认换了，选过的人不跟着换）。
 * - 本地选的模型被下架：这里只按默认显示，不删本地值（KV 一时读不到落到内置列表时不误删）；真正清掉的是 AI 窗口收到 400 bad_model 时。
 * - 云同步拉下来新值 / 别的标签页改了：sgx-settings-changed / storage 事件 → 重画副标题。
 * 模型名来自 KV（Gray 写），进 innerHTML 前转义。
 */
import { MODEL_KEY } from '../shell/ai-panel.js';
import { get as sget, set as sset } from '../lib/storage.js';
import { on } from '../lib/events.js';
import { esc } from '../lib/util.js';
import { toast } from '../lib/toast.js';

export const AI_MODELS_API = '/api/ai';

/**
 * @typedef {{ id: string, label?: string, provider?: string }} AiModel
 * @typedef {{ ok?: boolean, default?: string, models: AiModel[], canChoose?: boolean }} AiModelList
 */

/**
 * GET /api/ai 的结果像不像模型列表（坏条目去掉；一条都没有 = null）。
 * @param {any} j
 * @returns {AiModelList|null}
 */
export function normalizeList(j) {
  if (!j || j.ok !== true || !Array.isArray(j.models)) return null;
  const models = j.models.filter(function (/** @type {any} */ m) { return m && typeof m.id === 'string' && m.id; });
  if (!models.length) return null;
  return { ok: true, default: typeof j.default === 'string' ? j.default : models[0].id, models: models, canChoose: j.canChoose === true };
}

/**
 * 当前生效的模型：能切且本地选的在列表里 → 它；否则默认（默认不在列表里 → 第一条）。与 styrigx-ai core/models.js pickModel 同一规则。
 * @param {AiModelList|null} list
 * @param {string|null} stored
 * @returns {AiModel|null}
 */
export function currentModel(list, stored) {
  if (!list || !list.models.length) return null;
  /** @param {any} id */
  const byId = function (id) { return list.models.find(function (m) { return m.id === id; }) || null; };
  return (list.canChoose && stored && byId(stored)) || byId(list.default) || list.models[0];
}

/** @param {AiModel} m */
export function modelName(m) {
  return (m && (m.label || m.id)) || '';
}

/** 已挂上的那一行：再调 initAiModelRow 只重新读列表 @type {null | (() => Promise<void>)} */
let reload = null;

/**
 * 进总览后调一次（重复调用只刷新列表）。
 * @param {{ t: (k: string) => string, fetch?: typeof fetch }} opts
 */
export function initAiModelRow(opts) {
  if (reload) {
    reload();
    return;
  }
  const t = opts.t;
  const doFetch = opts.fetch || window.fetch.bind(window);
  const row = document.getElementById('acct-ai-row');
  const sub = document.getElementById('acct-ai-sub');
  const box = document.getElementById('acct-ai-list');
  if (!row || !sub || !box) return;
  /** @type {AiModelList|null} */
  let list = null;
  let loading = false;
  let failed = false;

  /** @returns {boolean} */
  function isOpen() {
    return !!box && !box.hidden;
  }

  /** 收起列表；refocus = 焦点回到行上（选中 / Esc 时） @param {boolean} [refocus] */
  function collapse(refocus) {
    if (!row || !box) return;
    box.hidden = true;
    box.innerHTML = '';
    row.setAttribute('aria-expanded', 'false');
    if (refocus) row.focus();
  }

  /** 按当前列表画选项（当前项 aria-checked=true、打勾；只有它进 Tab 顺序） */
  function renderOptions() {
    if (!box || !list) return;
    const l = list;
    const cur = currentModel(l, sget(MODEL_KEY, null));
    box.innerHTML = l.models.map(function (m) {
      const tags = [];
      if (m.id === l.default) tags.push(t('aiModelDefault'));
      if (m.provider === 'workers-ai') tags.push(t('aiModelSelf'));
      else if (m.provider === 'gemini') tags.push(t('aiModelExternal'));
      const on = !!cur && m.id === cur.id;
      return '<button type="button" class="acct-ai-opt" role="radio" aria-checked="' + on + '" tabindex="' + (on ? '0' : '-1') + '" data-model="' + esc(m.id) + '">' +
        '<span class="flex-1 min-w-0"><span class="acct-ai-opt-t block font-medium truncate">' + esc(modelName(m)) + '</span>' +
        (tags.length ? '<span class="block text-xs text-m-on-surface-variant truncate">' + esc(tags.join(' · ')) + '</span>' : '') +
        '</span><span class="acct-ai-opt-ck" aria-hidden="true">' + (on ? '✓' : '') + '</span></button>';
    }).join('');
  }

  function paint() {
    if (!row || !sub) return;
    if (!list) {
      /* 读不到：行照样能点（点了再读一次），不标 aria-disabled */
      sub.textContent = failed ? t('aiModelErr') : '';
      row.removeAttribute('aria-disabled');
      if (isOpen()) collapse(false);
      return;
    }
    const cur = currentModel(list, sget(MODEL_KEY, null));
    sub.textContent = cur ? modelName(cur) : '';
    if (list.canChoose) row.removeAttribute('aria-disabled');
    else row.setAttribute('aria-disabled', 'true');
    /* 开着时（别的标签页 / 云同步改了）勾跟着走；不能切了就收起 */
    if (isOpen()) {
      if (list.canChoose) renderOptions();
      else collapse(false);
    }
  }

  function load() {
    if (loading) return Promise.resolve();
    loading = true;
    return doFetch(AI_MODELS_API, { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .then(function (j) {
        list = normalizeList(j);
        failed = !list;
      }, function () {
        list = null;
        failed = true;
      })
      .then(function () {
        loading = false;
        paint();
      });
  }

  /** 选中即保存并收起（选的就是当前项也照样存，同原来） @param {string} id */
  function pick(id) {
    if (!list || !list.models.some(function (m) { return m.id === id; })) return;
    sset(MODEL_KEY, id);
    try { window.dispatchEvent(new Event('sgx-settings-changed')); } catch (e) {}
    collapse(true);
    paint();
  }

  /** 点行：开着 → 收起；关着 → 展开（读不到先重读，不能切只提示） */
  function togglePicker() {
    if (loading) return;
    if (isOpen()) {
      collapse(false);
      return;
    }
    if (!list) {
      /* 上次读不到：再试一次，读到了就直接展开 */
      load().then(function () { if (list) togglePicker(); else toast(t('aiModelErr')); });
      return;
    }
    if (!list.canChoose) {
      toast(t('aiModelLocked'));
      return;
    }
    if (!row || !box) return;
    renderOptions();
    box.hidden = false;
    row.setAttribute('aria-expanded', 'true');
  }

  reload = load;
  on(row, 'click', togglePicker);
  on(row, 'keydown', function (e) {
    const ev = /** @type {KeyboardEvent} */ (e);
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); togglePicker(); }
    else if (ev.key === 'Escape' && isOpen()) { ev.preventDefault(); collapse(true); }
  });
  on(box, 'click', function (e) {
    const b = /** @type {HTMLElement|null} */ (e.target instanceof Element ? e.target.closest('.acct-ai-opt') : null);
    if (b) pick(b.getAttribute('data-model') || '');
  });
  /* 单选组键盘：上下（左右）键在选项间移动焦点，Home / End 到头尾，Esc 收起回到行上；Enter / 空格由按钮自己触发 click */
  on(box, 'keydown', function (e) {
    const ev = /** @type {KeyboardEvent} */ (e);
    if (!box) return;
    const opts = /** @type {HTMLElement[]} */ (Array.from(box.querySelectorAll('.acct-ai-opt')));
    const i = opts.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    let n = -1;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') n = (i + 1) % opts.length;
    else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') n = (i - 1 + opts.length) % opts.length;
    else if (ev.key === 'Home') n = 0;
    else if (ev.key === 'End') n = opts.length - 1;
    else if (ev.key === 'Escape') { ev.preventDefault(); collapse(true); return; }
    if (n < 0 || !opts[n]) return;
    ev.preventDefault();
    opts[n].focus();
  });
  window.addEventListener('sgx-settings-changed', paint);
  window.addEventListener('storage', function (e) {
    if (!e || e.key === null || e.key === MODEL_KEY) paint();
  });
  load();
}
