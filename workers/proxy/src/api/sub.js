/**
 * 订阅下载 GET / HEAD /s/<令牌>/<来源名>：只回 age 密文（mihomo provider 用 age-secret-key 解）。
 * - 先限流（Workers Rate Limiting，按 IP；错令牌也计数），超了 429
 * - 令牌只比 SHA-256，常量时间；错令牌、没生成过链接、来源不存在 / 关着 / 还没成品 → 一律 404（不区分）
 * - no-store，不 302；不读 DB_KEY（下载不需要）
 */
import { text } from '../lib/http.js';
import { TOKEN_RE, hashToken, sameHex } from '../lib/token.js';
import { NAME_RE } from '../core/sub/config.js';
import { getMeta, getArmor, dbReady } from '../core/sub/store.js';

export const SUB_RE = /^\/s\/([^/]+)\/([^/]+)$/;

const notFound = () => text('Not Found', 404);

/** @param {Request} request @param {any} env @param {URL} url */
export async function sub(request, env, url) {
  if (env && env.RL_SUB && typeof env.RL_SUB.limit === 'function') {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    try {
      const { success } = await env.RL_SUB.limit({ key: ip });
      if (!success) return text('Too Many Requests', 429, { 'retry-after': '60' });
    } catch (e) { /* 限流出错不挡（WAF 还有一层） */ }
  }
  const m = SUB_RE.exec(url.pathname);
  if (!m || !TOKEN_RE.test(m[1]) || !NAME_RE.test(m[2]) || !dbReady(env)) return notFound();
  const stored = await getMeta(env, 'token_hash');
  const given = await hashToken(m[1]);
  if (!stored || !sameHex(given, stored)) return notFound();
  const armor = await getArmor(env, m[2]);
  if (!armor) return notFound();
  return new Response(request.method === 'HEAD' ? null : armor, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}
