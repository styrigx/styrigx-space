/**
 * passkey-e2e 预览的组合入口（只给 CI 和本地模拟器用，绝不部署成正式 Worker；账号拆分 PR3）。
 *
 * 正式环境是两个 Worker：网关 styrigx-auth-gateway 经服务绑定 ACCOUNT（AccountService）/ ACCOUNT_VERIFIER（AccountVerifier）
 * 调账号 Worker styrigx-account。预览只有一个 Pages 项目（passkey-e2e.styrigx-space.pages.dev），它的 _worker.js 只能是一个脚本，
 * 所以这里把两边仓库里的真实代码装进同一个脚本：
 * - 网关那一半 = workers/auth-gateway/src/index.js 的 default.fetch（剥头、门、转发表、锁屏接口全是正式代码）；
 * - 账号那一半 = workers/account/src/entrypoints.js 的 serviceFetch（AccountService.fetch 的实现）和 checkAccountSession
 *   （AccountVerifier.accountSession 的实现），包成和服务绑定同形状的进程内适配器，挂到网关 env 的 ACCOUNT / ACCOUNT_VERIFIER 上。
 *
 * env 按正式的绑定拆开，两半互相看不到对方的钥匙和库（预览也验证「网关不碰账号钥匙」）：
 * - 网关：去掉 SGX_ACCOUNT_*（含 SGX_ACCOUNT_ROOT_KEY）和 D1_ACCOUNT_AUTH，加上 ACCOUNT / ACCOUNT_VERIFIER；
 * - 账号：只拿 ACCOUNT_ENV_KEYS 里列出的（账号钥匙、账号根密钥、pepper、D1_ACCOUNT_AUTH、站点变量、ASSETS 和可选的账号资料绑定）。
 *
 * 和真实服务绑定的差别（只影响预览）：请求 / 响应对象在同一个 isolate 里直接传，不经序列化；账号那一半没有自己的默认 fetch
 * （正式的默认 fetch 一律 404，预览里根本没有公网入口能到它）。
 * 打包：deploy.yml「Bundle preview _worker.js」用 wrangler deploy --dry-run 打这个文件；本地模拟器 preview-emulator.cjs 直接 import。
 * cloudflare:workers 由 entrypoints.js 引入（WorkerEntrypoint，这里不用）；node 里由 tests/workers/account/_cf-workers.mjs 提供替身。
 */
import gateway from '../../../workers/auth-gateway/src/index.js';
import { serviceFetch, checkAccountSession } from '../../../workers/account/src/entrypoints.js';

/** 账号那一半能看到的 env 键（同 workers/account/wrangler.toml 的绑定 / 变量；预览不绑账号资料库，有就带上） */
export const ACCOUNT_ENV_KEYS = Object.freeze([
  'SGX_ENV', 'SGX_SITE', 'SGX_RP_ID', 'SGX_ORIGIN',
  'SGX_ACCOUNT_PRIVATE', 'SGX_ACCOUNT_PUBLIC', 'SGX_ACCOUNT_ROOT_KEY', 'SGX_PW_PEPPER',
  'D1_ACCOUNT_AUTH', 'KV_PROFILE', 'D1_SETTINGS_SYNC', 'D1_WELLBEING',
  'ASSETS',
]);

/** 网关那一半不许看到的 env 键（正式网关 wrangler.toml 不绑这些） @param {string} k */
export function isAccountOnlyKey(k) {
  return k.startsWith('SGX_ACCOUNT_') || k === 'D1_ACCOUNT_AUTH' || k === 'KV_PROFILE' || k === 'D1_SETTINGS_SYNC' || k === 'D1_WELLBEING';
}

/** @param {Record<string, any>} env */
export function accountEnvOf(env) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of ACCOUNT_ENV_KEYS) if (env && env[k] !== undefined) out[k] = env[k];
  return out;
}

/**
 * 网关 env：去掉账号专属的键，挂上两个进程内的「服务绑定」。
 * @param {Record<string, any>} env
 * @param {{ waitUntil(p: Promise<any>): void }} [ctx]
 */
export function gatewayEnvOf(env, ctx) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of Object.keys(env || {})) if (!isAccountOnlyKey(k)) out[k] = env[k];
  const acct = accountEnvOf(env);
  out.ACCOUNT = { fetch: (/** @type {Request} */ req) => serviceFetch(req, acct, ctx) };
  out.ACCOUNT_VERIFIER = {
    accountSession: (/** @type {string} */ cookie, /** @type {any} */ clientContext) => checkAccountSession(acct, cookie, clientContext),
  };
  return out;
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, any>} env
   * @param {{ waitUntil(p: Promise<any>): void }} ctx
   */
  fetch(request, env, ctx) {
    return gateway.fetch(request, gatewayEnvOf(env, ctx), ctx);
  },
};
