/**
 * 2.11 定稿：root 代开锁屏会话。
 *
 * 未配置 lock 层凭证时，root 可用根凭证换来的锁屏门票（sgx-door，door=lock，by=root）代开锁屏会话。
 * - 会话与正常 LockKey 解锁相同：12 小时（定稿 #10）
 * - 会话 by=root，标记为代开
 * - lock 层一旦配置自己的凭证，root 代开失效（403）
 * - KV 读取失败按已配置处理（拒绝，fail closed）
 *
 * POST /api/root-session
 * - 需要有效的锁屏门票 door=lock, by=root（不验 owner 会话，
 *   因为代开场景下用户可能还没有任何会话）
 *
 * 只接受 POST；校验 Origin。
 */
import { issueSessionCookie, ROLE_OWNER, BY_ROOT, SESSION_MAX_AGE } from '../_kernel/lock-session.js';
import { verifyDoorCookie, DOOR_LOCK } from '../_kernel/tickets.js';
import { isLockEffectivelyConfigured } from '../_kernel/layers.js';
import { isSameOrigin, originDenied } from '../_kernel/http.js';

/* root 代开的会话时长：与正常解锁相同（12 小时，定稿 #10） */
const ROOT_SESSION_MAX_AGE = SESSION_MAX_AGE;

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
  if (request.method !== 'POST') {
    return Response.json({ ok: false }, { status: 405 });
  }
  /* Origin 必须与本站同 host（CSRF 防护），缺失或解析失败一律 403 */
  if (!isSameOrigin(request)) return originDenied();

  const kv = env && env.KV_LOCK_DOOR;
  if (!kv) {
    return Response.json({ ok: false, error: 'config' }, { status: 500 });
  }

  /* 验门票：必须是锁屏门票，且 by=root */
  const st = await verifyDoorCookie(request, env, DOOR_LOCK);
  if (!st.ok) {
    return Response.json({ ok: false, error: 'door', reason: st.reason }, { status: 403 });
  }
  if (st.by !== 'root') {
    return Response.json({ ok: false, error: 'scope' }, { status: 403 });
  }

  /* 检查 lock 层是否有效已配置：标记或真实凭证任一存在、或读取失败，
     都算已配置，root 代开失效（与 root-auth / lock-config 同口径）。 */
  let lockConfigured = true;
  try {
    lockConfigured = await isLockEffectivelyConfigured(kv);
  } catch (e) {
    lockConfigured = true;
  }
  if (lockConfigured) {
    return Response.json({ ok: false, error: 'configured' }, { status: 403 });
  }

  /* 签发 by=root 的 owner 会话，约 12 小时（ROOT_SESSION_MAX_AGE=43200，与门票的 3 分钟无关） */
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const sessErr = await issueSessionCookie(env, headers, ROLE_OWNER, BY_ROOT, ROOT_SESSION_MAX_AGE);
  if (sessErr) {
    return new Response(JSON.stringify(sessErr.body), {
      status: sessErr.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: true, by: 'root', takeover: true }), { headers });
}
