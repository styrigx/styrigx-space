// workers/atlas-core/src/curio/api/_items-post.js
// 设备 / 游戏写操作的接口共用部分（下划线开头：不是接口）。两个接口共用这一份（奇趣重组设计稿 v1.0 第三节 PR 1：复用、不复制）：
//   - 奇趣 POST /curio/api/items（items.js）：device.* 与 game.*
//   - 游戏 POST /games/api/games（../../games/api/games.js）：只收 game.*
// 门槛（同源 + 本路由的 manage 档）、读 body、校验（_items.js parseItemOp）、执行（applyItemOp）、删条目时连 R2 照片一起删，都在这里；
// 成功后回什么（带回哪些列表）由调用方决定。
import { err } from './_lib.js';
import { readBody, guardWrite } from './_write.js';
import { ensureItemSchema, parseItemOp, applyItemOp, itemDb } from './_items.js';

const STATUS = { 'not-found': 404, mismatch: 409, limit: 409 };

/**
 * 执行一个写操作：→ { response }（出错：401 / 403 / 400 / 404 / 409 / 413 / 503）或 { id? }（成功；add 带新条目 id）。
 * kinds：这个接口收哪几种条目（op 的前缀；不在里面 → 400 bad-op，同 parseItemOp 不认识的 op）。
 * @param {any} context @param {ReadonlyArray<'device'|'game'>} kinds
 * @returns {Promise<{response: Response} | {response?: undefined, id?: number}>}
 */
export async function postItemOp(context, kinds) {
  const denied = await guardWrite(context);
  if (denied) return { response: denied };
  const { env } = context;
  /* 查关联设备（game.device_id）、删设备的跨表 batch 用 D1_DEVICES，所以两个绑定都要在（同一个库） */
  if (!env || !env.D1_DEVICES || !env.D1_GAMES) return { response: err('server', 503) };
  const { body, response } = await readBody(context.request);
  if (response) return { response };
  const kind = body && typeof body.op === 'string' ? body.op.split('.')[0] : '';
  if (kinds.indexOf(/** @type {any} */ (kind)) === -1) return { response: err('bad-op', 400) };
  const o = parseItemOp(/** @type {any} */ (kind), body);
  if ('error' in o) return { response: err(o.error, 400) };
  /* 本表用自己的绑定（device → D1_DEVICES，game → D1_GAMES）；查关联设备、删设备的跨表 batch 用 D1_DEVICES */
  const db = itemDb(env, o.kind);
  await ensureItemSchema(db);
  const r = await applyItemOp(db, o, Date.now(), env.D1_DEVICES);
  if (r.error) return { response: err(r.error, STATUS[r.error] || 400) };
  for (const key of r.removed) {
    try { if (env.R2_PHOTOS) await env.R2_PHOTOS.delete(key); } catch (e) { console.error('[curio-items] photo delete failed'); }
  }
  return r.id ? { id: r.id } : {};
}
