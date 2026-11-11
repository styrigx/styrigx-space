/**
 * v6 身份统一（P2c，定稿 v5 §六 / §十）：sudo <命令> 借 root 执行一条——不只身份命令，账号 Worker 里任何一条接口都行。
 *
 * 请求（POST /api/identity，action = sudo）：{ action:'sudo', password | {cid, credential}, command:{ method, path, body? } }
 * - 先验「自己」的凭据（每次都验，sudoers 档由 api/identity.js 的 permits 判过），再在本 Worker 里直接调那条接口的处理函数，
 *   这一次调用里 context.auth.v6() 的结论是 root（uid 0，sudo:true，sudoBy = 真正执行的人）。
 * - 不发票据、不压栈、不写会话：借来的 root 只活在这一次函数调用里，处理函数返回就没了；下一条照样要 sudo。
 * - 目标只认路由表（core/route-access.js）里 worker = account 的行；方法 + 路径 + body.action 必须查得到一档（levelOf），
 *   查不到 → 400 action。别的 Worker 的接口（space-core / curio-core / daymark-core）不在本 Worker，sudo 够不到 → 400 not-here。
 * - 拒绝（SUDO_ROUTE_DENY）：
 *   · /api/identity：身份命令走 command.action 的写法（api/identity.js SUDO_COMMANDS），不能套娃。
 *   （v6 P4 删除的旧账号接口 /api/account/keys、/reset、/session、/reauth 不在路由表里，查不到档 → 400 action。）
 * - 处理函数自己的判断照旧（同源、参数、作用域……）；它认不认 v6 会话由它自己决定（还只认旧账号会话的接口在 v6 下本来就进不去，
 *   sudo 也一样进不去——割接时那些接口接上 v6，sudo 自动生效）。
 *
 * 审计由调用方（api/identity.js）写：sudo <方法> <路径> [action]，uid = 真正执行的人。
 * 只 import lib/、core/ 与 gate.js（不 import router.js：路由表从 context.routes 来，免得循环依赖）。
 */
import { ruleOf, levelOf } from '../core/route-access.js';
import { ROOT_UID } from '../core/groups.js';
import { headerAuth } from '../gate.js';
import { apiError } from '../lib/http.js';

/** sudo 能借的方法 */
const METHODS = Object.freeze(['GET', 'POST', 'PUT', 'DELETE']);
/** 不借的接口 → 错误码 */
export const SUDO_ROUTE_DENY = Object.freeze({
  '/api/identity': 'action',
});

/**
 * 解析 sudo 的目标接口。
 * @param {any} cmd body.command @param {Map<string, any>|undefined} routes 路由表（router.js API_ROUTES，经 context.routes 传进来）
 * @returns {{ok:true, method:string, path:string, search:string, action:string, level:string, body:any}|{ok:false, status:number, error:string}}
 */
export function sudoTarget(cmd, routes) {
  const method = cmd && typeof cmd.method === 'string' ? cmd.method.toUpperCase() : '';
  const raw = cmd && typeof cmd.path === 'string' ? cmd.path : '';
  if (METHODS.indexOf(method) === -1 || !raw.startsWith('/') || raw.length > 512) return { ok: false, status: 400, error: 'action' };
  let u;
  try { u = new URL(raw, 'https://sudo.invalid'); } catch (e) { return { ok: false, status: 400, error: 'action' }; }
  if (u.host !== 'sudo.invalid' || u.hash) return { ok: false, status: 400, error: 'action' };
  const path = u.pathname.length > 1 && u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
  if (Object.prototype.hasOwnProperty.call(SUDO_ROUTE_DENY, path)) {
    const e = SUDO_ROUTE_DENY[/** @type {keyof typeof SUDO_ROUTE_DENY} */ (path)];
    return { ok: false, status: e === 'root-creds' ? 403 : 400, error: e };
  }
  const rule = ruleOf(method, path);
  if (!rule) return { ok: false, status: 400, error: 'action' };
  if (rule.worker !== 'account') return { ok: false, status: 400, error: 'not-here' };
  const body = cmd.body === undefined || cmd.body === null ? null : cmd.body;
  if (body !== null && (typeof body !== 'object' || Array.isArray(body))) return { ok: false, status: 400, error: 'body' };
  if (body !== null && method === 'GET') return { ok: false, status: 400, error: 'body' };
  const action = body && typeof body.action === 'string' ? body.action : '';
  const level = levelOf(method, path, action ? { action } : undefined);
  if (!level) return { ok: false, status: 400, error: 'action' };
  if (!routes || typeof routes.get !== 'function' || !routes.get(path)) return { ok: false, status: 400, error: 'not-here' };
  return { ok: true, method, path, search: u.search, action, level, body };
}

/** 同 router.js pickHandler（不 import router.js） @param {any} mod @param {string} m */
function pick(mod, m) {
  const name = 'onRequest' + m.charAt(0) + m.slice(1).toLowerCase();
  if (mod && typeof mod[name] === 'function') return mod[name];
  if (mod && typeof mod.onRequest === 'function') return mod.onRequest;
  return null;
}

/**
 * 借 root 执行这一条（目标已过 sudoTarget、调用方已验过凭据）。回目标接口的响应。
 * @param {any} context POST /api/identity 的 context（request / env / routes / waitUntil）
 * @param {{method:string, path:string, search:string, level:string, body:any}} t sudoTarget 的结果
 * @param {{uid:number, name:string}} actor 真正执行的人（会话栈顶）
 * @param {string} sessionId
 * @returns {Promise<Response>}
 */
export async function runSudoRoute(context, t, actor, sessionId) {
  const src = context.request;
  const origin = new URL(src.url).origin;
  const headers = new Headers(src.headers);
  headers.delete('Content-Length');
  /** @type {RequestInit} */
  const init = { method: t.method, headers };
  if (t.body !== null) {
    headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(t.body);
  } else {
    headers.delete('Content-Type');
  }
  const req = new Request(origin + t.path + t.search, init);
  const base = headerAuth(req, context.env);
  const conclusion = Object.freeze({
    allowed: true, reason: 'ok', level: t.level, uid: ROOT_UID, name: 'root', groups: [], root: true, rescue: false,
    via: actor.name, renew: false, sessionId, sudo: true, sudoBy: actor.uid,
  });
  const auth = Object.assign({}, base, {
    hasV6: true,
    v6() { return Promise.resolve(conclusion); },
    v6Computed() { return null; }, /* 借来的 root 不续期 */
    async dataUid() { return ROOT_UID; },
  });
  const handler = pick(context.routes.get(t.path), t.method);
  if (!handler) return apiError(405, 'method');
  return handler({
    request: req, env: context.env, auth, params: {}, data: {}, functionPath: t.path,
    waitUntil: typeof context.waitUntil === 'function' ? context.waitUntil : () => {},
  });
}
