/**
 * 批次 B #16：新站启动模式（取代 2.11「根凭证代开锁屏 = 与锁屏解锁同等会话」）。
 *
 * 仅当 owner 与 lock 两层真实凭证都为 0（启动站）时，root 可用
 * stepup(by=root, scope=root) 签发「启动会话」（by=startup，30 分钟），
 * 只能访问 设置 → 安全与隐私 及其中配置 ownerkey/lockkey 所需的页面与接口
 * （middleware 按 by=startup 收窄权限）；桌面、文件、应用等一律拒绝。
 * 任一层有效配置后，root-session 一律 403（根凭证只参与重置锁屏）。
 * - 启动会话不是 owner 完整会话；进门仍需 stepup。
 * - KV 读取失败按已配置处理（拒绝，fail closed）。
 *
 * POST /api/root-session
 * - 需要有效的 stepup(by=root, scope=root) cookie（不验 owner 会话，
 *   因为启动场景下用户可能还没有任何会话）
 *
 * 只接受 POST；校验 Origin。
 */
import { issueSessionCookie, ROLE_OWNER, BY_STARTUP, STARTUP_MAX_AGE } from '../_kernel/session.js';
import { verifyStepupCookie, STEPUP_BY_ROOT, STEPUP_SCOPE_ROOT } from './stepup.js';
import { isBootstrapStation } from '../_kernel/layers.js';

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
  /* Origin 校验 */
  {
    const origin = request.headers.get('Origin') || '';
    let originOk = false;
    try {
      const url = new URL(request.url);
      originOk = !!origin && new URL(origin).host === url.host;
    } catch (e) {
      originOk = false;
    }
    if (!originOk) {
      return Response.json({ ok: false, error: 'origin' }, { status: 403 });
    }
  }

  const kv = env && env.OWNER_KV;
  if (!kv) {
    return Response.json({ ok: false, error: 'config' }, { status: 500 });
  }

  /* 验 stepup：必须是 by=root, scope=root */
  const st = await verifyStepupCookie(request, env);
  if (!st.ok) {
    return Response.json({ ok: false, error: 'stepup' }, { status: 403 });
  }
  if (st.by !== STEPUP_BY_ROOT || st.scope !== STEPUP_SCOPE_ROOT) {
    return Response.json({ ok: false, error: 'scope' }, { status: 403 });
  }

  /* 检查是否为启动站（两层真实凭证都为 0）：任一层有效配置即拒绝，
     根凭证只参与重置锁屏（与 root-auth / lock-config 同口径）。 */
  let bootstrap = false;
  try {
    bootstrap = await isBootstrapStation(kv);
  } catch (e) {
    bootstrap = false;
  }
  if (!bootstrap) {
    return Response.json({ ok: false, error: 'configured' }, { status: 403 });
  }

  /* 签发启动会话（by=startup，30 分钟），不是 owner 完整会话 */
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const sessErr = await issueSessionCookie(env, headers, ROLE_OWNER, BY_STARTUP, STARTUP_MAX_AGE);
  if (sessErr) {
    return new Response(JSON.stringify(sessErr.body), {
      status: sessErr.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: true, by: 'startup', takeover: true }), { headers });
}
