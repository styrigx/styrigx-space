/**
 * @fileoverview 音乐空记录清理（Janitor，音乐分层方案 v1.20 14.2 / 14.4、搬家设计稿 v1.1 第五节「空记录清理」）。
 *
 * 来由：上传窗「放弃剩下的」不删已建的空单曲 / 空专辑（可复用），「以后由 Janitor 统一清」（Gray 2026-11-20 22:35）。
 * 跑在哪：不另加 Cron、不加路由。挂在 atlas-core 每小时任务的清扫时段（curio/app.js runHourly，isSweepHour = UTC 19 点 / 北京 03 点，
 *        与照片清扫 photo-sweep.js 同一轮；status 的 "41 * * * *" 经 JOB_ATLAS 调 HourlyJob.run）。
 *
 * 空记录（只认 D1 styrigx-atlas-core 的 music_albums 一行，kind = single 或 album）同时满足：
 *   1. music_tracks 里没有一首 album_id 指着它（0 首）；
 *   2. created_at > 0（0 = 年龄不明，只报不删）且 created_at、updated_at 都早于 now − 24 小时（换封面 / 改名会刷 updated_at，正在传的不碰）；
 *   3. 没有未过期的播放令牌（music_tokens.expires_at > now）。
 * 删哪些看开关 env.MUSIC_JANITOR（wrangler.toml 不写 = 线上默认 report）：
 *   - report（缺省 / 不认识的值）：只读、只打一行日志，什么都不删；
 *   - singles：删空单曲（kind = single）。单曲删到 0 首时 track.del 本来就连记录一起删，空单曲只会是放弃上传 / 传一半失败留下的；
 *   - all：空单曲 + 空专辑（kind = album）。专辑删空是故意保留的（方案十一 第 3 条），所以空专辑要单独开 all，默认不删。
 * 只报不删：曲目行的音频不在 R2（r2_key 空，或 R2 music/ 前缀里列不到这个 key；只看建了 24 小时以上的曲目）——报数量和曲目 id，永远不删。
 *
 * 删的时候（保守）：
 *   - 每条记录一个 db.batch：DELETE 语句自己再带一遍条件 1–3 和 kind（读完到写之间有人传了歌 / 换了封面 / 在听，就删 0 行、跳过）；
 *     同一 batch 里删它的过期令牌（只在记录已删时）。
 *   - D1 提交、确实删了 1 行之后才删 R2 封面；封面 key 要在 music/ 下，且没有别的专辑 / 歌手头像引用它。R2 删失败只打日志（留残余，不回滚）。
 *   - 每轮最多删 MAX_DELETE（20）条，多的下一轮再删（日志里报 deferred）。
 *   - D1 读不到（表不在、库出错）→ 整轮不删；R2 列不到 → 只是「缺音频」那一项报不出来，不影响空记录（空记录不看 R2）。
 * 日志只写 id 和数量，不写歌名 / 歌手名。
 */
import { ensureMusicSchema } from '../curio/api/_music.js';

/** 多旧才算（毫秒）：24 小时 */
export const MIN_AGE_MS = 24 * 3600 * 1000;
/** 每轮最多删几条 */
export const MAX_DELETE = 20;
/** 开关的取值 */
export const MODES = Object.freeze(['report', 'singles', 'all']);
/** R2 里音乐对象的前缀 */
export const MUSIC_PREFIX = 'music/';

/** 开关：env.MUSIC_JANITOR → report / singles / all；没写、写错都当 report @param {Record<string, any>} [env] */
export function janitorMode(env) {
  const v = String((env && env.MUSIC_JANITOR) || '').trim().toLowerCase();
  return MODES.includes(v) ? v : 'report';
}

/** 这种模式删不删这种记录 @param {string} mode @param {string} kind */
export function deletable(mode, kind) {
  if (mode === 'all') return kind === 'single' || kind === 'album';
  if (mode === 'singles') return kind === 'single';
  return false;
}

/* 条件 1–3（?1 = 截止时间 cut，?2 = now），查和删用同一段，删的时候再核一遍 */
const EMPTY_WHERE = 'a.created_at > 0 AND a.created_at <= ?1 AND a.updated_at <= ?1'
  + ' AND NOT EXISTS (SELECT 1 FROM music_tracks t WHERE t.album_id = a.id)'
  + ' AND NOT EXISTS (SELECT 1 FROM music_tokens k WHERE k.album_id = a.id AND k.expires_at > ?2)';

/**
 * 只读：找空记录、年龄不明的空记录、缺音频的曲目。
 * @param {any} db D1_MUSIC @param {any} r2 R2_MUSIC（可缺；缺就不报缺音频） @param {number} now
 * @returns {Promise<{empty: {id:number, kind:string, cover:string}[], unknownAge: number[], missingAudio: number[] | null}>}
 */
export async function findEmptyMusic(db, r2, now) {
  await ensureMusicSchema(db);
  const cut = now - MIN_AGE_MS;
  const [e, u, t] = await db.batch([
    db.prepare(`SELECT a.id, a.kind, a.cover FROM music_albums a WHERE ${EMPTY_WHERE} ORDER BY a.id`).bind(cut, now),
    db.prepare('SELECT a.id FROM music_albums a WHERE a.created_at <= 0 AND NOT EXISTS (SELECT 1 FROM music_tracks t WHERE t.album_id = a.id) ORDER BY a.id'),
    db.prepare('SELECT id, r2_key FROM music_tracks WHERE created_at > 0 AND created_at <= ?1 ORDER BY id').bind(cut),
  ]);
  const empty = ((e && e.results) || []).map((r) => ({ id: Number(r.id), kind: r.kind === 'single' ? 'single' : 'album', cover: String(r.cover || '') }));
  const unknownAge = ((u && u.results) || []).map((r) => Number(r.id));
  /** @type {number[] | null} */
  let missingAudio = null;
  if (r2 && typeof r2.list === 'function') {
    try {
      const keys = await listKeys(r2, MUSIC_PREFIX);
      missingAudio = ((t && t.results) || []).filter((r) => !r.r2_key || !keys.has(String(r.r2_key))).map((r) => Number(r.id));
    } catch (x) {
      console.error('[music-janitor] r2 list failed, missing-audio not checked');
    }
  }
  return { empty, unknownAge, missingAudio };
}

/** R2 某前缀下的全部 key（翻页） @param {any} r2 @param {string} prefix */
async function listKeys(r2, prefix) {
  /** @type {Set<string>} */
  const keys = new Set();
  let cursor;
  do {
    const page = await r2.list({ prefix, cursor, limit: 1000 });
    for (const o of (page && page.objects) || []) keys.add(String(o.key));
    cursor = page && page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/** D1 结果里改了几行（D1 是 meta.changes） @param {any} r */
function changesOf(r) {
  return Number((r && r.meta && r.meta.changes) || 0);
}

/**
 * 删一条空记录（条件在 DELETE 里再核一遍）。删掉了 → 再删没人引用的 R2 封面。
 * @returns {Promise<'deleted'|'skipped'|'failed'>}
 */
async function dropOne(db, r2, rec, now) {
  const cut = now - MIN_AGE_MS;
  let res;
  try {
    res = await db.batch([
      db.prepare(`DELETE FROM music_albums AS a WHERE a.id = ?3 AND a.kind = ?4 AND ${EMPTY_WHERE}`).bind(cut, now, rec.id, rec.kind),
      db.prepare('DELETE FROM music_tokens WHERE album_id = ?1 AND NOT EXISTS (SELECT 1 FROM music_albums WHERE id = ?1)').bind(rec.id),
    ]);
  } catch (x) {
    console.error('[music-janitor] delete failed #' + rec.id);
    return 'failed';
  }
  if (changesOf(res && res[0]) !== 1) {
    console.log('[music-janitor] skipped #' + rec.id + ' (changed since scan)');
    return 'skipped';
  }
  console.log('[music-janitor] deleted empty ' + rec.kind + ' #' + rec.id);
  const cover = rec.cover;
  if (cover && cover.startsWith(MUSIC_PREFIX) && r2 && typeof r2.delete === 'function') {
    try {
      const ref = await db.prepare('SELECT (SELECT COUNT(*) FROM music_albums WHERE cover = ?1) + (SELECT COUNT(*) FROM music_artists WHERE avatar = ?1) AS n').bind(cover).first();
      if (ref && Number(ref.n) === 0) await r2.delete(cover);
      else console.log('[music-janitor] cover of #' + rec.id + ' still referenced, kept');
    } catch (x) {
      console.error('[music-janitor] cover delete failed #' + rec.id);
    }
  }
  return 'deleted';
}

/**
 * 一轮清理。不删的模式只读。
 * @param {Record<string, any>} env D1_MUSIC + R2_MUSIC（+ 可选 MUSIC_JANITOR）
 * @param {number} [now]
 * @param {{mode?: string}} [opts] 测试 / 手动用：覆盖开关
 */
export async function runMusicJanitor(env, now = Date.now(), opts = {}) {
  const mode = opts.mode && MODES.includes(opts.mode) ? opts.mode : janitorMode(env);
  const out = {
    ok: false, mode, emptySingles: /** @type {number[]} */ ([]), emptyAlbums: /** @type {number[]} */ ([]),
    unknownAge: /** @type {number[]} */ ([]), missingAudio: /** @type {number[] | null} */ (null),
    deleted: /** @type {number[]} */ ([]), skipped: /** @type {number[]} */ ([]), failed: /** @type {number[]} */ ([]), deferred: /** @type {number[]} */ ([]),
    reason: /** @type {string | undefined} */ (undefined),
  };
  if (!env || !env.D1_MUSIC) { out.reason = 'unbound'; return out; }
  const db = env.D1_MUSIC;
  const r2 = env.R2_MUSIC;
  let found;
  try {
    found = await findEmptyMusic(db, r2, now);
  } catch (x) {
    console.error('[music-janitor] db read failed, skip');
    out.reason = 'db';
    return out;
  }
  out.emptySingles = found.empty.filter((r) => r.kind === 'single').map((r) => r.id);
  out.emptyAlbums = found.empty.filter((r) => r.kind === 'album').map((r) => r.id);
  out.unknownAge = found.unknownAge;
  out.missingAudio = found.missingAudio;
  const todo = found.empty.filter((r) => deletable(mode, r.kind));
  for (const rec of todo.slice(0, MAX_DELETE)) {
    const st = await dropOne(db, r2, rec, now);
    out[st].push(rec.id);
  }
  out.deferred = todo.slice(MAX_DELETE).map((r) => r.id);
  out.ok = true;
  console.log('[music-janitor] mode=' + mode
    + ' empty-singles=' + out.emptySingles.length + ' empty-albums=' + out.emptyAlbums.length
    + ' deleted=' + out.deleted.length + (out.skipped.length ? ' skipped=' + out.skipped.length : '')
    + (out.failed.length ? ' failed=' + out.failed.length : '') + (out.deferred.length ? ' deferred=' + out.deferred.length : '')
    + (out.unknownAge.length ? ' unknown-age=' + out.unknownAge.length : '')
    + ' missing-audio=' + (out.missingAudio === null ? 'unchecked' : out.missingAudio.length)
    + (mode === 'report' && found.empty.length ? ' ids=' + found.empty.map((r) => r.kind[0] + r.id).join(',') : '')
    + (out.missingAudio && out.missingAudio.length ? ' missing-track-ids=' + out.missingAudio.slice(0, 50).join(',') : ''));
  return out;
}
