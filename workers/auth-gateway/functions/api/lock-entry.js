/**
 * 锁屏入口配置：锁屏上该显示哪些入口。
 *
 * GET /api/lock-entry → { ok:true, passkey:bool, password:bool }
 * - 无需鉴权（锁屏页无会话时调用）。
 * - 只返回「是否已设置」，不返回任何敏感数据。
 * - 口径统一：用 _kernel/layers.js 的 isLockEffectivelyConfigured（由 D1 里锁屏自己的真实凭证推出）。
 *   锁屏凭证存在、或任何读取失败，都算已配置（passkey/password 按实际，失败时均为 true），
 *   避免失败时暴露根密钥代开入口（fail closed）。两个都为 false = 锁屏从未设置，前端显示根密钥代开入口。
 * - passkey / password 读 D1（强一致）：刚注册的通行密钥下一个请求就显示入口，删掉的就不显示。
 * - 账号拆分 PR3（方案第 2 节）：不再返回 accountConfigured / resetOnly（网关读不到账号凭证；锁屏凭证也不许删到 0）。
 */
import { hasPasskey, PASSKEY_LOCK } from '../_kernel/passkey-store.js';
import { hasPassword } from '../_kernel/lib/password.js';
import { REALM_LOCK } from '../_kernel/realms.js';
import { json } from '../_kernel/lib/http.js';

/**
 * @param {any} context
 */
export async function onRequestGet(context) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const env = context.env;
    if (!(env && env[REALM_LOCK.d1Binding])) {
      /* 没绑锁屏库：按已配置处理（fail closed） */
      return json(200, { ok: true, passkey: true, password: true }, headers);
    }
    let password = true;
    let passkey = true;
    try {
      password = await hasPassword(env, REALM_LOCK);
      passkey = await hasPasskey(env, PASSKEY_LOCK);
    } catch (e) {
      password = true;
      passkey = true;
    }
    return json(200, { ok: true, passkey: passkey, password: password }, headers);
  } catch (e) {
    /* 外层兜底：同样按已配置处理 */
    return json(200, { ok: true, passkey: true, password: true }, headers);
  }
}
