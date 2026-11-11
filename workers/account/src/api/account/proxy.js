/**
 * POST /api/account/proxy：代理订阅管理（终端 sub 指令 v3.1）。本 Worker 只做门卫：v6 会话、路由档 root（permits 判过；sudo 借来的 root 也算；
 * 没有 → 401 session），然后经服务绑定 PROXY 调 styrigx-proxy-rules 的命名入口 ProxyAdmin。v6 P4 起旧进站会话 / 账号 session / reauth 票删除。
 * 本 Worker 不绑代理订阅的 D1、不绑 SGX_PROXY_DB_KEY，也不留任何订阅数据。
 *
 * { action }（同源）：
 * - status → 状态（公钥头尾、令牌状态 none | sealed | hash-only、各源）
 * - show → 令牌原文 + base（服务端封存，随时可重印）；下载地址 = base + 令牌 + '/' + 来源名
 * - token → 换新令牌（旧链接全部失效）+ base
 * - key { pubkey } → 换公钥（只收 age1… X25519），自动重加密
 * - add { name, url } → 加机场 / 同名改链接（先试拉，回新旧域名，不回链接）
 * - upload { name, text } → 上传文件 / 同名覆盖（只抽 proxies）
 * - mv { from, to } → 改名，不刷新
 * - on / off / rm { name }（终端的 sub enable / sub disable / sub rm）
 * 改动类都在 ProxyAdmin 里自动刷新一次，回的结果里带 refresh。ProxyAdmin 的业务失败原样回（422，{ ok:false, error }）。
 *
 * 除 status 外都在身份审计记 sub <action> [源名]（不记链接、文件、公钥、令牌）。
 */
import { json, apiError } from '../../lib/http.js';
import { readPost, guarded, clientAddress, v6Admitted, auditActor } from './_request.js';
import { writeUserAudit } from '../../core/user-audit.js';
import { dbReady } from '../../lib/db.js';

export const SUB_BASE = 'https://proxy-rules.styrigx.com/s/';
const MAX_TEXT = 2 * 1024 * 1024;

const ACTIONS = new Set(['status', 'show', 'token', 'key', 'add', 'upload', 'mv', 'on', 'off', 'rm']);

/** @param {any} env */
const proxyReady = (env) => !!(env && env.PROXY && typeof env.PROXY.status === 'function');

const str = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

export const onRequestPost = guarded(async function (context) {
  const { request, env } = context;
  const rp0 = await readPost(request);
  if (!rp0.ok) return rp0.response;
  const { body, action } = rp0;
  /* v6 P4（定稿 v5.2 §十三）：只认 v6 会话（root 档，permits 判过；sudo 借来的 root 也算）；旧会话 / reauth 票删除 */
  const v6 = await v6Admitted(context);
  if (!v6) return apiError(401, 'session');
  if (!dbReady(env)) return apiError(500, 'config');
  if (!ACTIONS.has(action)) return apiError(400, 'action');
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
  if (v6 && action !== 'status') {
    const who = auditActor(v6);
    const nm = action === 'mv' ? [str(body.from, 32), str(body.to, 32)].filter(Boolean).join(' ') : (str(body.name, 32) || '');
    await writeUserAudit(env, { uid: who.uid, command: 'sub ' + action + (nm ? ' ' + nm : '') + who.suffix, ok: r.ok === true, ip: clientAddress(request) });
  }
  return json(r.ok ? 200 : 422, r);
});
