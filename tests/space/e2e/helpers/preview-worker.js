/**
 * passkey-e2e 预览的组合入口（只给 CI 和本地模拟器用，绝不部署成正式 Worker；账号拆分 PR3）。
 *
 * 正式环境是两个 Worker：网关 styrigx-space-core 经服务绑定 ACCOUNT（AccountService）/ ACCOUNT_VERIFIER（AccountVerifier）
 * 调账号 Worker styrigx-account。预览只有一个 Pages 项目（passkey-e2e.styrigx-space.pages.dev），它的 _worker.js 只能是一个脚本，
 * 所以这里把两边仓库里的真实代码装进同一个脚本：
 * - 网关那一半 = workers/space-core/src/app.js 的 default.fetch（剥头、门、转发表、锁屏接口全是正式代码）；
 * - 账号那一半 = workers/account/src/rpc/account-service.js 的 serviceFetch（AccountService.fetch 的实现）和 rpc/account-verifier.js 的 checkAuthorize
 *   （AccountVerifier.authorize 的实现），包成和服务绑定同形状的进程内适配器，挂到网关 env 的 ACCOUNT / ACCOUNT_VERIFIER 上。
 *
 * env 按正式的绑定拆开，两半互相看不到对方的钥匙和库（预览也验证「网关不碰账号钥匙」）：
 * - 网关：去掉 SGX_ACCOUNT_*（含恢复密钥 SGX_ACCOUNT_RECOVERY_KEY、账号密码 pepper SGX_ACCOUNT_PASSWORD_PEPPER）和 D1_ACCOUNT，加上 ACCOUNT / ACCOUNT_VERIFIER；
 * - 账号：只拿 ACCOUNT_ENV_KEYS 里列出的（签名钥匙、恢复密钥、账号密码 pepper、D1_ACCOUNT、站点变量、ASSETS 和可选的 KV_PROFILE）。
 *
 * 和真实服务绑定的差别（只影响预览）：请求 / 响应对象在同一个 isolate 里直接传，不经序列化；账号那一半没有自己的默认 fetch
 * （正式的默认 fetch 一律 404，预览里根本没有公网入口能到它）。
 * styrigx-ai（P4-1）：预览不调真实 Workers AI。网关 env 的 AI_SERVICE 换成桩 previewAiService：POST /ask 回固定 hits + 固定回答流
 * （有账号结论头 X-Styrigx-Account-Session: 1 时多一条私密来源，X-Styrigx-AI-Scope 同正式），GET /healthz 200，GET /find（v5 S4）回固定一条公开结果。
 * 打包：deploy.yml「Bundle preview _worker.js」用 wrangler deploy --dry-run 打这个文件；本地模拟器 preview-emulator.cjs 直接 import。
 * cloudflare:workers 由 rpc/*.js 引入（WorkerEntrypoint，这里不用）；node 里由 tests/workers/account/_cf-workers.mjs 提供替身。
 */
import gateway from '../../../../workers/space-core/src/app.js';
import { serviceFetch } from '../../../../workers/account/src/rpc/account-service.js';
import { checkAuthorize } from '../../../../workers/account/src/rpc/account-verifier.js';

/** 账号那一半能看到的 env 键（同 workers/account/wrangler.toml 的绑定 / 变量；预览不绑账号资料库，有就带上） */
export const ACCOUNT_ENV_KEYS = Object.freeze([
  'SGX_ENV', 'SGX_SITE', 'SGX_RP_ID', 'SGX_ORIGIN',
  'SGX_ACCOUNT_PRIVATE', 'SGX_ACCOUNT_PUBLIC', 'SGX_ACCOUNT_RECOVERY_KEY', 'SGX_ACCOUNT_PASSWORD_PEPPER',
  'D1_ACCOUNT', 'KV_PROFILE',
  'ASSETS',
]);

/** 网关那一半不许看到的 env 键（正式网关 wrangler.toml 不绑这些） @param {string} k */
export function isAccountOnlyKey(k) {
  return k.startsWith('SGX_ACCOUNT_') || k === 'D1_ACCOUNT' || k === 'KV_PROFILE';
}

/** 预览没有 Rate Limiting 绑定：总闸用这个永远放行的桩（只在测试入口里，正式网关绑真的 [[ratelimits]]） */
export const PREVIEW_ANON_LIMITER = Object.freeze({ limit: async () => ({ success: true }) });

/** 预览桩的固定来源（公开一条；有账号会话再加私密一条） */
export const PREVIEW_AI_ANSWER = Object.freeze(['这是预览环境的固定回答。', '\n\n- 调色板：/wild/']);

/**
 * styrigx-ai 的预览桩（同服务绑定的形状：只有 fetch）。事件顺序同正式：delta… → done（2026-11-06 起不发 hits）。
 * @param {Request} req
 */
export async function previewAiService(req) {
  const url = new URL(req.url);
  const enc = new TextEncoder();
  const ev = (/** @type {string} */ name, /** @type {any} */ data) => 'event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n';
  if (url.pathname === '/healthz' && req.method === 'GET') return Response.json({ ok: true, sites: 1, missing: [], preview: true });
  /* v5 S4：关键词搜索的桩（固定一条公开结果；不读 KV） */
  if (url.pathname === '/find' && req.method === 'GET') {
    const q = String(url.searchParams.get('q') || '').trim();
    return Response.json({ ok: true, q, results: q ? [{ title: 'Palette', url: 'https://styrigx.com/wild/', site: 'space', snippet: 'preview' }] : [] });
  }
  if (url.pathname !== '/ask') return Response.json({ ok: false, error: 'not-found' }, { status: 404 });
  if (req.method !== 'POST') return Response.json({ ok: false, error: 'method' }, { status: 405 });
  let body;
  try { body = await req.json(); } catch (e) { return Response.json({ ok: false, error: 'bad_request' }, { status: 400 }); }
  if (!body || typeof body.q !== 'string' || !body.q.trim()) return Response.json({ ok: false, error: 'bad_request' }, { status: 400 });
  if ([...body.q.trim()].length > 200) return Response.json({ ok: false, error: 'too-long' }, { status: 400 });
  const priv = req.headers.get('X-Styrigx-Account-Session') === '1';
  const text = PREVIEW_AI_ANSWER.map((t) => ev('delta', { text: t })).join('') + ev('done', {});
  return new Response(enc.encode(text), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Styrigx-AI-Scope': priv ? 'private' : 'public' },
  });
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
    /* P2-2：网关 api/search.js、api/chat.js 经 core/account-rpc.js askAuthorize 问它（AccountVerifier.authorize 的实现） */
    authorize: (/** @type {string} */ cookie, /** @type {any} */ clientContext, /** @type {any} */ opts) => checkAuthorize(acct, cookie, clientContext, opts),
  };
  /* P4-1：不调真实 Workers AI */
  out.AI_SERVICE = { fetch: previewAiService };
  /* 无会话写接口的总闸（core/anon-limit.js）缺绑定会 fail-closed 503；Pages 预览 / 本地模拟器不支持 Rate Limiting 绑定 → 放行的桩（2026-11-09） */
  if (!out.ANON_LIMITER) out.ANON_LIMITER = PREVIEW_ANON_LIMITER;
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
