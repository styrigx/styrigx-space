/**
 * @fileoverview 日刻计数（主页 [03] 日刻小字「余响 · 日期 · 拾录 N · 百味 N」用；2026-11-15 偏离收尾 P3 / R-05，设计稿 2026-11-08 tb4.html 主页 [03]）。
 *
 * 算法与日刻页同一套（assets/daymark/js/daymark.js：countBy / authorGroups / renderWindows 里的百味 groups）：
 * - 拾录 = 能看到的句子数（/daymark/api/quotes 的 quotes.length；没登录只有公开的）
 * - 百味 = 自建专题数 + 按作者自动分组的「人物」数（没写作者的不分组）
 * daymark.js 是不经打包的浏览器 IIFE，引不了这里；两处的一致性由 tests/space/ui/home/daymark-counts.test.mjs 用同一批数据对照。
 * 本文件只放纯函数，不碰 DOM。
 */

/**
 * 按 pick 取出的值计数（数组逐个算；空值不算），按次数多→少、同数按名字排。同 daymark.js countBy。
 * @param {any[]} quotes @param {(q:any) => any} pick
 * @returns {{name:string, count:number}[]}
 */
export function countBy(quotes, pick) {
  /** @type {Record<string, number>} */
  const n = {};
  (quotes || []).forEach(function (q) {
    const v = pick(q);
    (Array.isArray(v) ? v : [v]).forEach(function (x) { x = String(x || '').trim(); if (x) n[x] = (n[x] || 0) + 1; });
  });
  return Object.keys(n).sort(function (a, b) { return n[b] - n[a] || (a < b ? -1 : a > b ? 1 : 0); })
    .map(function (k) { return { name: k, count: n[k] }; });
}

/** 百味 · 人物：每位作者一组（同 daymark.js authorGroups） @param {any[]} quotes */
export function authorGroups(quotes) { return countBy(quotes, function (q) { return q && q.author; }); }

/**
 * 拾录 / 百味 两个数。
 * @param {any[]} quotes @param {any[]} collections
 * @returns {{trove:number, flavors:number}}
 */
export function daymarkCounts(quotes, collections) {
  const qs = Array.isArray(quotes) ? quotes : [];
  const cs = Array.isArray(collections) ? collections : [];
  return { trove: qs.length, flavors: cs.length + authorGroups(qs).length };
}
