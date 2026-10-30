/**
 * 网关剥头与转发帮手（账号拆分 PR3，方案第 3 节）。
 *
 * - stripRequest(request)：网关 fetch 第一步，删掉入站请求里所有 x-styrigx-* 和 x-sgx-role（之后的主站、子站回源、静态直通、转发用的都是剥过的请求）
 * - clientContextOf(request)：客户端上下文（IP 用 lib/http.js clientIp() 读 CF-Connecting-IP，国家城市读 request.cf）
 * - forwardToService(svc, target, lockSession, clientContext)：用 target（浏览器的请求，fetch 第一步已剥过头）构造一个新请求，
 *   再剥一次头、按验过的锁屏会话写全套身份头 + 客户端上下文头（lib/lock-identity.js writeLockIdentity），交给服务绑定 svc.fetch。
 *   URL、方法、正文、Cookie、Origin 原样（账号侧 isSameOrigin 在转发后仍成立）。出错原样抛给调用方（src/index.js forward 映射成 503 upstream）。
 *
 * 用户：只有 src/index.js forward()（账号转发表 src/forwarding.js → 服务绑定 ACCOUNT）。chat / search / status 不经这里：
 * api/chat.js、api/search.js 自己新建内部请求并写 X-Sgx-Role，api/status.js 不写身份头。
 */
import { clientIp } from './lib/http.js';
import { stripInternalHeaders, writeLockIdentity } from './lib/lock-identity.js';

/**
 * 剥掉入站请求里的内部头。没有要剥的 → 原对象；有 → 新 Request（cf 一并带上）。
 * @param {Request} request
 * @returns {Request}
 */
export function stripRequest(request) {
  if (!request) return request;
  const headers = new Headers(request.headers);
  const before = [...headers.keys()].length;
  stripInternalHeaders(headers);
  if ([...headers.keys()].length === before) return request;
  /** @type {Record<string, any>} */
  const init = { headers };
  const out = new Request(request, init);
  const cf = /** @type {any} */ (request).cf;
  if (cf && !(/** @type {any} */ (out).cf)) {
    try { Object.defineProperty(out, 'cf', { value: cf }); } catch (e) {}
  }
  return out;
}

/**
 * 客户端上下文（写进 X-Styrigx-Client-*）：地址 = CF-Connecting-IP（clientIp()，没有 → 不写），国家城市 = request.cf。
 * @param {Request} request
 * @returns {{address:string, country:string, city:string}}
 */
export function clientContextOf(request) {
  const ip = request ? clientIp(request) : 'unknown';
  const cf = (request && /** @type {any} */ (request).cf) || {};
  return {
    address: ip && ip !== 'unknown' ? ip : '',
    country: typeof cf.country === 'string' ? cf.country : '',
    city: typeof cf.city === 'string' ? cf.city : '',
  };
}

/**
 * 转给下游服务：剥头 + 写身份头，其余原样。
 * @param {{fetch: (r: Request) => Promise<Response>}} svc 服务绑定
 * @param {Request} target 要转的请求（浏览器的请求，已剥过外来内部头）
 * @param {any} lockSession verifyLockSession 的结论（没有会话 → 不写身份头）
 * @param {{address?:string, country?:string, city?:string}} clientContext
 * @returns {Promise<Response>}
 */
export function forwardToService(svc, target, lockSession, clientContext) {
  const headers = writeLockIdentity(new Headers(target.headers), lockSession, clientContext);
  return svc.fetch(new Request(target, { headers }));
}
