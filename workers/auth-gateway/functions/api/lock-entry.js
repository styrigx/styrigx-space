/**
 * 锁屏入口配置：锁屏上该显示哪些入口（补充定稿七.1，复审 §2 修正）。
 *
 * GET /api/lock-entry → { ok:true, passkey:bool, password:bool,
 *   accountConfigured:bool, resetOnly:bool }
 * - 无需鉴权（锁屏页无会话时调用）。
 * - 只返回「是否已设置」，不返回任何敏感数据。
 * - 口径统一：用 _kernel/layers.js 的 isLockEffectivelyConfigured（由 D1 里的真实凭证推出）。
 *   锁屏凭证存在、或账号已配置、或任何读取失败，都算已配置（passkey/password 均为 true），
 *   避免失败时暴露根凭证入口（fail closed）。锁屏凭证删光但账号已配置时同样不显示根凭证入口（resetOnly）。
 * - passkey / password 读 D1（强一致）：刚注册的通行密钥下一个请求就显示入口，删掉的就不显示。
 * - A-2：accountConfigured（账号层是否有效配置）、
 *   resetOnly（锁屏真实凭证为 0 且账号已配置 →
 *   锁屏只显示访客 + 重置锁屏，不显示根凭证入口）。
 */
import { isLockEffectivelyConfigured, isAccountEffectivelyConfigured } from '../_kernel/layers.js';
import { hasPasskey, PASSKEY_LOCK } from '../_kernel/passkey-store.js';
import { hasPassword } from '../_kernel/password.js';
import { REALM_LOCK, REALM_ACCOUNT } from '../_kernel/realms.js';
import { json } from '../_kernel/http.js';

/**
 * @param {any} context
 */
export async function onRequestGet(context) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const env = context.env;
    const stores = !!(env && env[REALM_LOCK.d1Binding] && env[REALM_ACCOUNT.d1Binding]); /* D1_LOCK_AUTH / D1_ACCOUNT_AUTH */
    /* 口径统一：真实凭证存在、或读取失败，都算已配置 */
    let effective = true;
    if (stores) {
      try {
        effective = await isLockEffectivelyConfigured(env);
      } catch (e) {
        effective = true;
      }
    }
    /* A-2：账号层是否有效配置（fail closed：读取失败按已配置） */
    let accountConfigured = true;
    if (stores) {
      try {
        accountConfigured = await isAccountEffectivelyConfigured(env);
      } catch (e) {
        accountConfigured = true;
      }
    }
    if (!effective) {
      /* 确定未配置：显示根凭证入口（A 启动流程保留；resetOnly 不置，
         否则账号已配置、锁屏从未配置的站会丢根凭证代开入口） */
      return json(200, { ok: true, passkey: false, password: false, accountConfigured: accountConfigured, resetOnly: false }, headers);
    }
    /* 已配置：返回 granular 状态（默认 true，确认不存在才设 false）。
       锁屏凭证为 0 但账号已配置时 granular 全否 → 仍按已配置处理，不暴露根凭证入口。 */
    let password = true;
    let passkey = true;
    let failed = false;
    if (stores) {
      try {
        password = await hasPassword(env, REALM_LOCK);
      } catch (e) {
        failed = true;
      }
      try {
        passkey = await hasPasskey(env, PASSKEY_LOCK);
      } catch (e) {
        failed = true;
      }
      if (failed) {
        password = true;
        passkey = true;
      }
    }
    /* effective 为真但 granular 全否（锁屏凭证删光、账号已配置）→ 不暴露根凭证入口。
       「锁屏凭证已删光」按真实凭证数判断（无 lock 密码且无 lock 通行密钥）：
       账号已配置时 resetOnly（锁屏只显示访客 + 重置锁屏）。 */
    let resetOnly = false;
    if (!password && !passkey) {
      resetOnly = accountConfigured && !failed;
      password = true;
      passkey = true;
    }
    return json(200, { ok: true, passkey: passkey, password: password, accountConfigured: accountConfigured, resetOnly: resetOnly }, headers);
  } catch (e) {
    /* 外层兜底：同样按已配置处理 */
    return json(200, { ok: true, passkey: true, password: true, accountConfigured: true, resetOnly: false }, headers);
  }
}
