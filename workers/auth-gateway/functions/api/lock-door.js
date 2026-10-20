/**
 * 锁屏凭证的门（取代原二次验证接口）。
 *
 * 安全与隐私 → 锁屏凭证是安全操作页：每次进页都要验一次锁屏凭证（锁屏通行密钥 / 解锁密码，
 * 设了哪个显示哪个）或根凭证，通过后签 3 分钟锁屏门票 sgx-door(door=lock)，SGX_LOCK_* 签名
 * （_kernel/door.js）。离开页面前端立即 clear，再进重新验证。
 *
 * 进门的三个入口（各自签票，本接口只管状态与清票）：
 * - 锁屏通行密钥：/api/owner-passkey { action:'auth', door:true }（challenge 同解锁，pkClass=lock）
 * - 解锁密码：/api/owner-password { action:'verify', door:true }（与解锁共用限速）
 * - 根凭证：/api/root-auth { key }（有会话时签 door=lock，by=root）
 * 重置锁屏（/api/lockreset）签 door=lockreset：没有会话，只能设置解锁密码 / 增删锁屏通行密钥。
 *
 * POST /api/lock-door
 * - { action:'status' } → { ok:true, valid, door?, by?, expiresAt?, password, passkey }
 *   需要 owner 会话或有效的 lockreset 门票；password/passkey = 锁屏凭证是否已设置（门口按它显示入口）
 * - { action:'clear' } → 清门票（幂等，不要求会话；只清 sgx-door，不动 sgx-verified）
 *
 * 只接受 POST；校验 Origin；外层 try/catch 异常一律 { ok:false, error:'server' }。
 */
import { verifySessionDetailed } from '../_middleware.js';
import { ROLE_OWNER, ROLE_VISITOR } from '../_kernel/session.js';
import { isSameOrigin, originDenied } from '../_kernel/http.js';
import { REALM_LOCK } from '../_kernel/realms.js';
import { isLayerConfigured, LAYER_LOCK } from '../_kernel/layers.js';
import { verifyDoorCookie, clearDoorCookie, DOOR_LOCK, DOOR_LOCKRESET } from '../_kernel/door.js';
import { getPasskeys, PK_CLASS_LOCK } from './owner-passkey.js';

/**
 * 锁屏凭证管理的统一门禁（owner-password / owner-passkey / lock-all-devices / root-audit 共用）。
 *
 * - 锁屏门票（door=lock）有效 + owner 会话有效 → 通过；by=root 的代开会话在锁屏已配置时拒绝（纵深防御）
 * - allowReset 时，重置锁屏门票（door=lockreset）有效 → 通过（无会话，sess=null）
 * - 都没有：无 owner 会话 → 401 session；有会话 → 403 door（前端回到门口重新验证）
 *
 * @param {any} request
 * @param {any} env
 * @param {{allowReset?: boolean}} [opts]
 * @returns {Promise<{ok:true, dv:{ok:boolean, by?:string, exp?:number}, door:string, isLockreset:boolean, sess:any}|{ok:false, status:number, body:object}>}
 */
export async function checkLockDoor(request, env, opts) {
  const allowReset = !!(opts && opts.allowReset);
  const dv = await verifyDoorCookie(request, env, DOOR_LOCK);
  if (!dv.ok && allowReset) {
    const rv = await verifyDoorCookie(request, env, DOOR_LOCKRESET);
    if (rv.ok) return { ok: true, dv: rv, door: DOOR_LOCKRESET, isLockreset: true, sess: null };
  }
  const sess = await verifySessionDetailed(request, env);
  if (!sess.ok || sess.role !== ROLE_OWNER) {
    return { ok: false, status: 401, body: { ok: false, error: 'session' } };
  }
  if (!dv.ok) {
    return { ok: false, status: 403, body: { ok: false, error: 'door', reason: dv.reason } };
  }
  if (sess.by === 'root') {
    const kv = env && env.OWNER_KV;
    if (await isLayerConfigured(kv, LAYER_LOCK)) {
      return { ok: false, status: 403, body: { ok: false, error: 'by-root' } };
    }
  }
  return { ok: true, dv: dv, door: DOOR_LOCK, isLockreset: false, sess: sess };
}

/**
 * 访客会话（只看 role 段，不验签、不读存储）：门口验证对访客一律写死「密码错误」。
 * @param {any} request
 */
export function looksVisitor(request) {
  try {
    const h = request.headers.get('Cookie') || '';
    for (const part of h.split(';')) {
      const kv2 = part.trim().split('=');
      if (kv2[0] === REALM_LOCK.cookie && kv2[1]) {
        const parts = kv2.slice(1).join('=').split('.');
        if (parts.length === 5 && parts[1] === ROLE_VISITOR) return true;
      }
    }
  } catch (e) {}
  return false;
}

/** @param {any} context */
export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return Response.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/** @param {any} context */
async function handlePost(context) {
  const { request, env } = context;
  const kv = env && env.OWNER_KV;
  if (request.method !== 'POST') {
    return Response.json({ ok: false, error: 'method' }, { status: 405 });
  }
  if (!isSameOrigin(request)) return originDenied();

  let body;
  try { body = await request.json(); } catch (e) {
    return Response.json({ ok: false, error: 'body' }, { status: 400 });
  }
  const action = (body && body.action) || '';

  if (action === 'clear') {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    clearDoorCookie(headers);
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  if (action === 'status') {
    if (!kv) return Response.json({ ok: false, error: 'config' }, { status: 500 });
    let door = '';
    let dv = await verifyDoorCookie(request, env, DOOR_LOCK);
    if (dv.ok) door = DOOR_LOCK;
    const sess = await verifySessionDetailed(request, env);
    const isOwner = sess.ok && sess.role === ROLE_OWNER;
    if (!dv.ok) {
      const rv = await verifyDoorCookie(request, env, DOOR_LOCKRESET);
      if (rv.ok) {
        dv = rv;
        door = DOOR_LOCKRESET;
      }
    }
    /* 锁屏门票必须配 owner 会话；重置门票本来就没有会话 */
    if (door === DOOR_LOCK && !isOwner) door = '';
    if (!isOwner && door !== DOOR_LOCKRESET) {
      return Response.json({ ok: false, error: 'session' }, { status: 401 });
    }
    let password = false;
    let passkey = false;
    try {
      const pw = await kv.get(REALM_LOCK.kv.password, 'json');
      password = !!(pw && pw.hash);
      const keys = await getPasskeys(kv);
      passkey = keys.some(function (k) { return (k.class || PK_CLASS_LOCK) === PK_CLASS_LOCK; });
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    const valid = !!door;
    return Response.json({
      ok: true,
      valid: valid,
      door: valid ? door : undefined,
      by: valid ? dv.by : undefined,
      expiresAt: valid ? dv.exp : undefined,
      reason: valid ? undefined : dv.reason,
      password: password,
      passkey: passkey,
    });
  }

  return Response.json({ ok: false, error: 'params' }, { status: 400 });
}
