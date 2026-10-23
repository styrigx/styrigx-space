/**
 * @fileoverview 给其他 Worker 用的验票函数（通过服务绑定 RPC 调用，入口见 rpc.js）。
 *
 * 其他 Worker（如 daymark 仓库的 styrigx-daymark-core）不持任何钥匙，把浏览器带来的 Cookie 头原样交给网关，
 * 网关用自己 Secrets Store 里的公钥验签、用 KV 里的 epoch 核对，只回答结论，不回任何密钥或 cookie 内容。
 * 与网关自己验页面、验接口用的是同一套代码（verifySessionDetailed）。
 */
import { verifySessionDetailed } from '../functions/_middleware.js';
import { verifyAccountCookie } from '../functions/_kernel/account-session.js';

const MAX_COOKIE_HEADER = 8192;

const MAX_META = 512;

/**
 * @param {string} cookieHeader
 * @param {{ua?:string, country?:string, city?:string}} [meta] 账号设备记录用（User-Agent、cf 国家城市），只在 account() 里用
 */
function cookieRequest(cookieHeader, meta) {
  const h = typeof cookieHeader === 'string' ? cookieHeader.slice(0, MAX_COOKIE_HEADER) : '';
  /** @type {Record<string,string>} */
  const headers = h ? { Cookie: h } : {};
  const m = meta && typeof meta === 'object' ? meta : {};
  if (typeof m.ua === 'string' && m.ua) headers['User-Agent'] = m.ua.slice(0, MAX_META);
  const req = new Request('https://internal.invalid/', { headers });
  const cf = {};
  if (typeof m.country === 'string' && m.country) cf.country = m.country.slice(0, 8);
  if (typeof m.city === 'string' && m.city) cf.city = m.city.slice(0, 80);
  if (Object.keys(cf).length) Object.defineProperty(req, 'cf', { value: cf });
  return req;
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
 * 账号会话（sgx-account）：{ ok: true } 或 { ok: false, reason }（reason 只是原因代号）。
 * 账号 Worker styrigx-account 的云同步（/api/prefs）用：和网关以前验 /api/prefs 时同一个函数（verifyAccountCookie），
 * 设备记录的 lastSeen 也照旧刷新（meta 带浏览器的 User-Agent 和 cf 国家城市）。
 * @param {string} cookieHeader 浏览器发来的 Cookie 头
 * @param {Record<string, any>} env 已换好密钥字符串的 env
 * @param {{ua?:string, country?:string, city?:string}} [meta]
 */
export async function checkAccount(cookieHeader, env, meta) {
  const a = await verifyAccountCookie(cookieRequest(cookieHeader, meta), env);
  return a.ok ? { ok: true } : { ok: false, reason: a.reason };
}
