/**
 * @fileoverview 旷野 neofetch 的 Uptime 行（Gray 2026-11-09：从 2026-10-07 起算）：按北京时间（UTC+8，不分夏令时）数整天。纯函数（单测 tests/space/ui/space/uptime.test.mjs）。
 */

/** 北京时间偏移（毫秒） */
const CST = 8 * 3600 * 1000;

/**
 * 从 since（YYYY-MM-DD，北京时间当天 0 点）到 now 过了几个整天；since 写错 / 在未来 → 0
 * @param {string} since @param {number} now 毫秒时间戳 @returns {number}
 */
export function uptimeDays(since, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(since || ''));
  if (!m || !isFinite(now)) return 0;
  const start = Date.UTC(+m[1], +m[2] - 1, +m[3]) - CST;
  if (!isFinite(start)) return 0;
  return Math.max(0, Math.floor((now - start) / 86400000));
}

/** neofetch 的写法：1 day / 33 days @param {number} n */
export function uptimeText(n) {
  return n + (n === 1 ? ' day' : ' days');
}
