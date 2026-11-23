// workers/atlas-core/src/curio/photo-sweep.js
// 照片兜底清扫：R2 里 photos/game/ 下没有被 D1 games.cover 引用的对象删掉（奇趣重组 PR 3 起只看游戏封面；设备照片 devices.photo、电影海报 movies.poster 随两张表删了）。
// 只扫 photos/game/（SWEEP_PREFIX）：设备照片 photos/device/…、电影海报 photos/movie/… PR 3 起没人引用，但它们要先备份、等 Gray 批了再按
// docs/ops/2026-11-23-drop-devices-movies.sql 注释里的清单手动删，不能让清扫在部署后的第一轮（北京 03 点）就自动删掉。
// 正常路径（换照片、删照片、删条目）已经当场删 R2；这里只兜「当场删失败」「写了 R2 但 D1 没改成」这类残余。
// - 每天一次：挂在每小时的 Cron 上，只在 UTC 19 点（北京 03 点）那一轮跑。
// - 只删上传超过 1 小时的：上传是「先写 R2、再改 D1」，刚写进去的可能还没登记。
// - D1 读不到（表不在、库出错）就整轮不删：宁可留残余，不能误删。
// - 只碰 photos/game/；photos/device/、photos/movie/（待手动删）、icons/、imports/（导入备份）不动。
import { ensureItemSchema, KINDS } from './api/_items.js';

export const SWEEP_PREFIX = 'photos/game/';
export const SWEEP_UTC_HOUR = 19;
export const SWEEP_MIN_AGE_MS = 3600 * 1000;

/** 这一轮该不该扫 @param {number} at 毫秒 */
export function isSweepHour(at) {
  return new Date(at).getUTCHours() === SWEEP_UTC_HOUR;
}

/**
 * @param {Record<string, any>} env  D1_GAMES + R2_PHOTOS
 * @param {number} now
 * @returns {Promise<{ok:boolean, scanned:number, deleted:number, reason?:string}>}
 */
export async function sweepPhotos(env, now = Date.now()) {
  if (!env || !env.D1_GAMES || !env.R2_PHOTOS) return { ok: false, scanned: 0, deleted: 0, reason: 'unbound' };
  /** @type {Set<string>} */
  const used = new Set();
  try {
    /* 只读 games.cover（KINDS 只剩 game；表没建过先建上，不然 SQL 报错整轮不删） */
    await ensureItemSchema(env.D1_GAMES);
    const sql = Object.values(KINDS)
      .map((K) => `SELECT ${K.photo} AS k FROM ${K.table} WHERE ${K.photo} <> ''`)
      .join(' UNION ALL ');
    const r = await env.D1_GAMES.prepare(sql).all();
    for (const row of (r && r.results) || []) if (row.k) used.add(String(row.k));
  } catch (e) {
    console.error('[curio-sweep] db read failed, skip');
    return { ok: false, scanned: 0, deleted: 0, reason: 'db' };
  }
  let scanned = 0;
  /** @type {string[]} */
  const stale = [];
  let cursor;
  try {
    do {
      const page = await env.R2_PHOTOS.list({ prefix: SWEEP_PREFIX, cursor, limit: 1000 });
      for (const o of page.objects || []) {
        scanned++;
        const up = o.uploaded instanceof Date ? o.uploaded.getTime() : Number(new Date(o.uploaded));
        if (!used.has(o.key) && Number.isFinite(up) && now - up >= SWEEP_MIN_AGE_MS) stale.push(o.key);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch (e) {
    console.error('[curio-sweep] r2 list failed, skip');
    return { ok: false, scanned, deleted: 0, reason: 'r2' };
  }
  let deleted = 0;
  for (let i = 0; i < stale.length; i += 1000) {
    const chunk = stale.slice(i, i + 1000);
    try { await env.R2_PHOTOS.delete(chunk); deleted += chunk.length; } catch (e) { console.error('[curio-sweep] delete failed'); }
  }
  if (deleted) console.log('[curio-sweep] deleted ' + deleted + ' orphan photo(s)');
  return { ok: true, scanned, deleted };
}
