/**
 * 锁屏入口配置：锁屏上该显示哪些入口（补充定稿七.1，复审 §2 修正）。
 *
 * GET /api/lock-entry → { ok:true, passkey:bool, password:bool,
 *   accountConfigured:bool, resetOnly:bool }
 * - 无需鉴权（锁屏页无会话时调用）。
 * - 只返回「是否已设置」，不返回任何敏感数据。
 * - 口径统一：用 _kernel/layers.js 的 isLockEffectivelyConfigured。
 *   锁屏层已配置标记、或真实锁屏凭证存在、或任何读取失败，
 *   都算已配置（passkey/password 均为 true），避免失败时暴露根凭证入口
 *   （fail closed）。只剩标记（无真实凭证）时同样不显示根凭证入口，
 *   避免 root-auth 走假入口 401 导致锁死。
 * - A-2：accountConfigured（账号层是否有效配置）、
 *   resetOnly（锁屏真实凭证为 0 且账号已配置 →
 *   锁屏只显示访客 + 重置锁屏，不显示根凭证入口）。
 */
import { isLockEffectivelyConfigured, isAccountEffectivelyConfigured, hasPasskey } from '../_kernel/layers.js';
import { REALM_LOCK } from '../_kernel/realms.js';

/**
 * @param {any} context
 */
export async function onRequestGet(context) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const kv = context.env && context.env.KV_LOCK_DOOR;
    /* 口径统一：标记或真实凭证任一存在、或读取失败，都算已配置 */
    let effective = true;
    if (kv) {
      try {
        effective = await isLockEffectivelyConfigured(kv);
      } catch (e) {
        effective = true;
      }
    }
    /* A-2：账号层是否有效配置（fail closed：读取失败按已配置） */
    let accountConfigured = true;
    if (kv) {
      try {
        accountConfigured = await isAccountEffectivelyConfigured(kv);
      } catch (e) {
        accountConfigured = true;
      }
    }
    if (!effective) {
      /* 确定未配置：显示根凭证入口（A 启动流程保留；resetOnly 不置，
         否则账号已配置、锁屏从未配置的站会丢根凭证代开入口） */
      return Response.json(
        { ok: true, passkey: false, password: false, accountConfigured: accountConfigured, resetOnly: false },
        { headers }
      );
    }
    /* 已配置：返回 granular 状态（默认 true，确认不存在才设 false）。
       标记独有（无真实凭证）时 granular 全否 → 仍按已配置处理，不暴露根凭证入口。 */
    let password = true;
    let passkey = true;
    let failed = false;
    if (kv) {
      try {
        const pw = await kv.get(REALM_LOCK.kv.password, 'json');
        password = !!(pw && pw.hash);
      } catch (e) {
        failed = true;
      }
      try {
        passkey = await hasPasskey(kv, REALM_LOCK.kv);
      } catch (e) {
        failed = true;
      }
      if (failed) {
        password = true;
        passkey = true;
      }
    }
    /* 标记独有场景：effective 为真但 granular 全否 → 不暴露根凭证入口。
       「锁屏凭证已删光」按真实凭证数判断（无 lock 密码且无 lock 通行密钥）：
       账号已配置时 resetOnly（锁屏只显示访客 + 重置锁屏）。 */
    let resetOnly = false;
    if (!password && !passkey) {
      resetOnly = accountConfigured && !failed;
      password = true;
      passkey = true;
    }
    return Response.json(
      { ok: true, passkey: passkey, password: password, accountConfigured: accountConfigured, resetOnly: resetOnly },
      { headers }
    );
  } catch (e) {
    /* 外层兜底：同样按已配置处理 */
    return Response.json(
      { ok: true, passkey: true, password: true, accountConfigured: true, resetOnly: false },
      { headers }
    );
  }
}
