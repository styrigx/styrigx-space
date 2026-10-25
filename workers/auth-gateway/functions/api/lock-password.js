/**
 * 锁屏密码（LockKey 的密码）：解锁验证、进锁屏凭证的门、设置 / 修改 / 删除。
 *
 * 原「管理员密码」接口按域拆分：它只管锁屏密码（账号密码早已只在 /api/account 管理，
 * 见 action password-change），所以只拆出本接口，没有另造 /api/account-password。
 * 请求体不再带 kind（路径就是域）。
 *
 * POST /api/lock-password
 * Body: { action: "verify"|"set"|"change"|"remove", ... }
 * - verify { password, reauth? }：锁屏密码解锁（IP 限速：连错 5 次冷却 30 秒，429 cooldown）；
 *   reauth:true（有 admin 锁屏会话）不签会话，改签 3 分钟 LockReauthTicket（安全与隐私 → 锁屏凭证）
 * - set / change { password }：需 LockReauthTicket + admin 锁屏会话，或 LockResetTicket
 * - remove：只认 LockReauthTicket（重置锁屏不能删）
 * - 锁屏密码不得与账号密码相同（双向检查；账号侧在 /api/account，错误码 same-as-account / same-as-lock）
 * - 哈希：PBKDF2-SHA256 + 随机 salt + SGX_PW_PEPPER（_kernel/password.js）；旧 hash 下次成功登录时重哈希；缺 pepper fail closed
 *
 * 会话可吊销：改密码 / 删密码时 lock-epoch +1，旧 cookie 失效；纪元推进后重签 reauth / reset 票 + 当前设备会话。
 * 锁定所有设备走 /api/lock-all-devices。KV 读取出错时抛错 → 503，绝不继续写入。
 * 只接受 POST；校验 Origin；未设置密码时 verify 一律拒绝。
 * 外层 try/catch：任何未捕获异常都返回 JSON { ok:false, error:'server' }，不返回 500 HTML。
 */
import { getPepper, makePasswordRecord, checkPasswordRecord, verifyRealmPassword } from '../_kernel/password.js';
import { REALM_LOCK, REALM_ACCOUNT } from '../_kernel/realms.js';
import {
  issueLockSession,
  bumpLockEpoch,
  reissueLockSessionWithEpoch,
  ROLE_ADMIN,
} from '../_kernel/lock-session.js';
import { checkLockManage, looksVisitor } from './lock-reauth.js';
import { issueTicket, reissueTicketWithEpoch } from '../_kernel/tickets.js';
import { LOCK_REAUTH_TICKET, BY_PASSWORD } from '../_kernel/realms.js';
import { verifyLockSession } from '../_kernel/lock-session.js';
import {
  isLayerConfigured,
  setLayerConfigured,
  clearLayerConfigured,
  isAccountEffectivelyConfigured,
  LAYER_LOCK,
} from '../_kernel/layers.js';
import { getPasskeys, PASSKEY_LOCK } from '../_kernel/passkey-store.js';
import { isSameOrigin, originDenied } from '../_kernel/http.js';
import { passwordLimiter } from '../_kernel/password-limit.js';


/** @param {any} context */
export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    /* 任何未捕获异常 → JSON 500，前端可区分「服务器错误」与「网络错误」 */
    return Response.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/** @param {any} context */
async function handlePost(context) {
  const { request, env } = context;
  const kv = env && env.KV_LOCK_DOOR;

  if (request.method !== 'POST') {
    return Response.json({ ok: false, error: 'method' }, { status: 405 });
  }
  /* Origin 必须与本站同 host（CSRF 防护），缺失或解析失败一律 403 */
  if (!isSameOrigin(request)) return originDenied();
  if (!kv) {
    return Response.json({ ok: false, error: 'config' }, { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Response.json({ ok: false, error: 'body' }, { status: 400 });
  }
  const action = (body && body.action) || '';

  /* 客户端 IP（限流用） */
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const limiter = passwordLimiter(kv, REALM_LOCK, ip);
  const inCooldown = limiter.inCooldown;
  const recordFail = limiter.recordFail;
  const clearFail = limiter.clearFail;

  /* ============ verify：解锁验证（锁屏密码） ============ */
  /* 只认锁屏密码；账号密码不能解锁（各层凭证不互相替代）。 */
  if (action === 'verify') {
    const toReauth = !!(body && body.reauth === true);
    /* 再验证：访客写死「密码错误」，不读任何存储；不是admin 会话 → 401 session */
    let reauthSess = null;
    if (toReauth) {
      if (looksVisitor(request)) {
        return Response.json({ ok: false, error: 'wrong' }, { status: 403 });
      }
      reauthSess = await verifyLockSession(request, env);
      if (!reauthSess.ok || reauthSess.role !== ROLE_ADMIN) {
        return Response.json({ ok: false, error: 'session' }, { status: 401 });
      }
    }
    let cooling = false;
    try {
      cooling = await inCooldown();
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    if (cooling) {
      return Response.json({ ok: false, error: 'cooldown' }, { status: 429 });
    }
    const password = (body && body.password) || '';
    if (!password || typeof password !== 'string') {
      return Response.json({ ok: false, error: 'password' }, { status: 400 });
    }
    /* 缺 pepper 时 fail closed（拒绝校验，不降级） */
    const pepper = getPepper(env);
    if (!pepper) {
      return Response.json({ ok: false, error: 'config' }, { status: 503 });
    }
    let vr;
    try {
      vr = await verifyRealmPassword(kv, REALM_LOCK, pepper, password);
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    if (!vr.set) {
      return Response.json({ ok: false, error: 'not-set' }, { status: 403 });
    }
    if (!vr.ok) {
      let justCooled = false;
      try {
        justCooled = await recordFail();
      } catch (e) {
        return Response.json({ ok: false, error: 'server' }, { status: 503 });
      }
      return Response.json(
        { ok: false, error: justCooled ? 'cooldown' : 'wrong' },
        { status: justCooled ? 429 : 403 }
      );
    }
    await clearFail();
    /* 旧 hash 成功验证后重哈希（加 pepper），写回锁屏密码 */
    if (vr.needsRehash) {
      try {
        await kv.put(REALM_LOCK.kv.password, JSON.stringify(await makePasswordRecord(password, pepper)));
      } catch (e) {}
    }
    /* 通过：签发 Ed25519 会话 cookie（fail closed：无密钥/签发失败 → 5xx，
       绝不静默跳过然后返回 ok:true）。密码验证签admin 会话（12 小时） */
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (toReauth) {
      /* 再验证：只签 LockReauthTicket（3 分钟），会话不动 */
      const dErr = await issueTicket(env, headers, LOCK_REAUTH_TICKET, BY_PASSWORD);
      if (dErr) return Response.json(dErr.body, { status: dErr.status });
      return new Response(JSON.stringify({ ok: true }), { headers });
    }
    const signErr = await issueLockSession(env, headers, { by: BY_PASSWORD, role: ROLE_ADMIN });
    if (signErr) {
      return new Response(JSON.stringify(signErr.body), {
        status: signErr.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  /* ============ set/change/remove ============
     需 LockReauthTicket（锁屏凭证或根凭证再验证）+ admin 锁屏会话；
     LockResetTicket 可 set/change（重置流程，无会话），不可 remove。 */
  if (action === 'set' || action === 'change' || action === 'remove') {
    const passwordKey = REALM_LOCK.kv.password;

    /* 门禁。sess 保留到 remove/set/change，纪元推进后用它重签当前设备会话。 */
    const gate = await checkLockManage(request, env, { allowReset: action !== 'remove' });
    if (!gate.ok) {
      return Response.json(gate.body, { status: gate.status });
    }
    const sessP = gate.sess;

    /* 缺 pepper 时 fail closed（set/change；remove 不需要） */
    const pepper = getPepper(env);
    if (action !== 'remove' && !pepper) {
      return Response.json({ ok: false, error: 'config' }, { status: 503 });
    }

    /* remove：删除密码，同时清掉失败计数和锁定 */
    if (action === 'remove') {
      /* A-2：删锁屏密码且删后锁屏凭证归零（无锁屏通行密钥）时，
         只在账号已有效配置时允许；账号未配置时 403 last-key。
         检查在任何 mutation 之前。 */
      {
        let lockKeys = [];
        try {
          lockKeys = await getPasskeys(kv, PASSKEY_LOCK);
        } catch (e) {}
        if (lockKeys.length === 0) {
          let accountCfg = true;
          try {
            accountCfg = await isAccountEffectivelyConfigured(kv);
          } catch (e) {
            accountCfg = true;
          }
          if (!accountCfg) {
            return Response.json({ ok: false, error: 'last-key' }, { status: 403 });
          }
        }
      }
      try {
        await kv.delete(passwordKey);
      } catch (e) {
        return Response.json({ ok: false, error: 'server' }, { status: 503 });
      }
      /* 清掉所有输错计数和冷却记录（IP 限速残留） */
      for (const prefix of [REALM_LOCK.kv.passwordFailPrefix, REALM_LOCK.kv.passwordCooldownPrefix]) {
        try {
          const list = await kv.list({ prefix: prefix });
          for (const k of list.keys || []) { try { await kv.delete(k.name); } catch (e) {} }
        } catch (e) {}
      }
      {
        try {
          const hasLockKey = (await getPasskeys(kv, PASSKEY_LOCK)).length > 0;
          let hasLockPw = false;
          try { const r = await kv.get(REALM_LOCK.kv.password, 'json'); hasLockPw = !!(r && r.hash); } catch (e) {}
          if (!hasLockKey && !hasLockPw) {
            /* A-2：删光锁屏凭证且账号已配置 → 保留锁屏层标记不清；
               账号未配置时（竞态）清锁屏层标记。 */
            let accountCfg = true;
            try { accountCfg = await isAccountEffectivelyConfigured(kv); } catch (e) { accountCfg = true; }
            if (!accountCfg) {
              try {
                await clearLayerConfigured(kv, LAYER_LOCK);
              } catch (e) {
                return Response.json({ ok: false, error: 'server' }, { status: 503 });
              }
            }
          }
        } catch (e) {}
      }
      /* 会话吊销：lock-epoch +1（KV 出错→503，绝不继续）
         纪元推进后重签 reauth / reset 票 + 当前设备会话，保持门内连续操作、当前设备不掉线。 */
      let newEpoch = null;
      try {
        newEpoch = await bumpLockEpoch(kv);
      } catch (e) {
        return Response.json({ ok: false, error: 'server' }, { status: 503 });
      }
      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (newEpoch !== null) {
        await reissueTicketWithEpoch(env, headers, gate.ticket, gate.tv, newEpoch);
        await reissueLockSessionWithEpoch(env, headers, sessP, newEpoch);
      }
      return new Response(JSON.stringify({ ok: true }), { headers });
    }

    const newPassword = (body && (body.password || body.newPassword)) || '';
    if (!newPassword || typeof newPassword !== 'string') {
      return Response.json({ ok: false, error: 'params' }, { status: 400 });
    }
    if (newPassword.length < 8) {
      return Response.json({ ok: false, error: 'short' }, { status: 400 });
    }

    /* set：未设置过才能设 */
    if (action === 'set') {
      let existing = null;
      try { existing = await kv.get(passwordKey, 'json'); } catch (e) {}
      if (existing && existing.hash) {
        return Response.json({ ok: false, error: 'exists' }, { status: 403 });
      }
    }

    /* 锁屏密码不得与账号密码相同（双向检查；账号侧见 /api/account 的 same-as-lock）。 */
    try {
      const other = await kv.get(REALM_ACCOUNT.kv.password, 'json');
      if (other && other.hash) {
        const cr = await checkPasswordRecord(other, newPassword, pepper);
        if (cr.ok) {
          return Response.json({ ok: false, error: 'same-as-account' }, { status: 403 });
        }
      }
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }

    /* 哈希并存储（peppered 标记） */
    try {
      await kv.put(passwordKey, JSON.stringify(await makePasswordRecord(newPassword, pepper)));
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }

    /* 首次配置锁屏层时标记（随后的纪元推进废止根凭证代开的解锁会话，必修安全项 2） */
    if (action === 'set') {
      try {
        const layer = LAYER_LOCK;
        const was = await isLayerConfigured(kv, layer);
        if (!was) {
          await setLayerConfigured(kv, layer);
        }
      } catch (e) {}
    }

    /* 改密码后：lock-epoch +1，旧会话 cookie 失效（KV 出错→503）
       纪元推进后重签 reauth / reset 票 + 当前设备会话，保持门内连续操作、当前设备不掉线。 */
    let newEpoch2 = null;
    try {
      newEpoch2 = await bumpLockEpoch(kv);
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    const headers2 = new Headers({ 'Content-Type': 'application/json' });
    if (newEpoch2 !== null) {
      await reissueTicketWithEpoch(env, headers2, gate.ticket, gate.tv, newEpoch2);
      await reissueLockSessionWithEpoch(env, headers2, sessP, newEpoch2);
    }
    return new Response(JSON.stringify({ ok: true }), { headers: headers2 });
  }

  return Response.json({ ok: false, error: 'action' }, { status: 400 });
}
