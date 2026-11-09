/**
 * 账号 Worker 的命名和配置（命名 v2：一个概念一个词，见仓库 docs / PR「账号命名 v2」）。
 *
 * - 三张票：TICKET.session（sudo root 登录，400 天）、TICKET.reauth（sudo root reauth，3 分钟，挂在某个会话上：带 deviceId）、
 *   TICKET.reset（sudo root reset，3 分钟，只用恢复密钥换，不签会话）。签名格式见 lib/ticket.js。
 * - 两个纪元：EPOCH.session 管 session 和 reauth 票（改钥匙、全部退出、reset finish 登出时 +1）；
 *   EPOCH.reset 只管 reset 票（finish 时 +1，所以一张 reset 票只能完成一次）。
 * - by：password / passkey（session、reauth）；recovery-key（reset，只会是这个值）。
 * - 签名钥匙一对：SGX_ACCOUNT_PRIVATE / SGX_ACCOUNT_PUBLIC（和锁屏的 SGX_SPACE_PRIVATE / PUBLIC 平行；三张票共用，签名串带 cookie 名，互相冒充不了）。
 * - 恢复密钥 SGX_ACCOUNT_RECOVERY_KEY、账号密码 pepper SGX_ACCOUNT_PASSWORD_PEPPER：都只绑在账号 Worker（Secrets Store）。
 * - 通行密钥 challenge 的用途按入口分开（CHALLENGE_PURPOSE）。
 *
 * 叶子模块：只 import lib/http.js。
 */
import { apiError } from '../lib/http.js';

/* ---------- by（票里记的是用哪把钥匙验的） ---------- */
export const BY_PASSWORD = 'password';
export const BY_PASSKEY = 'passkey';
export const BY_RECOVERY_KEY = 'recovery-key';

/* ---------- 纪元（account_epoch 表的两行） ---------- */
export const EPOCH = Object.freeze({ session: 'session', reset: 'reset' });

/* ---------- 票的时长（秒） ---------- */
export const TICKET_MAX_AGE = Object.freeze({
  /* 400 天（浏览器 Max-Age 上限）：不点退出就一直登录；用账号仍要先有进站会话 */
  session: 34560000,
  reauth: 180,
  reset: 180,
});

/**
 * 三张票（键就是票名）：cookie、时长、允许的 by、带不带 deviceId（device）、exp − at 是否限在时长内（span）、归哪个纪元。
 * - session  by.epoch.authAt.exp.deviceId
 * - reauth   by.epoch.iat.exp.deviceId（deviceId = 它挂着的那个会话的设备；验的时候要求同一台设备的会话有效）
 * - reset    by.epoch.iat.exp（by 只会是 recovery-key）
 */
export const TICKET = Object.freeze({
  session: Object.freeze({
    name: 'session', cookie: 'sgx-account-session', maxAge: TICKET_MAX_AGE.session,
    bys: Object.freeze([BY_PASSWORD, BY_PASSKEY]), device: true, span: false, epoch: EPOCH.session,
  }),
  reauth: Object.freeze({
    name: 'reauth', cookie: 'sgx-account-reauth', maxAge: TICKET_MAX_AGE.reauth,
    bys: Object.freeze([BY_PASSWORD, BY_PASSKEY]), device: true, span: true, epoch: EPOCH.session,
  }),
  reset: Object.freeze({
    name: 'reset', cookie: 'sgx-account-reset', maxAge: TICKET_MAX_AGE.reset,
    bys: Object.freeze([BY_RECOVERY_KEY]), device: false, span: true, epoch: EPOCH.reset,
  }),
});

/**
 * 登录标记 cookie（#327 偏离修复，2026-11-08）：值固定 '1'，不含任何秘密、不签名，**不是** HttpOnly，前端首帧读它决定先画
 * root@account:~# 还是 guest 提示符（GET /api/account 回来后校正）。只用于显示：鉴权一律只认 HttpOnly 的 sgx-account-session，
 * 服务端从不读这个 cookie。随 session 签发 / 清除（core/session.js issueSession / endSession），时长同 session。
 */
export const SIGNED_IN_MARKER = Object.freeze({ cookie: 'sgx-account-signed-in', value: '1', maxAge: TICKET_MAX_AGE.session });

/* ---------- Secrets Store 里的名字（wrangler.toml secrets_store_secrets，binding = secret_name；secrets.js 换成字符串） ---------- */
export const SIGNING_PRIVATE = 'SGX_ACCOUNT_PRIVATE';
export const SIGNING_PUBLIC = 'SGX_ACCOUNT_PUBLIC';
export const RECOVERY_KEY_SECRET = 'SGX_ACCOUNT_RECOVERY_KEY';
export const PASSWORD_PEPPER_SECRET = 'SGX_ACCOUNT_PASSWORD_PEPPER';

/* ---------- 通行密钥 challenge 的用途（account_challenge.purpose），5 分钟 ---------- */
export const CHALLENGE_PURPOSE = Object.freeze({
  session: 'session',
  reauth: 'reauth',
  keysAdd: 'keys-add',
  resetAdd: 'reset-add',
});
export const CHALLENGE_TTL = 300;

/* ---------- 密码管理器里的显示名（K2 定的，只是显示名，不碰 user.id / 凭证） ---------- */
/** 账号通行密钥的 WebAuthn user.name */
export const KEY_ACCOUNT_PASSKEY = 'AccountPasskey';
/** 账号通行密钥的 WebAuthn user.displayName（写死） */
export const PASSKEY_DISPLAY_NAME = 'Sloan Gray';

/**
 * WebAuthn 依赖方配置（SGX_RP_ID / SGX_ORIGIN），必须设置、不回落；缺失返回 null。
 * @param {any} env @returns {{rpId:string, origin:string}|null}
 */
export function rpConfig(env) {
  const rpId = env && env.SGX_RP_ID;
  const origin = env && env.SGX_ORIGIN;
  if (!rpId || !origin) return null;
  return { rpId: rpId, origin: origin };
}

/** SGX_RP_ID / SGX_ORIGIN 缺失时的统一响应（503 config） */
export function rpConfigMissing() {
  return apiError(503, 'config', { message: 'SGX_RP_ID / SGX_ORIGIN not configured' });
}
