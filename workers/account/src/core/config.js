/**
 * 账号 Worker 的命名和配置（命名 v2：一个概念一个词，见仓库 docs / PR「账号命名 v2」）。
 *
 * v6 P4（定稿 v5.2 §十三）起旧账号会话删除：三张票（sgx-account-session / -reauth / -reset）、两个纪元、登录标记 sgx-account-signed-in、
 * 账号侧旧恢复密钥都删了；身份只由 v6 会话（core/identity-session.js / identity-stack.js）承担。
 * - 账号签名钥匙对删除（定稿 v5.3 §十二：v6 会话不签名，APP 令牌已删；旧名见 space/scripts/check/retired-names.json）。
 * - 账号密码 pepper SGX_ACCOUNT_PASSWORD_PEPPER（v6 唯一的密码 pepper）、救援钥匙 SGX_ACCOUNT_RESCUE_KEY：只绑在账号 Worker（Secrets Store）。
 *
 * 叶子模块：只 import lib/http.js。
 */
import { apiError } from '../lib/http.js';

/* ---------- Secrets Store 里的名字（wrangler.toml secrets_store_secrets，binding = secret_name；secrets.js 换成字符串） ---------- */
export const PASSWORD_PEPPER_SECRET = 'SGX_ACCOUNT_PASSWORD_PEPPER';
/** v6 P3 救援钥匙（定稿 v5.2 §九；Gray 05:21 定名、已在现有 Store 建好）：只读 get()，代码不出现 Store 写 / 删 */
export const RESCUE_KEY_SECRET = 'SGX_ACCOUNT_RESCUE_KEY';

/* ---------- 通行密钥 challenge 的有效期（秒，account_challenge） ---------- */
export const CHALLENGE_TTL = 300;
/**
 * 发 challenge 的限速（报告修复 PR 10）：
 * - 单 IP（http.js ipBucket，IPv6 按 /64）每 60 秒最多发 20 个（su / sudo / self / passkey-add 四个入口共用一个计数），超了 429 cooldown；
 * - 全表未过期的 challenge 最多 500 个（防 account_challenge 被刷满），满了同样 429 cooldown。
 * 正常用一次 su / sudo 只发一个；终端连按也到不了 20。zone 规则 ratelimit-zone-web-auth-proxy-per-ip（150 / 10 s）不动，这是它下面的一层。
 */
export const CHALLENGE_IP_LIMIT = Object.freeze({ kind: 'v6-challenge-ip', max: 20, windowMs: 60 * 1000 });
export const CHALLENGE_OUTSTANDING_MAX = 500;

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
