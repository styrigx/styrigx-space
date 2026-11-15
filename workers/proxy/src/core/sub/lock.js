/**
 * 刷新锁（lock 单行）：条件 UPDATE 抢锁，60 秒过期；释放只放自己的。
 */
import { db } from './store.js';
import { LOCK_MS } from './config.js';

/** @param {any} env @param {string} owner @param {number} now @returns {Promise<boolean>} */
export async function acquire(env, owner, now) {
  const r = await db(env).prepare('UPDATE lock SET owner = ?, expires = ? WHERE id = 1 AND expires < ?').bind(owner, now + LOCK_MS, now).run();
  return Number(r.meta && r.meta.changes) > 0;
}

/** @param {any} env @param {string} owner */
export async function release(env, owner) {
  await db(env).prepare('UPDATE lock SET expires = 0 WHERE id = 1 AND owner = ?').bind(owner).run();
}

/** 正在刷新？ @param {any} env @param {number} now */
export async function busy(env, now) {
  const r = await db(env).prepare('SELECT expires FROM lock WHERE id = 1').first();
  return !!(r && Number(r.expires) > now);
}
