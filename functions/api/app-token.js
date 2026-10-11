/**
* APP 通行证签发（sgx-app）。2.10.0 三域拆分版。
*
* 子站敏感操作（book 上传/删除/换封面）前，owner 在主站完成**应用类通行密钥**
* 的 WebAuthn 认证（/app-verify/），由此接口签发短时 sgx-app 通行证，
* 子站用 SGX_APP_PUBLIC 验签。
*
*
* 1. book 跳转到主站：https://styrigx.com/app-verify/?aud=book&scope=upload&return=<book-url>
* 2. 主站校验 return 白名单，不通过则拒绝
* 3. 用户用该 aud 的应用类通行密钥完成 WebAuthn（强制 UV）→ 服务端写入单次
* app-auth 记录，返回 appCid。**全程不需要 sgx-stepup，也不接受密码。**
* 4. 前端 POST /api/app-token {action:'issue', aud, scope, return, appCid}，
* 服务端消费单次 app-auth 记录（绑定 aud，防前端伪造）后签发
* 5. 主站设置 sgx-app cookie：Domain=.styrigx.com; HttpOnly; Secure; SameSite=Lax; Max-Age=600
* 6. 跳回 book 的 return URL；book 后端从请求 cookie 中验签
*
* POST /api/app-token
* - { action: 'issue', aud, scope, return, appCid} → 必须持有有效 owner 会话 +
* 刚完成的应用类认证（单次 app-auth 记录绑定）。签发后设置 sgx-app cookie
* 并返回 { ok: true}（不再在 body 里返回 token，避免 book 前端需要跨域读取）。
*
* 安全要求：
* - 必须已登录 owner 会话
* - 必须有刚完成的应用类 WebAuthn 认证（单次 challenge 记录绑定，不能只靠前端声明）
* - aud/scope/return 白名单（见../_kernel/app-registry.js）
* - 缺 appCid 或记录无效 → 403 app-auth-required
* - 密码不能用于 APP 验证（appCid 只能来自应用类通行密钥认证）
*
* 环境变量：
* - SGX_APP_PRIVATE：Ed25519 私钥（PKCS8 PEM），缺失则拒绝签发（500 no-app-key）
* 由 Gray 在 Cloudflare Pages space 项目里配成 Secret，本仓库不生成、不提交、不打印
* - 不读 SGX_STEPUP_*（2.10.0 解耦，CI 静态检查）
*/
import { verifySessionDetailed} from '../_middleware.js';
import { getSessionEpoch, ROLE_OWNER} from '../_kernel/session.js';
import { ed25519Sign} from '../_kernel/crypto.js';
import { getApp, isScopeAllowed, validateAppReturn, defaultAppReturn} from '../_kernel/app-registry.js';
import { APP_AUTH_PREFIX} from './owner-passkey.js';

/* sgx-app token 有效期：10 分钟 */
export const APP_TOKEN_MAX_AGE = 600;

/* sgx-app cookie 定义 */
export const APP_COOKIE = 'sgx-app';
export const APP_COOKIE_ATTRS = 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600';

/**
* 读取该 aud 的应用纪元（KV app-epoch:<aud>，缺失视为 0）。
* KV 出错时抛错（调用方 fail closed）。
* @param {any} kv
* @param {string} aud
*/
export async function getAppEpoch(kv, aud) {
const v = await kv.get('app-epoch:' + aud);
if (v === null || v === undefined) return 0;
return parseInt(v, 10) || 0;
}

/**
* 签发 sgx-app token（2.10.0 格式）。
* 格式：owner.epoch.appEpoch.iat.exp.aud.scope.Ed25519(SGX_APP_PRIVATE, "owner.epoch.appEpoch.iat.exp.aud.scope")
* @param {string} privatePem Ed25519 私钥（PKCS8 PEM）
* @param {number} epoch 当前 session epoch
* @param {number} appEpoch 该 aud 的应用纪元
* @param {string} aud 目标子站（如 book）
* @param {string} scope 权限范围（如 upload）
*/
export async function signAppToken(privatePem, epoch, appEpoch, aud, scope) {
const iat = Date.now();
const exp = iat + APP_TOKEN_MAX_AGE * 1000;
const payload = ['owner', epoch, appEpoch, iat, exp, aud, scope].join('.');
const sig = await ed25519Sign(privatePem, payload);
return payload + '.' + sig;
}

/**
* 解析 sgx-app token（2.10.0 格式，8 段）。
* @param {string} val
* @returns {{role:string, epoch:number, appEpoch:number, iat:number, exp:number, aud:string, scope:string, sig:string}|null}
*/
export function parseAppToken(val) {
if (!val || typeof val!== 'string') return null;
const parts = val.split('.');
if (parts.length!== 8) return null;
if (parts[0]!== ROLE_OWNER) return null;
const epoch = parseInt(parts[1], 10);
const appEpoch = parseInt(parts[2], 10);
const iat = parseInt(parts[3], 10);
const exp = parseInt(parts[4], 10);
if (!Number.isFinite(epoch) ||!Number.isFinite(appEpoch) ||!Number.isFinite(iat) ||!Number.isFinite(exp)) return null;
return { role: parts[0], epoch, appEpoch, iat, exp, aud: parts[5], scope: parts[6], sig: parts[7]};
}

/** @param {any} context */
export async function onRequest(context) {
const { request, env} = context;

if (request.method!== 'POST') {
return new Response(JSON.stringify({ ok: false, error: 'method'}), {
status: 405,
headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store'},
});
}

try {
// 0. CSRF 防护：Origin 必须为 https://styrigx.com，且 Content-Type 为 application/json
const origin = request.headers.get('Origin');
const contentType = request.headers.get('Content-Type') || '';
if (origin!== 'https://styrigx.com') {
return new Response(JSON.stringify({ ok: false, error: 'origin'}), {
status: 403,
headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store'},
});
}
if (!contentType.includes('application/json')) {
return new Response(JSON.stringify({ ok: false, error: 'content-type'}), {
status: 403,
headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store'},
});
}

// 1. 必须是已登录 owner 会话
const session = await verifySessionDetailed(request, env.SGX_LOCK_PUBLIC);
if (!session || session.role!== ROLE_OWNER) {
return new Response(JSON.stringify({ ok: false, error: 'forbidden'}), {
status: 403,
headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store'},
});
}

// 2. 解析请求参数
let body;
try {
body = await request.json();
} catch (e) {
body = {};
}

const { action, aud, scope, return: returnUrl, appCid} = body;
if (action!== 'issue') {
return new Response(JSON.stringify({ ok: false, error: 'action'}), {
status: 400,
headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store'},
});
}

// 3. 校验 aud 和 scope 白名单（不在白名单的 aud → 400）
if (!getApp(aud)) {
return new Response(JSON.stringify({ ok: false, error: 'aud'}), {
status: 400,
headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store'},
});
}
if (!isScopeAllowed(aud, scope)) {
return new Response(JSON.stringify({ ok: false, error: 'scope'}), {
status: 400,
headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store'},
});
}

// 4. 必须有刚完成的应用类认证（单次 app-auth 记录绑定，防前端伪造）
// 密码不能用于 APP 验证：appCid 只能来自应用类通行密钥的 WebAuthn。
let appRec = null;
try {
appRec = appCid? await env.OWNER_KV.get(APP_AUTH_PREFIX + appCid, 'json'): null;
if (appCid) await env.OWNER_KV.delete(APP_AUTH_PREFIX + appCid);
} catch (e) {}
if (!appRec || appRec.aud!== aud || (appRec.exp || 0) < Date.now()) {
return new Response(JSON.stringify({ ok: false, error: 'app-auth-required'}), {
status: 403,
headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store'},
});
}

// 5. 校验 return（origin 严格等于该 aud 登记的 origin；缺省跳默认页）
const validReturn = returnUrl? validateAppReturn(aud, returnUrl): defaultAppReturn(aud);
if (!validReturn) {
return new Response(JSON.stringify({ ok: false, error: 'return'}), {
status: 400,
headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store'},
});
}

// 6. 签发 token（SGX_APP_PRIVATE 缺失 → fail closed）
const privatePem = env.SGX_APP_PRIVATE;
if (!privatePem) {
return new Response(JSON.stringify({ ok: false, error: 'no-app-key'}), {
status: 500,
headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store'},
});
}

const kv = env.OWNER_KV;
let epoch, appEpoch;
try {
epoch = await getSessionEpoch(kv);
appEpoch = await getAppEpoch(kv, aud);
} catch (e) {
return new Response(JSON.stringify({ ok: false, error: 'epoch'}), {
status: 503,
headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store'},
});
}
const token = await signAppToken(privatePem, epoch, appEpoch, aud, scope);

// 7. 设置 sgx-app cookie（Domain=.styrigx.com，book 后端可读），不再在 body 返回 token
return new Response(JSON.stringify({ ok: true, return: validReturn}), {
status: 200,
headers: {
'Content-Type': 'application/json',
'Cache-Control': 'private, no-store',
'Set-Cookie': `${APP_COOKIE}=${token}; ${APP_COOKIE_ATTRS}`,
},
});
} catch (e) {
return new Response(JSON.stringify({ ok: false, error: 'server'}), {
status: 500,
headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store'},
});
}
}
