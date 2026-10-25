/**
 * 密码输错限速（锁屏密码、账号密码共用一套规则，各域各自计数）：
 * - 单 IP（IPv6 按 /64，见 http.js ipBucket）每连错 PASSWORD_MAX_FAIL 次进入一轮冷却，冷却中一律 429 cooldown（码对也不验）。
 *   冷却按轮次递增：第 1 轮 PASSWORD_COOLDOWN_MS，之后每轮翻倍，封顶 PASSWORD_COOLDOWN_MAX_MS；
 *   轮次记在输错记录里，24 小时没有再输错或验对一次才归零
 * - 全局只减速、不封锁：本域每小时输错满 PASSWORD_GLOBAL_SLOW_AT 次后，之后每次校验先等 PASSWORD_GLOBAL_DELAY_MS，
 *   直到窗口过去。单个攻击者（哪怕不停换 IP）只能把主人拖慢，锁不住（通行密钥解锁不受影响）
 *
 * KV 键（realms.js 各域的 kv 表）：
 * - lock-password-fail:<ip> / account-password-fail:<ip>：{ count, strikes }（本轮连错次数、已冷却轮数；24 小时过期）
 * - lock-password-cooldown:<ip> / account-password-cooldown:<ip>：冷却到期时刻（毫秒）
 * - lock-password-fail-global / account-password-fail-global：{ count, windowStart }（本域每小时输错次数）
 *
 * KV 出错：inCooldown / recordFail 抛错（调用方返回 503，fail closed，不静默放行）；clearFail 尽力而为（先读、有才删）。
 */
import { ipBucket } from './http.js';
import { deleteIfPresent } from './kv-clear.js';

/** 每轮连错几次进入冷却 */
export const PASSWORD_MAX_FAIL = 5;
/** 第一轮冷却时长（毫秒），之后每轮翻倍 */
export const PASSWORD_COOLDOWN_MS = 30000;
/** 冷却上限（毫秒） */
export const PASSWORD_COOLDOWN_MAX_MS = 60 * 60 * 1000;
/** 全局减速：每小时输错满几次开始减速 */
export const PASSWORD_GLOBAL_SLOW_AT = 50;
/** 全局减速：每次校验前等多久（毫秒） */
export const PASSWORD_GLOBAL_DELAY_MS = 2000;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const STRIKE_TTL_SEC = 24 * 3600;

/**
 * 第 strikes 轮冷却的时长（strikes 从 1 开始）
 * @param {number} strikes
 */
export function cooldownMs(strikes) {
  const n = Math.max(1, strikes | 0);
  return Math.min(PASSWORD_COOLDOWN_MAX_MS, PASSWORD_COOLDOWN_MS * Math.pow(2, Math.min(n - 1, 20)));
}

/** 输错记录：兼容旧值（纯数字 = 本轮连错次数） @param {string|null} v */
function parseFail(v) {
  if (!v) return { count: 0, strikes: 0 };
  let o = null;
  try { o = JSON.parse(v); } catch (e) {}
  if (typeof o === 'number') return { count: o || 0, strikes: 0 };
  if (o && typeof o === 'object') return { count: Number(o.count) || 0, strikes: Number(o.strikes) || 0 };
  return { count: 0, strikes: 0 };
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/**
 * @param {any} kv
 * @param {{kv:{passwordFailPrefix:string, passwordCooldownPrefix:string, passwordFailGlobal:string}}} realm REALM_LOCK | REALM_ACCOUNT
 * @param {string} ip
 * @param {{sleep?:(ms:number)=>Promise<void>}} [opts] 测试可替换 sleep
 */
export function passwordLimiter(kv, realm, ip, opts) {
  const bucket = ipBucket(ip);
  const failKey = realm.kv.passwordFailPrefix + bucket;
  const cooldownKey = realm.kv.passwordCooldownPrefix + bucket;
  const globalKey = realm.kv.passwordFailGlobal;
  const wait = (opts && opts.sleep) || sleep;
  return {
    /** 是否在冷却中；不在冷却且全局减速时先等再返回 @returns {Promise<boolean>} */
    async inCooldown() {
      let g = null;
      try {
        const v = await kv.get(cooldownKey);
        if (v && Number(v) > Date.now()) return true;
        if (v) await kv.delete(cooldownKey);
        g = await kv.get(globalKey, 'json');
      } catch (e) {
        throw new Error('kv-error');
      }
      if (g && g.windowStart + GLOBAL_WINDOW_MS >= Date.now() && (g.count || 0) >= PASSWORD_GLOBAL_SLOW_AT) {
        await wait(PASSWORD_GLOBAL_DELAY_MS);
      }
      return false;
    },
    /** 记一次输错 @returns {Promise<boolean>} 是否刚进入冷却 */
    async recordFail() {
      const now = Date.now();
      let cooled = false;
      try {
        const rec = parseFail(await kv.get(failKey));
        rec.count++;
        if (rec.count >= PASSWORD_MAX_FAIL) {
          rec.count = 0;
          rec.strikes++;
          const ms = cooldownMs(rec.strikes);
          await kv.put(cooldownKey, String(now + ms), { expirationTtl: Math.ceil(ms / 1000) + 60 });
          cooled = true;
        }
        await kv.put(failKey, JSON.stringify(rec), { expirationTtl: STRIKE_TTL_SEC });
        const g = (await kv.get(globalKey, 'json')) || { count: 0, windowStart: now };
        if (!(g.windowStart + GLOBAL_WINDOW_MS >= now)) {
          g.count = 0;
          g.windowStart = now;
        }
        await kv.put(globalKey, JSON.stringify({ count: (g.count || 0) + 1, windowStart: g.windowStart }), { expirationTtl: 7200 });
      } catch (e) {
        throw new Error('kv-error');
      }
      return cooled;
    },
    /** 验对后清计数（含冷却轮数）。先读、有才删（kv-clear.js）：成功前没输错过就不花删除额度 */
    async clearFail() {
      try {
        await deleteIfPresent(kv, failKey);
        await deleteIfPresent(kv, cooldownKey);
      } catch (e) {}
    },
  };
}
