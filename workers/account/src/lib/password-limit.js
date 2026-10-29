/**
 * 密码输错限速（锁屏密码、账号密码共用一套规则，各域各自计数）：
 * - 单 IP（IPv6 按 /64，见 http.js ipBucket）每连错 PASSWORD_MAX_FAIL 次进入一轮冷却，冷却中一律 429 cooldown（码对也不验）。
 *   冷却按轮次递增：第 1 轮 PASSWORD_COOLDOWN_MS，之后每轮翻倍，封顶 PASSWORD_COOLDOWN_MAX_MS；
 *   轮次记在输错记录里，24 小时没有再输错或验对一次才归零
 * - 全局只减速、不封锁：本域每小时输错满 PASSWORD_GLOBAL_SLOW_AT 次后，之后每次校验先等 PASSWORD_GLOBAL_DELAY_MS，
 *   直到窗口过去。单个攻击者（哪怕不停换 IP）只能把主人拖慢，锁不住（通行密钥解锁不受影响）
 *
 * 存储：D1 attempt_limit 表（attempt-limit.js；2026-10-27 从 KV 搬来），realm = 'lock' | 'account'，kind = 'password'：
 * - bucket = IP 分桶：count（本轮连错）、strikes（已冷却轮数）、locked_until（冷却到期，以前的 *-password-cooldown:<ip>）；
 *   expires_at = 最后一次输错 + 24 小时（以前的 24 小时 TTL）
 * - bucket = '*'：本域每小时输错次数（count + window_start）
 * 记失败是一条原子 UPSERT：冷却时长按新的轮数在 SQL 里查表（COOLDOWN_TABLE），不读-改-写。
 *
 * 出错：inCooldown / recordFail 抛错（调用方返回 503，fail closed，不静默放行）；clearFail 尽力而为。
 */
import { ipBucket } from './http.js';
import { readAttempt, globalHot, recordAttempt, recordGlobal, clearAttempt } from './attempt-limit.js';

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
const STRIKE_TTL_MS = 24 * 3600 * 1000;

/**
 * 第 strikes 轮冷却的时长（strikes 从 1 开始）
 * @param {number} strikes
 */
export function cooldownMs(strikes) {
  const n = Math.max(1, strikes | 0);
  return Math.min(PASSWORD_COOLDOWN_MAX_MS, PASSWORD_COOLDOWN_MS * Math.pow(2, Math.min(n - 1, 20)));
}

/** 第 1、2、… 轮的冷却时长（到封顶为止；之后都取封顶），给 attempt-limit.js 在 SQL 里查表 */
export const COOLDOWN_TABLE = Object.freeze((function () {
  const t = [];
  for (let n = 1; ; n++) {
    t.push(cooldownMs(n));
    if (cooldownMs(n) >= PASSWORD_COOLDOWN_MAX_MS) return t;
  }
})());

const KIND = 'password';

/** @param {number} ms */
function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/**
 * @param {any} env 网关 env（D1_LOCK_AUTH / D1_ACCOUNT_AUTH）
 * @param {{id:string, d1Binding:string}} realm 域描述对象（网关：REALM_LOCK | REALM_ACCOUNT），原样交给 attempt-limit.js
 * @param {string} ip
 * @param {{sleep?:(ms:number)=>Promise<void>}} [opts] 测试可替换 sleep
 */
export function passwordLimiter(env, realm, ip, opts) {
  const bucket = ipBucket(ip);
  const wait = (opts && opts.sleep) || sleep;
  return {
    /** 是否在冷却中；不在冷却且全局减速时先等再返回 @returns {Promise<boolean>} */
    async inCooldown() {
      let hot = false;
      try {
        const rec = await readAttempt(env, realm, KIND, bucket);
        if (rec && rec.lockedUntil > Date.now()) return true;
        hot = await globalHot(env, realm, KIND, GLOBAL_WINDOW_MS, PASSWORD_GLOBAL_SLOW_AT);
      } catch (e) {
        throw new Error('d1-error');
      }
      if (hot) await wait(PASSWORD_GLOBAL_DELAY_MS);
      return false;
    },
    /** 记一次输错（原子） @returns {Promise<boolean>} 是否刚进入冷却 */
    async recordFail() {
      let cooled = false;
      try {
        cooled = await recordAttempt(env, realm, KIND, bucket, { max: PASSWORD_MAX_FAIL, ttlMs: STRIKE_TTL_MS, lockTable: COOLDOWN_TABLE });
        await recordGlobal(env, realm, KIND, GLOBAL_WINDOW_MS);
      } catch (e) {
        throw new Error('d1-error');
      }
      return cooled;
    },
    /** 验对后清计数（含冷却轮数）。尽力而为 */
    async clearFail() {
      try { await clearAttempt(env, realm, KIND, bucket); } catch (e) {}
    },
  };
}
