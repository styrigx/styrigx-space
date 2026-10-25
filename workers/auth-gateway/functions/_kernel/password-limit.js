/**
 * 密码输错限速（锁屏密码、账号密码共用一套规则，各域各自计数）：
 * 同一 IP 连错 PASSWORD_MAX_FAIL 次进入冷却 PASSWORD_COOLDOWN_MS，冷却中一律 429 cooldown（码对也不验）。
 *
 * KV 键（realms.js 各域的 kv 表）：
 * - lock-password-fail:<ip> / account-password-fail:<ip>：连错次数（1 小时过期）
 * - lock-password-cooldown:<ip> / account-password-cooldown:<ip>：冷却到期时刻（毫秒）
 *
 * KV 出错：inCooldown / recordFail 抛错（调用方返回 503，fail closed，不静默放行）；clearFail 尽力而为。
 *
 * 叶子模块：不 import 任何模块（域的 kv 表由调用方传入）。
 */

/** 连错几次进入冷却 */
export const PASSWORD_MAX_FAIL = 5;
/** 冷却时长（毫秒） */
export const PASSWORD_COOLDOWN_MS = 30000;

/**
 * @param {any} kv
 * @param {{kv:{passwordFailPrefix:string, passwordCooldownPrefix:string}}} realm REALM_LOCK | REALM_ACCOUNT
 * @param {string} ip
 */
export function passwordLimiter(kv, realm, ip) {
  const failKey = realm.kv.passwordFailPrefix + ip;
  const cooldownKey = realm.kv.passwordCooldownPrefix + ip;
  return {
    /** 是否在冷却中 @returns {Promise<boolean>} */
    async inCooldown() {
      try {
        const v = await kv.get(cooldownKey);
        if (v && Number(v) > Date.now()) return true;
        if (v) await kv.delete(cooldownKey);
      } catch (e) {
        throw new Error('kv-error');
      }
      return false;
    },
    /** 记一次输错 @returns {Promise<boolean>} 是否刚进入冷却 */
    async recordFail() {
      try {
        let n = 0;
        const v = await kv.get(failKey);
        if (v) n = Number(v) || 0;
        n++;
        await kv.put(failKey, String(n), { expirationTtl: 3600 });
        if (n >= PASSWORD_MAX_FAIL) {
          await kv.put(cooldownKey, String(Date.now() + PASSWORD_COOLDOWN_MS), { expirationTtl: 60 });
          await kv.delete(failKey);
          return true;
        }
      } catch (e) {
        throw new Error('kv-error');
      }
      return false;
    },
    /** 验对后清计数 */
    async clearFail() {
      try {
        await kv.delete(failKey);
        await kv.delete(cooldownKey);
      } catch (e) {}
    },
  };
}
