/**
 * 账号 Worker 的命名和配置（命名 v2：一个概念一个词，见仓库 docs / PR「账号命名 v2」）。
 *
 * v6 P4（定稿 v5.2 §十三）起旧账号会话删除：三张票（sgx-account-session / -reauth / -reset）、两个纪元、登录标记 sgx-account-signed-in、
 * 账号侧旧恢复密钥都删了；身份只由 v6 会话（core/identity-session.js / identity-stack.js）承担。
 * - 账号签名钥匙对删除（定稿 v5.3 §十二：v6 会话不签名，APP 令牌已删；旧名见 space/scripts/retired-names.json）。
 * - 账号密码 pepper SGX_ACCOUNT_PASSWORD_PEPPER（v6 唯一的密码 pepper）、救援钥匙 SGX_ACCOUNT_RESCUE_KEY：只绑在账号 Worker（Secrets Store）。
 * - 通行密钥 challenge 的用途按入口分开（CHALLENGE_PURPOSE）。
 *
 * 叶子模块：只 import lib/http.js。
 */
import { apiError } from '../lib/http.js';

/* ---------- 旧账号会话的时长（秒）：只剩旧设备行（account_device，core/devices.js）的保留期还用 ---------- */
export const TICKET_MAX_AGE = Object.freeze({
  session: 2592000,
});
/** 2026-11-09 之前签的 400 天票（旧时长，秒）：旧设备行单独退出后的保留期（core/devices.js revokeDevice） */
export const LEGACY_SESSION_MAX_AGE = 34560000;

/* ---------- Secrets Store 里的名字（wrangler.toml secrets_store_secrets，binding = secret_name；secrets.js 换成字符串） ---------- */
export const PASSWORD_PEPPER_SECRET = 'SGX_ACCOUNT_PASSWORD_PEPPER';
/** v6 P3 救援钥匙（定稿 v5.2 §九；Gray 05:21 定名、已在现有 Store 建好）：只读 get()，代码不出现 Store 写 / 删 */
export const RESCUE_KEY_SECRET = 'SGX_ACCOUNT_RESCUE_KEY';

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
