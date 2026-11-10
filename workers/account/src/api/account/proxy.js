/**
 * POST /api/account/proxy：代理订阅管理（终端 sub 指令 v3.1）。本 Worker 只做门卫：进站会话 + 账号 session，
 * 碰令牌原文或公钥的（show / token / key）再要 reauth；然后经服务绑定 PROXY 调 styrigx-proxy-rules 的命名入口 ProxyAdmin。
 * 本 Worker 不绑代理订阅的 D1、不绑 SGX_PROXY_DB_KEY，也不留任何订阅数据。
 *
 * { action }（同源）：
 * - status → 状态（公钥头尾、令牌状态 none | sealed | hash-only、各源）
 * - show（reauth）→ 令牌原文 + base（服务端封存，随时可重印）；下载地址 = base + 令牌 + '/' + 来源名
 * - token（reauth）→ 换新令牌（旧链接全部失效）+ base
 * - key { pubkey }（reauth）→ 换公钥（只收 age1… X25519），自动重加密
 * - add { name, url } → 加机场 / 同名改链接（先试拉，回新旧域名，不回链接）
 * - upload { name, text } → 上传文件 / 同名覆盖（只抽 proxies）
 * - mv { from, to } → 改名，不刷新
 * - on / off / rm { name }
 * 改动类都在 ProxyAdmin 里自动刷新一次，回的结果里带 refresh。ProxyAdmin 的业务失败原样回（422，{ ok:false, error }）。
 */
import { json, apiError } from '../../lib/http.js';
import { verifySession } from '../../core/session.js';
import { verifyReauth } from '../../core/reauth.js';
import { readPost, lockDenial, guarded } from './_request.js';

export const SUB_BASE = 'https://proxy-rules.styrigx.com/s/';
const MAX_TEXT = 2 * 1024 * 1024;

const REAUTH = new Set(['show', 'token', 'key']);
const ACTIONS = new Set(['status', 'show', 'token', 'key', 'add', 'upload', 'mv', 'on', 'off', 'rm']);

/** @param {any} env */
const proxyReady = (env) => !!(env && env.PROXY && typeof env.PROXY.status === 'function');

const str = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

export const onRequestPost = guarded(async function (context) {
  const { request, env } = context;
  const rp0 = await readPost(request);
  if (!rp0.ok) return rp0.response;
  const { body, action } = rp0;
  const denied = lockDenial(request, env);
  if (denied) return denied;
  if (!ACTIONS.has(action)) return apiError(400, 'action');
  const acc = await verifySession(request, env);
  if (!acc.ok) return apiError(401, 'account', { reason: acc.reason });
  if (REAUTH.has(action)) {
    const rv = await verifyReauth(request, env, acc);
    if (!rv.ok) return apiError(403, 'reauth', { reason: rv.reason });
  }
  if (!proxyReady(env)) return apiError(503, 'config');

  const P = env.PROXY;
  let r;
  try {
    switch (action) {
      case 'status': r = await P.status(); break;
      case 'key': {
        const k = str(body.pubkey, 200);
        if (!k) return apiError(400, 'params');
        r = await P.setKey(k);
        break;
      }
      case 'show': r = await P.showToken(); if (r && r.ok) r = { ...r, base: SUB_BASE }; break;
      case 'token': r = await P.rotateToken(); if (r && r.ok) r = { ...r, base: SUB_BASE }; break;
      case 'add': {
        const name = str(body.name, 32); const url = str(body.url, 2048);
        if (!name || !url) return apiError(400, 'params');
        r = await P.addAirport(name, url);
        break;
      }
      case 'upload': {
        const name = str(body.name, 32); const text = str(body.text, MAX_TEXT);
        if (!name || !text) return apiError(400, 'params');
        r = await P.upload(name, text);
        break;
      }
      case 'on': case 'off': {
        const name = str(body.name, 32);
        if (!name) return apiError(400, 'params');
        r = await P.setEnabled(name, action === 'on');
        break;
      }
      case 'mv': {
        const from = str(body.from, 32); const to = str(body.to, 32);
        if (!from || !to) return apiError(400, 'params');
        r = await P.rename(from, to);
        break;
      }
      case 'rm': {
        const name = str(body.name, 32);
        if (!name) return apiError(400, 'params');
        r = await P.remove(name);
        break;
      }
      default: return apiError(400, 'action');
    }
  } catch (e) {
    return apiError(503, 'upstream');
  }
  if (!r || typeof r !== 'object') return apiError(503, 'upstream');
  return json(r.ok ? 200 : 422, r);
});
