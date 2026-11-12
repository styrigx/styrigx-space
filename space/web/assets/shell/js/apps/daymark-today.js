/**
 * @fileoverview 日刻 · 今日一句（/daymark/api/today，公开只读；合并 PR3 起和主站同源，接口 Worker styrigx-daymark-core 挂在 styrigx.com/daymark/api/*）。
 *
 * 主页 [03] 日刻（layouts/index.html #w-daymark，设计稿 .qt 强调线引言，整块点进日刻）用：
 * - paintDaymark()：画进模板里的 data-dm 槽位（text / trans / by / day / body / empty）
 * - mountDaymarkToday()：先画本地缓存（同一天才用），再静默拉新；拉失败且没缓存 → 保持隐藏
 * （旧的大引号卡片结构 daymarkCardHtml / .dm-w-* 随对齐 PR-B 删除）
 *
 * 只读公开字段：{ok, day, quote|null}，quote = {text, trans, author, source}。
 * 不读、不显示任何私密内容（随手一笔 note 等）：即使响应里带了别的字段也不用。
 * 本文件在 lib/ 层：不 import shell/ 或 apps/。
 */
import { getJSON, setJSON } from '../prefs/storage.js';
import { i18nTable, pageLang } from '../i18n/i18n.js';
/** 界面文案：页面字符串表 #sgx-i18n-space（语言包化 2026-11-07；当前语言已叠在英文上） */
const tx = i18nTable('space');

export const DAYMARK_API = '/daymark/api/today';
export const DAYMARK_CACHE = 'sgx-daymark-today';

/** 上海时区的今天（YYYY-MM-DD）；日刻按上海时区换日 */
export function todayShanghai() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch (e) {
    return '';
  }
}

/**
 * 日期「Oct 21」/「10月21日」：按页面语言交给 Intl（参数 en 保留兼容，不再用来二选一）
 * @param {string} day @param {boolean} [en]
 */
export function fmtDaymarkDay(day, en) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  if (!m) return '';
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  try {
    return new Intl.DateTimeFormat(pageLang(), { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(dt);
  } catch (e) {
    return m[2] + '-' + m[3];
  }
}

/**
 * 「— 作者《出处》」/「— Author, Source」：出处外框走字符串表 dmSourceWrap（en「{s}」，zh「《{s}》」），
 * 作者与出处的连接交给 Intl.ListFormat（en「, 」，zh 直接相连）。
 * @param {{author?:string, source?:string}} quote @param {boolean} [en]
 */
export function daymarkByline(quote, en) {
  if (!quote) return '';
  const raw = quote.source ? String(quote.source).replace(/^《|》$/g, '') : '';
  const src = raw ? (tx('dmSourceWrap', { s: raw }) || raw) : '';
  const parts = [quote.author || '', src].filter(Boolean);
  let by = '';
  try { by = new Intl.ListFormat(pageLang(), { type: 'unit', style: 'short' }).format(parts); } catch (e) { by = parts.join(' '); }
  return by ? '— ' + by : '';
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
