/**
 * @fileoverview B2-7 网站数字健康渲染（主页 [04] 旷野 screen-time 小卡 + 旷野页 /wild/ screen-time 窗共用）。
 * 读 GET /api/wellbeing?d=<本机日期>，把今天各区域时长画进容器。
 * 2026-11 对齐 PR-B（设计稿 tb4.html）：终端字符条形式——容器带 data-wb-term="full"（旷野窗：区域 · 16 格字符条 · 时长 · 占比 · 最常看的一项）
 * 或 "mini"（主页小卡：前 3 个区域 · 8 格字符条 · 时长）；字符条按最多的那个区域满格缩放。
 * 旧的彩色圆点图例 + 分段条形式（旧首页大卡、旧 /wellbeing/ 页）随对齐 PR-B 删除。
 * 模板先画好固定行数的骨架，这里只替换文字，不改变高度。
 */
import { localDay } from './wb-track.js';
import { i18nTable } from './i18n.js';
/** 界面文案：页面字符串表 #sgx-i18n-space（语言包化 2026-11-07；当前语言已叠在英文上） */
const tx = i18nTable('space');


/** @param {string} s */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
}

/** 旧区域键（P4-3 PR-4b 前：主页 home、设置 settings）→ 新键 space；读旧写新，旧 Worker / 旧缓存里的分组在这里并起来 */
const LEGACY_SECTION = /** @type {Record<string, string>} */ ({ home: 'space', settings: 'space' });

/**
 * 分组按新区域键合并（同键相加，按时长从多到少）。
 * @param {{k:string,sec:number}[]} sections
 * @returns {{k:string,sec:number}[]}
 */
export function foldSections(sections) {
  /** @type {Map<string, number>} */
  const m = new Map();
  for (const s of sections || []) {
    if (!s || typeof s.k !== 'string') continue;
    const k = LEGACY_SECTION[s.k] || s.k;
    m.set(k, (m.get(k) || 0) + (Number(s.sec) || 0));
  }
  return [...m].map(([k, sec]) => ({ k, sec })).sort((a, b) => b.sec - a.sec);
}

/** 终端里的短时长：<1m / 42m / 1h 19m（各语言同一种写法，等宽对齐） @param {number} sec */
export function fmtShort(sec) {
  const m = Math.floor(Math.max(0, Number(sec) || 0) / 60);
  if (m < 1) return '<1m';
  const h = Math.floor(m / 60);
  return h ? h + 'h ' + (m % 60) + 'm' : m + 'm';
}

/**
 * 字符条：满格 n 格，按 sec / max 缩放（有时长至少 1 格），[实心, 空心]。
 * @param {number} sec @param {number} max @param {number} n
 * @returns {[string, string]}
 */
export function charBar(sec, max, n) {
  const k = max > 0 && sec > 0 ? Math.max(1, Math.min(n, Math.round((sec / max) * n))) : 0;
  return ['\u2588'.repeat(k), '\u2591'.repeat(n - k)];
}

/**
 * 终端形式的行（纯数据，单测看它）：区域键、字符条、时长、占比、最常看的一项（明细，只在账号会话时有）。
 * @param {{total:number, sections:{k:string,sec:number}[], items?:{k:string,t:string,sec:number}[]}} data
 * @param {{n?: number, limit?: number}} [o] n = 满格格数（默认 16），limit = 最多几行（默认 5）
 */
export function termRows(data, o) {
  const n = (o && o.n) || 16;
  const limit = (o && o.limit) || 5;
  const total = Number(data && data.total) || 0;
  const secs = foldSections((data && data.sections) || []).filter((s) => s.sec >= 60).slice(0, limit);
  const max = secs.length ? secs[0].sec : 0;
  const items = (data && data.items) || [];
  return secs.map((s) => {
    const top = items.find((it) => (s.k === 'book' ? it.k.startsWith('book:') : s.k === 'blog' ? it.k.startsWith('post:') : false));
    const pct = total ? Math.round((s.sec * 100) / total) : 0;
    return { k: s.k, bar: charBar(s.sec, max, n), dur: fmtShort(s.sec), pct: pct + '%', top: top && top.t ? String(top.t) : '' };
  });
}

/**
 * 终端形式画进容器（data-wb-term="full" | "mini"）：[data-wb=rows] 里的 [data-wb-row] 骨架行（不够就补、多的藏起）、[data-wb=total]、[data-wb=none]、[data-wb=scope]。
 * @param {HTMLElement} root
 * @param {{total:number, sections:{k:string,sec:number}[], items?:{k:string,t:string,sec:number}[]}} data
 * @param {{scope?: string}} [o] scope：窗口右上的范围文字（不给 = 「今天 · 所有设备」）
 */
export function renderWbTerm(root, data, o) {
  const mini = root.getAttribute('data-wb-term') === 'mini';
  const rowsEl = /** @type {HTMLElement|null} */ (root.querySelector('[data-wb="rows"]'));
  const rows = termRows(data, mini ? { n: 8, limit: 3 } : { n: 16, limit: 5 });
  if (rowsEl) {
    let slots = /** @type {HTMLElement[]} */ (Array.from(rowsEl.querySelectorAll('[data-wb-row]')));
    while (slots.length < rows.length && slots.length) {
      const c = /** @type {HTMLElement} */ (slots[0].cloneNode(false));
      rowsEl.appendChild(c);
      slots = /** @type {HTMLElement[]} */ (Array.from(rowsEl.querySelectorAll('[data-wb-row]')));
    }
    slots.forEach((row, i) => {
      const r = rows[i];
      if (!r) {
        row.style.visibility = 'hidden';
        row.innerHTML = '&nbsp;';
        /* 骨架行：主页小卡留着高度（和旁边两张卡同高、不跳版面），旷野窗里没有记录就整行收起（下面一行「今天还没有记录」） */
        if (i >= 3 || (!mini && !rows.length)) row.hidden = true;
        return;
      }
      row.hidden = false;
      row.style.visibility = '';
      const bar = '<span class="wb-cbar" aria-hidden="true"><b>' + r.bar[0] + '</b><i>' + r.bar[1] + '</i></span>';
      row.innerHTML = mini
        ? '<span class="wb-k" translate="no">' + esc(r.k) + '</span> ' + bar + ' <span class="wb-t">' + esc(r.dur) + '</span>'
        : '<span class="wb-k" translate="no">' + esc(r.k) + '</span>' + bar + '<span class="wb-t">' + esc(r.dur) + '</span><span class="wb-p">' + esc(r.pct) + '</span>' +
          (r.top ? '<span class="wb-it">' + esc(r.top) + '</span>' : '');
    });
  }
  const none = /** @type {HTMLElement|null} */ (root.querySelector('[data-wb="none"]'));
  if (none) none.hidden = rows.length > 0;
  /* 没有记录时 total 行（和它上面的分隔线）一起收起：不再「今天还没有记录」下面又来一行 total <1m（2026-11-09 细节 14） */
  root.querySelectorAll('[data-wb-totalrow]').forEach(function (el) { /** @type {HTMLElement} */ (el).hidden = !rows.length; });
  const t = root.querySelector('[data-wb="total"]');
  if (t) t.textContent = fmtShort(Number(data.total) || 0);
  const scope = root.querySelector('[data-wb="scope"]');
  if (scope) scope.textContent = (o && o.scope) || tx('wbTodayAllDevices');
}

/**
 * 把接口数据画进容器（[data-wb-root]；终端字符条形式，见 renderWbTerm）。
 * @param {HTMLElement} root
 * @param {{total:number, sections:{k:string,sec:number}[], items:{k:string,t:string,sec:number}[]}} data
 * @param {boolean} [en] 保留兼容（文案走字符串表）
 */
export function renderWb(root, data, en) {
  void en;
  renderWbTerm(root, data);
}

/** 本文档里最近一次拿到的数据（页内切换回到首页 / 设置时先用它画，不再等一次请求） @type {{d: string, ts: number, data: any}|null} */
let last = null;
/** 多久内的数据直接用、不再请求（页内来回切换不重复拉） */
const FRESH_MS = 60000;

/**
 * 拉取今天数据并渲染所有 [data-wb-root] 容器。失败时保持骨架（显示 --）。
 * 2026-10-24 页内切换：同一文档里拿到过今天的数据就先同步画上；超过 1 分钟再静默拉新覆盖。
 * @returns {Promise<void>}
 */
/**
 * 这个容器画不画这份数据：带 data-wb-detail 的（设置 › 数字健康的根卡）只在 detail:true（账号会话，P2-2）时画，
 * 否则保持本机记录；首页小组件不带，区域合计照画。
 * @param {HTMLElement} root @param {any} data
 */
export function wbFits(root, data) {
  return !root.hasAttribute('data-wb-detail') || !!(data && data.detail === true);
}

export async function loadWb() {
  const roots = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-wb-root]'));
  if (!roots.length) return;
  const en = (document.documentElement.lang || '').toLowerCase().startsWith('en');
  const day = localDay();
  if (last && last.d === day) {
    const data = last.data;
    roots.forEach((root) => { if (wbFits(root, data)) renderWb(root, data, en); });
    if (Date.now() - last.ts < FRESH_MS) return;
  }
  try {
    const r = await fetch('/api/wellbeing?d=' + day, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    if (!data || !data.ok) return;
    last = { d: day, ts: Date.now(), data };
    roots.forEach((root) => { if (root.isConnected && wbFits(root, data)) renderWb(root, data, en); });
  } catch (e) {}
}
