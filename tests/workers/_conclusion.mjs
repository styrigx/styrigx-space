/**
 * 子站接口 Worker（curio-core / daymark-core）单测共用：网关 AuthVerifier.conclusion() 的替身（方案 2.3.2、4.6；P2-2）。
 *
 * 几种「谁」：
 * - null / ''      没进门（lock.ok=false，账号部分 no-lock）
 * - 'lock'         进门了，账号没登录（account.ok=false）——临时钥匙进门、或主人没登录账号
 * - 'owner'        进门 + 账号会话 + 全部作用域；问复验（opts.reauth）时 reauth=true
 * - 'noscope'      进门 + 账号会话，但一个作用域都没有（第 3 件取消授权后的样子）
 * - 'noreauth'     进门 + 账号会话 + 全部作用域，但没有账号复验票（问复验也回 reauth=false）
 * - 'garbage'      网关回了看不懂的东西（当没进门）
 *
 * conclusionAuth(who, { throws, calls }) → env.AUTH：conclusion(cookie, ctx, opts)；calls 数组记下每次调用的 opts（不给就不记）。
 */

/** 骨架阶段账号会话拥有的全部作用域（与 workers/account/src/core/scopes.js 一致，按字母排序） */
export const ALL_SCOPES = Object.freeze(['avatar.write', 'curio.write', 'daymark.write', 'prefs.sync', 'profile.write', 'wellbeing.write']);

/**
 * @param {string|null|undefined} who
 * @param {{reauth?: boolean}} [opts]
 */
export function conclusionFor(who, opts) {
  if (who === 'garbage') return { ok: true, junk: 1 };
  const no = (/** @type {string} */ reason) => ({ ok: false, deviceId: '', scopes: [], reauth: false, reason });
  if (!who) return { lock: { ok: false, by: '', tempkeyId: '', reason: 'no-cookie' }, account: no('no-lock') };
  const lock = { ok: true, by: who === 'lock' ? 'tempkey' : 'passkey', tempkeyId: who === 'lock' ? 'tk_1' : '', reason: 'ok' };
  if (who === 'lock') return { lock, account: no('no-cookie') };
  const scopes = who === 'noscope' ? [] : ALL_SCOPES.slice();
  const reauth = !!(opts && opts.reauth === true) && who !== 'noreauth';
  return { lock, account: { ok: true, deviceId: 'dev_A1b2C3d4', scopes, reauth, reason: 'ok' } };
}

/**
 * @param {string|null|undefined} who
 * @param {{throws?: boolean, calls?: any[]}} [o]
 */
export function conclusionAuth(who, o = {}) {
  return {
    async conclusion(cookie, ctx, opts) {
      if (o.calls) o.calls.push({ cookie, ctx, opts });
      if (o.throws) throw new Error('down');
      return conclusionFor(who, opts);
    },
  };
}
