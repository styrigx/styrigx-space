/**
 * @fileoverview B2-7 网站数字健康小组件渲染（首页卡片 + 设置 › 数字健康共用）。
 * 读 GET /api/wellbeing?d=<本机日期>，把今天各区域时长画成列表 + 总时长 + 分段条。
 * 模板先画好固定高度的骨架（3 行），这里只替换文字和宽度，不改变卡片高度。
 */
import { localDay } from './wb-track.js';

const NAMES = {
  space: ['旷野', 'Space'],
  files: ['我的文件', 'My Files'],
  browser: ['浏览器', 'Internet'],
  book: ['书籍', 'Books'],
  blog: ['博客', 'Blog'],
};
// 分段 / 图例圆点是不带字的填充：辅色 / 第三色用 *-fill（本色中间调，不用压深到 4.5:1 的文字色，免得发泥；2026-10-21）
const COLORS = {
  space: 'var(--m-primary-fill, var(--m-primary))',
  files: 'var(--m-warm)',
  browser: 'var(--sgx-tertiary-fill, var(--m-tertiary))',
  book: 'var(--m-rose)',
  blog: 'var(--m-on-surface-variant)',
};

/**
 * 秒 → 「1 小时 5 分钟」/「1 hr 5 min」；不到 1 分钟显示「不到 1 分钟」。
 * @param {number} sec
 * @param {boolean} en
 * @param {boolean} [long] 总时长用 hrs
 */
export function fmtDur(sec, en, long) {
  const m = Math.floor(sec / 60);
  if (m < 1) return en ? '<1 min' : '不到 1 分钟';
  const h = Math.floor(m / 60),
    mm = m % 60;
  if (en) {
    const hs = long ? (h === 1 ? ' hr' : ' hrs') : ' hr';
    return (h ? h + hs : '') + (h && mm ? ' ' : '') + (mm || !h ? mm + ' min' : '');
  }
  return (h ? h + ' 小时' : '') + (h && mm ? ' ' : '') + (mm || !h ? mm + ' 分钟' : '');
}

/** @param {string} s */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
}

/**
 * @param {string} k
 * @param {boolean} en
 */
function nameOf(k, en) {
  const n = /** @type {any} */ (NAMES)[k];
  return n ? n[en ? 1 : 0] : k;
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

/**
 * 把接口数据画进容器。
 * @param {HTMLElement} root 含 [data-wb=rows|total|bar|legend|scope] 的容器
 * @param {{total:number, sections:{k:string,sec:number}[], items:{k:string,t:string,sec:number}[]}} data
 * @param {boolean} en
 */
export function renderWb(root, data, en) {
  const q = (/** @type {string} */ n) => /** @type {HTMLElement|null} */ (root.querySelector('[data-wb="' + n + '"]'));
  const total = data.total || 0;
  const secs = foldSections(data.sections || []).filter((s) => s.sec >= 60);
  const items = data.items || [];
  const rows = q('rows');
  if (rows) {
    const slots = rows.querySelectorAll('[data-wb-row]');
    slots.forEach((el, i) => {
      const s = secs[i];
      const row = /** @type {HTMLElement} */ (el);
      if (!s) {
        row.style.visibility = 'hidden';
        return;
      }
      row.style.visibility = '';
      const top = items.find((it) => (s.k === 'book' ? it.k.startsWith('book:') : s.k === 'blog' ? it.k.startsWith('post:') : false));
      const label = nameOf(s.k, en) + (top && top.t ? ' · ' + top.t : '');
      row.innerHTML =
        '<span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:' + /** @type {any} */ (COLORS)[s.k] + '"></span>' +
        '<span class="font-medium truncate">' + esc(label) + '</span>' +
        '<span class="ml-auto text-m-on-surface-variant shrink-0">' + esc(fmtDur(s.sec, en)) + '</span>';
    });
  }
  const t = q('total');
  if (t) t.textContent = fmtDur(total, en, true);
  /* 设置 › 数字健康的卡片先画本机记录，拉到所有设备的数据后把范围标签换掉（2026-10-23 PR-E） */
  const scope = q('scope');
  if (scope) scope.textContent = en ? 'Today · all devices' : '今天 · 所有设备';
  const bar = q('bar');
  const shown = secs.slice(0, 5);
  if (bar) {
    bar.innerHTML = total
      ? shown.map((s) => '<span style="width:' + ((s.sec * 100) / total).toFixed(1) + '%;background:' + /** @type {any} */ (COLORS)[s.k] + '"></span>').join('')
      : '';
  }
  const legend = q('legend');
  if (legend) {
    legend.innerHTML = shown.length
      ? shown
          .map((s) => '<span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-full" style="background:' + /** @type {any} */ (COLORS)[s.k] + '"></span>' + esc(nameOf(s.k, en)) + '</span>')
          .join('')
      : '<span>' + (en ? 'Nothing recorded yet today' : '今天还没有记录') + '</span>';
  }
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
