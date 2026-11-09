/**
 * 进站凭证（SpaceKey，SGX_LOCK_SPACE_KEY，v3 叫恢复钥匙）入口：比对通过后签一张锁屏短票（by=space）。
 *
 * SpaceKey 不拥有会话：只用于比对（core/space-check.js），不签名；本接口从不签进站会话。
 * 账号拆分 PR3（方案 5.2、6.2）：账号的 root-reauth / root-reset 在账号 Worker
 * （POST /api/account/reset recovery-key，比对恢复密钥 SGX_ACCOUNT_RECOVERY_KEY），两套互不相干、各自计数。
 *
 * 进站 v3 L1（SPACE-V3 §2 L1，Gray C）：恢复钥匙不再签 reauth 票——reauth 只认解锁密码 / 通行密钥，
 * 恢复钥匙只开 reset。purpose 'lock-reauth' 已删，和其它未知值一样 → 400 purpose（不比对、不计数、不签票）。
 *
 * POST /api/space-auth { key, purpose }，purpose 只有一个值（缺失 / 其它值含 'lock-reauth' → 400 purpose）：
 * - 'lock-reset'  → LockResetTicket（sgx-lock-reset）：只在锁屏未设置时可用（从零设置第一把 LockKey，
 *                   无需会话）；锁屏已设置时走 /api/lock-reset（进站凭证 + 重置开关 / 锁屏凭据），这里按假入口处理
 * 票 3 分钟、独立 cookie（见 realms.js TICKETS）。
 *
 * 锁屏已设置时的 lock-reset 假入口：写死 401 auth，与真失败逐字节相同；只计单 IP 限速（不比对，不计全局），
 * 全局减速时同样先等，不写审计。缺 Origin 仍先 403。
 *
 * - 恒定时间比较 env.SGX_LOCK_SPACE_KEY（防长度泄露）
 * - 限速：进站凭证的路径共用一套（core/space-limit.js，attempt_limit realm='lock' kind='spacekey'）：单 IP 连错 5 次锁 15 分钟；
 *   全局只减速不封锁（每小时真比对失败满 20 次后每次先等几秒），任何人都刷不出全站暂停
 * - 失败：401 auth（并计数）；超限：429
 * - 缺 SGX_LOCK_SPACE_KEY → 500 config；缺该票的签名钥匙 → 503 config
 *
 * 审计：真路径每次使用（成功/失败）在 D1 audit 表留一行（core/space-audit.js，realm='lock'，path = purpose）；
 * 假入口不写审计。写入失败则不签发（fail closed）。
 *
 * 只接受 POST；校验 Origin（缺失/解析失败 403）。
 */
import { checkSpaceCredential, sleep } from '../core/space-check.js';
import { checkSpaceLimit, recordSpaceFail } from '../core/space-limit.js';
import { writeSpaceAudit } from '../core/space-audit.js';
import { isLockEffectivelyConfigured } from '../core/lock-configured.js';
import { isSameOrigin, originDenied, json, apiError, clientIp } from '../lib/http.js';
import {
  REALM_LOCK,
  TICKETS,
  BY_SPACE,
  LOCK_RESET_TICKET,
} from '../core/realms.js';
import { issueTicket } from '../core/tickets.js';

/** purpose → 签哪张票（v3 L1：没有 'lock-reauth'，恢复钥匙不签 reauth 票） */
export const SPACE_PURPOSES = Object.freeze({
  'lock-reset': LOCK_RESET_TICKET,
});

/* 假入口与真失败的统一固定最小延迟（毫秒）：防时序区分。
   真失败路径的审计写入放在 padTo 之前，padTo 把总耗时对齐到此时长，
   使真失败与假入口的响应耗时一致（审计为单次 D1 写，通常远小于此时长）。 */
const MIN_DELAY_MS = 200;

/** @param {number} t0 起始时间戳 */
async function padTo(t0) {
  const wait = t0 + MIN_DELAY_MS - Date.now();
  if (wait > 0) {
    await new Promise(function (r) { setTimeout(r, wait); });
  }
}

/** 与真失败逐字节相同的 401 响应 */
function decoyAuth() {
  return apiError(401, 'auth');
}

/** @param {any} context */
export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return apiError(500, 'server');
  }
}

/** @param {any} context */
async function handlePost(context) {
  const { request, env } = context;
  const t0 = Date.now();
  if (request.method !== 'POST') {
    return json(405, { ok: false });
  }
  /* Origin 必须与本站同 host（CSRF 防护），缺失或解析失败一律 403 */
  if (!isSameOrigin(request)) return originDenied();

  const spaceDb = env && env[REALM_LOCK.d1Binding]; /* 进站凭证限速 / 审计：D1_LOCK_AUTH（realm='lock'） */
  const ip = clientIp(request);

  /* body 只读一次（purpose 决定签哪张票；key 在限流检查之后才比对） */
  let body = null;
  try { body = await request.json(); } catch (e) {}
  const purpose = body && typeof body.purpose === 'string' ? body.purpose : '';
  if (!Object.prototype.hasOwnProperty.call(SPACE_PURPOSES, purpose)) {
    await padTo(t0);
    return apiError(400, 'purpose');
  }
  const ticket = SPACE_PURPOSES[purpose];
  const auditPath = purpose;

  /* 锁屏是否已设置（D1 读失败按已设置处理）：只决定 lock-reset 能不能走 */
  let lockCfg = true;
  try {
    lockCfg = await isLockEffectivelyConfigured(env);
  } catch (e) {
    lockCfg = true;
  }

  /* 真路径还是假入口：lock-reset 只在锁屏未设置时走真路径（从零设置，无需会话） */
  const realPath = !lockCfg;

  if (!realPath) {
    /* ===== 锁屏已设置时的 lock-reset 假入口：写死 401，与真失败逐字节相同 =====
       不检查环境变量（缺 SGX_LOCK_SPACE_KEY 等时也返回 401，不泄露 500 config）。
       限速检查与真路径相同（D1 出错时 fail closed，全局减速时同样先等）；
       失败只计单 IP、不计全局（没有比对，不算猜测，刷这里推不动全局计数）；不写审计（不让刷接口灌满审计）。
       D1 缺失时无法限速，直接返回 401（不泄露配置状态）。 */
    if (spaceDb) {
      try {
        const lim = await checkSpaceLimit(env, ip);
        if (lim.limited) {
          return apiError(429, 'cooldown');
        }
        if (lim.delayMs) await sleep(lim.delayMs);
      } catch (e) {
        return apiError(503, 'server');
      }
      try {
        await recordSpaceFail(env, ip, { global: false });
      } catch (e) {
        return apiError(503, 'server');
      }
    }
    await padTo(t0);
    return decoyAuth();
  }

  /* ===== 真路径 =====
     缺关键配置 → 直接拒绝（fail closed）。假入口在上面已返回，这里只处理真路径，
     避免假入口因缺环境变量泄露 500 config。该票的签名钥匙缺失 → 503 config（先于比对，不浪费限流次数）。 */
  const spaceKey = (env && env[REALM_LOCK.spaceKey]) || ''; /* SGX_LOCK_SPACE_KEY */
  const conf = TICKETS[ticket];
  if (!(env && env[conf.privateKey]) || !(env && env[conf.publicKey])) {
    return apiError(503, 'config');
  }
  if (!spaceKey || !spaceDb) {
    return apiError(500, 'config');
  }

  /* 进站凭证比对（限速 / 恒定时间比较 / 失败计数 / 审计）：网关里只有一份实现（core/space-check.js） */
  const rc = await checkSpaceCredential({
    env: env,
    ip: ip,
    key: (body && typeof body.key === 'string' && body.key) || '',
    auditPath: auditPath,
    padTo: function () { return padTo(t0); },
  });
  if (!rc.ok) return rc.response;

  const headers = new Headers();
  const tErr = await issueTicket(env, headers, ticket, BY_SPACE);
  if (tErr) {
    await writeSpaceAudit(env, ip, false, { path: auditPath });
    return json(tErr.status, tErr.body);
  }
  /* 审计写入失败则不签发（fail closed） */
  if (!(await writeSpaceAudit(env, ip, true, { path: auditPath }))) {
    return apiError(503, 'server');
  }
  return json(200, { ok: true }, headers);
}
