/**
 * @fileoverview 日刻 · 今日一句（daymark.styrigx.com/api/today，公开只读，CORS 只放 https://styrigx.com）。
 *
 * 主页小组件（layouts/index.html #w-daymark，整张卡点进日刻）与锁屏（shell/lock.js，只展示、不可点）共用：
 * - daymarkCardHtml()：卡片内部结构（与主页模板同一套 data-dm 槽位与 dm-w-* 样式）
 * - mountDaymarkToday()：先画本地缓存（同一天才用），再静默拉新；拉失败且没缓存 → 卡片保持隐藏
 *
 * 只读公开字段：{ok, day, quote|null}，quote = {text, trans, author, source}。
 * 不读、不显示任何私密内容（随手一笔 note 等）：即使响应里带了别的字段也不用。
 * 本文件在 lib/ 层：不 import shell/ 或 apps/。
 */
import { getJSON, setJSON } from './storage.js';

export const DAYMARK_API = 'https://daymark.styrigx.com/api/today';
export const DAYMARK_CACHE = 'sgx-daymark-today';

const DM_ICON = '<svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15.5" rx="2.5"/><path d="M8.5 3v4M15.5 3v4"/><path d="M10.5 11.2c-1.3.5-2 1.6-2 3.3v1.3"/><path d="M8.5 15.8h1.8v-1.9H8.6"/><path d="M15.5 11.2c-1.3.5-2 1.6-2 3.3v1.3"/><path d="M13.5 15.8h1.8v-1.9h-1.7"/></svg>';

/** 上海时区的今天（YYYY-MM-DD）；日刻按上海时区换日 */
export function todayShanghai() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch (e) {
    return '';
  }
}

/** @param {string} day @param {boolean} en */
export function fmtDaymarkDay(day, en) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  if (!m) return '';
  const mo = Number(m[2]), d = Number(m[3]);
  if (!en) return mo + '月' + d + '日';
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][mo - 1] + ' ' + d;
}

/**
 * 「— 作者《出处》」/「— Author, Source」
 * @param {{author?:string, source?:string}} quote @param {boolean} en
 */
export function daymarkByline(quote, en) {
  if (!quote) return '';
  const src = quote.source ? (en ? quote.source : '《' + String(quote.source).replace(/^《|》$/g, '') + '》') : '';
  const by = [quote.author || '', src].filter(Boolean).join(en ? ', ' : '');
  return by ? '— ' + by : '';
}

/**
 * 卡片内部 HTML（与主页模板 #w-daymark 的内部结构一致；外层元素由调用方给）。
 * @param {boolean} en
 * @param {{emptyHint?: boolean}} [opts] emptyHint=false 时空状态不写「点开日刻，记下一句」（锁屏不可点）
 */
export function daymarkCardHtml(en, opts) {
  const emptyHint = !opts || opts.emptyHint !== false;
  return '<span class="dm-w-mark" aria-hidden="true">\u201C</span>' +
    '<div class="relative flex items-center justify-between gap-3">' +
    '<p class="flex items-center gap-1.5 text-xs font-semibold tracking-widest text-m-primary">' +
    '<span class="dm-w-ic">' + DM_ICON + '</span><span>' + (en ? 'DAYMARK' : '日刻') + '</span></p>' +
    '<p class="text-[11px] text-m-on-surface-variant" data-dm="day"></p></div>' +
    '<div class="relative" data-dm="body">' +
    '<p class="dm-w-text mt-4 font-bold leading-snug" data-dm="text"></p>' +
    '<p class="dm-w-trans mt-2 text-sm text-m-on-surface-variant leading-relaxed hidden" data-dm="trans"></p>' +
    '<p class="mt-3 text-sm text-m-on-surface-variant text-right truncate" data-dm="by"></p></div>' +
    '<div class="relative hidden" data-dm="empty">' +
    '<p class="mt-4 text-lg font-bold">' + (en ? 'No line for today yet' : '今天还没有句子') + '</p>' +
    (emptyHint ? '<p class="mt-1.5 text-sm text-m-on-surface-variant">' + (en ? 'Tap to keep one in Daymark' : '点开日刻，记下一句') + '</p>' : '') +
    '</div>';
}

/**
 * 把 /api/today 的结果画进卡片（只用公开字段）。
 * @param {HTMLElement} root @param {any} d @param {boolean} en
 * @returns {boolean} 是否画上了（d 无效时 false，卡片不动）
 */
export function paintDaymark(root, d, en) {
  if (!root || !d || !d.ok) return false;
  const q = function (k) { return /** @type {HTMLElement|null} */ (root.querySelector('[data-dm="' + k + '"]')); };
  const setT = function (k, v) { const el = q(k); if (el) el.textContent = v || ''; };
  setT('day', fmtDaymarkDay(d.day, en));
  const quote = d.quote;
  const body = q('body'), empty = q('empty'), trans = q('trans');
  if (quote && quote.text) {
    setT('text', String(quote.text));
    if (trans) {
      trans.textContent = quote.trans ? String(quote.trans) : '';
      trans.classList.toggle('hidden', !quote.trans);
    }
    setT('by', daymarkByline(quote, en));
    if (body) body.classList.remove('hidden');
    if (empty) empty.classList.add('hidden');
  } else {
    if (body) body.classList.add('hidden');
    if (empty) empty.classList.remove('hidden');
  }
  root.classList.remove('hidden');
  root.hidden = false;
  return true;
}

/** 只留公开字段（缓存和渲染都用它） @param {any} d */
function publicPart(d) {
  const q = d && d.quote;
  return {
    ok: true,
    day: d.day,
    quote: q && q.text ? { text: q.text, trans: q.trans || '', author: q.author || '', source: q.source || '' } : null,
  };
}

/**
 * 挂载：先画缓存（同一天），再静默拉新。
 * @param {HTMLElement} root 卡片外层（初始隐藏）
 * @param {object} [o]
 * @param {boolean} [o.en]
 * @param {number} [o.timeoutMs] 默认 8000
 * @param {(painted: boolean) => void} [o.onSettled] 第一次有结论时调一次：缓存画上 / 拉到 / 拉失败
 * @param {() => boolean} [o.canPaintLate] 拉到时是否还允许画（锁屏：舞台已展示且之前没画过就不画，避免版面跳动）
 * @returns {() => void} 取消（之后的结果都丢弃）
 */
export function mountDaymarkToday(root, o) {
  const opts = o || {};
  const en = opts.en !== undefined ? !!opts.en : document.documentElement.lang === 'en';
  let settled = false;
  let cancelled = false;
  let painted = false;
  const settle = function (v) {
    if (settled) return;
    settled = true;
    if (opts.onSettled) {
      try { opts.onSettled(v); } catch (e) {}
    }
  };
  const cached = getJSON(DAYMARK_CACHE, null);
  if (cached && cached.ok && cached.day === todayShanghai()) {
    painted = paintDaymark(root, publicPart(cached), en);
    if (painted) settle(true);
  }
  if (typeof fetch !== 'function') {
    settle(painted);
    return function () { cancelled = true; };
  }
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(function () { ctl.abort(); }, opts.timeoutMs || 8000) : 0;
  fetch(DAYMARK_API, { credentials: 'omit', mode: 'cors', signal: ctl ? ctl.signal : undefined })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (cancelled) return;
      if (!d || !d.ok) {
        settle(painted);
        return;
      }
      const pub = publicPart(d);
      setJSON(DAYMARK_CACHE, pub);
      if (painted || !opts.canPaintLate || opts.canPaintLate()) {
        painted = paintDaymark(root, pub, en) || painted;
      }
      settle(painted);
    })
    .catch(function () { if (!cancelled) settle(painted); })
    .then(function () { clearTimeout(timer); });
  return function () {
    cancelled = true;
    try { if (ctl) ctl.abort(); } catch (e) {}
  };
}
