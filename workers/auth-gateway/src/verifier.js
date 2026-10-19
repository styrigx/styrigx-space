/**
 * @fileoverview 给其他 Worker 用的验票函数（通过服务绑定 RPC 调用，入口见 rpc.js）。
 *
 * 其他 Worker（如 book 仓库的 styrigx-book-api）不持任何钥匙，把浏览器带来的 Cookie 头原样交给网关，
 * 网关用自己 Secrets Store 里的公钥验签、用 KV 里的 epoch 核对，只回答结论，不回任何密钥或 cookie 内容。
 * 与网关自己验页面、验接口用的是同一套代码（verifySessionDetailed、parseAppToken、getAppEpoch）。
 */
import { verifySessionDetailed } from '../functions/_middleware.js';
import { parseAppToken, getAppEpoch, APP_COOKIE } from '../functions/api/app-token.js';
import { ed25519Verify } from '../functions/_kernel/crypto.js';
import { REALM_APP, realmPublicKey, SESSION_EPOCH_KEY } from '../functions/_kernel/realms.js';

const MAX_COOKIE_HEADER = 8192;
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

function cookieRequest(cookieHeader) {
  const h = typeof cookieHeader === 'string' ? cookieHeader.slice(0, MAX_COOKIE_HEADER) : '';
  return new Request('https://internal.invalid/', { headers: h ? { Cookie: h } : {} });
}

/** 所有同名 cookie 的值（旧版可能留下只绑主机的同名 cookie） */
function allCookies(cookieHeader, name) {
  const out = [];
  for (const part of String(cookieHeader || '').slice(0, MAX_COOKIE_HEADER).split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) out.push(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * 会话：{ ok: true, role: 'owner'|'visitor' } 或 { ok: false, reason }（reason 只是原因代号）。
 * @param {string} cookieHeader 浏览器发来的 Cookie 头
 * @param {Record<string, any>} env 已换好密钥字符串的 env
 */
export async function checkSession(cookieHeader, env) {
  const s = await verifySessionDetailed(cookieRequest(cookieHeader), env);
  return s.ok ? { ok: true, role: s.role } : { ok: false, reason: s.reason };
}

/**
 * 应用通行证 sgx-app：验签（SGX_APP_PUBLIC）+ aud/scope 对得上 + 未过期 +
 * session epoch 不低于当前 + appEpoch 不低于该应用当前纪元（KV 读不到 → fail closed）。
 * 成功：{ ok: true, appEpoch, exp }；失败：{ ok: false, reason }。
 * @param {string} cookieHeader
 * @param {Record<string, any>} env
 * @param {string} aud  应用名（如 'book'）
 * @param {string} scope 权限（如 'upload'）
 */
export async function checkAppPass(cookieHeader, env, aud, scope) {
  if (!NAME_RE.test(String(aud)) || !NAME_RE.test(String(scope))) return { ok: false, reason: 'bad-request' };
  const vals = allCookies(cookieHeader, APP_COOKIE);
  if (!vals.length) return { ok: false, reason: 'no-pass' };
  const pub = realmPublicKey(env, REALM_APP); /* SGX_APP_PUBLIC */
  if (!pub) return { ok: false, reason: 'no-pubkey' };
  if (!env.OWNER_KV) return { ok: false, reason: 'kv-error' };
  let cur, curApp;
  try {
    cur = parseInt((await env.OWNER_KV.get(SESSION_EPOCH_KEY)) || '0', 10) || 0;
    curApp = await getAppEpoch(env.OWNER_KV, aud);
  } catch (e) {
    return { ok: false, reason: 'kv-error' };
  }
  let reason = 'bad-format';
  for (const v of vals) {
    const t = parseAppToken(v);
    if (!t) continue;
    if (t.aud !== aud || t.scope !== scope) { reason = 'scope'; continue; }
    if (t.exp <= Date.now()) { reason = 'expired'; continue; }
    const payload = [t.role, t.epoch, t.appEpoch, t.iat, t.exp, t.aud, t.scope].join('.');
    if (!(await ed25519Verify(pub, payload, t.sig))) { reason = 'bad-sig'; continue; }
    if (t.epoch < cur) { reason = 'epoch-low'; continue; }
    if (t.appEpoch < curApp) { reason = 'app-epoch-low'; continue; }
    return { ok: true, appEpoch: t.appEpoch, exp: t.exp };
  }
  return { ok: false, reason };
}

/**
 * 应用当前纪元（book 上传会话中途核对用：删过该应用的通行密钥后纪元加一，进行中的上传要作废）。
 * 成功：{ ok: true, appEpoch }；KV 出错或参数不对：{ ok: false, reason }（调用方 fail closed）。
 * @param {Record<string, any>} env
 * @param {string} aud
 */
export async function currentAppEpoch(env, aud) {
  if (!NAME_RE.test(String(aud))) return { ok: false, reason: 'bad-request' };
  if (!env || !env.OWNER_KV) return { ok: false, reason: 'kv-error' };
  try {
    return { ok: true, appEpoch: await getAppEpoch(env.OWNER_KV, aud) };
  } catch (e) {
    return { ok: false, reason: 'kv-error' };
  }
}
