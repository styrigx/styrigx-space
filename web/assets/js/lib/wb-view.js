/**
 * @fileoverview B2-7 网站数字健康小组件渲染（首页卡片 + 设置 › 数字健康共用）。
 * 读 GET /api/wellbeing?d=<本机日期>，把今天各区域时长画成列表 + 总时长 + 分段条。
 * 模板先画好固定高度的骨架（3 行），这里只替换文字和宽度，不改变卡片高度。
 */
import { localDay } from './wb-track.js';

const NAMES = {
  home: ['主页', 'Home'],
  files: ['我的文件', 'My Files'],
  browser: ['浏览器', 'Internet'],
  settings: ['设置', 'Settings'],
  book: ['书籍', 'Books'],
  blog: ['博客', 'Blog'],
};
// 分段 / 图例圆点是不带字的填充：辅色 / 第三色用 *-fill（本色中间调，不用压深到 4.5:1 的文字色，免得发泥；2026-10-21）
const COLORS = {
  home: 'var(--m-primary)',
  files: 'var(--m-warm)',
  browser: 'var(--sgx-tertiary-fill, var(--m-tertiary))',
  settings: 'var(--sgx-secondary-fill, var(--m-secondary))',
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

/**
 * 把接口数据画进容器。
 * @param {HTMLElement} root 含 [data-wb=rows|total|bar|legend|scope] 的容器
 * @param {{total:number, sections:{k:string,sec:number}[], items:{k:string,t:string,sec:number}[]}} data
 * @param {boolean} en
 */
export function renderWb(root, data, en) {
  const q = (/** @type {string} */ n) => /** @type {HTMLElement|null} */ (root.querySelector('[data-wb="' + n + '"]'));
  const total = data.total || 0;
  const secs = (data.sections || []).filter((s) => s.sec >= 60);
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

/**
 * 拉取今天数据并渲染所有 [data-wb-root] 容器。失败时保持骨架（显示 --）。
 * @returns {Promise<void>}
 */
export async function loadWb() {
  const roots = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-wb-root]'));
  if (!roots.length) return;
  const en = (document.documentElement.lang || '').toLowerCase().startsWith('en');
  try {
    const r = await fetch('/api/wellbeing?d=' + localDay(), { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    if (!data || !data.ok) return;
    roots.forEach((root) => renderWb(root, data, en));
  } catch (e) {}
}
