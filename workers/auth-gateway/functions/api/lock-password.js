/**
 * 锁屏密码（LockKey 的密码）：解锁验证、进锁屏凭证的门、设置 / 修改 / 删除。
 *
 * 原「站长密码」接口按域拆分：它只管锁屏密码（账号密码早已只在 /api/account 管理，
 * 见 action password-change），所以只拆出本接口，没有另造 /api/account-password。
 * 请求体不再带 kind（路径就是域）。
 *
 * POST /api/lock-password
 * Body: { action: "verify"|"set"|"change"|"remove", ... }
 * - verify { password, door? }：锁屏密码解锁（IP 限速：连错 5 次冷却 30 秒，429 cooldown）；
 *   door:true（有站长会话）不签会话，改签 3 分钟锁屏门票（安全与隐私 → 锁屏凭证的门）
 * - set / change { password }：需锁屏门票（door=lock + 站长会话），或重置锁屏门票（door=lockreset）
 * - remove：只认锁屏门票（重置锁屏不能删）
 * - 锁屏密码不得与账号密码相同（双向检查；账号侧在 /api/account，错误码 same-as-account / same-as-lock）
 * - 哈希：PBKDF2-SHA256 + 随机 salt + SGX_PW_PEPPER（_kernel/password.js）；旧 hash 下次成功登录时重哈希；缺 pepper fail closed
 *
 * 会话可吊销：改密码 / 删密码时 session-epoch +1，旧 cookie 失效；纪元推进后重签门票 + 当前设备会话。
 * 锁定所有设备走 /api/lock-all-devices。KV 读取出错时抛错 → 503，绝不继续写入。
 * 只接受 POST；校验 Origin；未设置密码时 verify 一律拒绝。
 * 外层 try/catch：任何未捕获异常都返回 JSON { ok:false, error:'server' }，不返回 500 HTML。
 */
import { getPepper, makePasswordRecord, checkPasswordRecord, verifyRealmPassword } from '../_kernel/password.js';
import { REALM_LOCK, REALM_ACCOUNT } from '../_kernel/realms.js';
import {
  issueSessionCookie,
  bumpSessionEpoch,
  reissueSessionWithEpoch,
  ROLE_OWNER,
} from '../_kernel/lock-session.js';
import { checkLockManage, looksVisitor } from './lock-reauth.js';
import { issueDoorCookie, reissueDoorWithEpoch, DOOR_LOCK } from '../_kernel/tickets.js';
import { verifySessionDetailed } from '../_middleware.js';
import {
  isLayerConfigured,
  setLayerConfigured,
  clearLayerConfigured,
  isAccountEffectivelyConfigured,
  LAYER_LOCK,
} from '../_kernel/layers.js';
import { getPasskeys, PK_CLASS_LOCK } from '../_kernel/passkey-store.js';
import { isSameOrigin, originDenied } from '../_kernel/http.js';

/* 锁屏密码输错限速：连错 MAX_FAIL 次冷却 COOLDOWN_MS */
const MAX_FAIL = 5;
const COOLDOWN_MS = 30000;

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
  const failKey = REALM_LOCK.kv.passwordFailPrefix + ip;
  const cooldownKey = REALM_LOCK.kv.passwordCooldownPrefix + ip;

  /* 是否在冷却中。KV 出错时抛错（调用方返回 503，fail closed），不静默放行。 */
  async function inCooldown() {
    try {
      const v = await kv.get(cooldownKey);
      if (v && Number(v) > Date.now()) return true;
      if (v) await kv.delete(cooldownKey);
    } catch (e) {
      throw new Error('kv-error');
    }
    return false;
  }

  async function recordFail() {
    try {
      let n = 0;
      const v = await kv.get(failKey);
      if (v) n = Number(v) || 0;
      n++;
      await kv.put(failKey, String(n), { expirationTtl: 3600 });
      if (n >= MAX_FAIL) {
        await kv.put(cooldownKey, String(Date.now() + COOLDOWN_MS), { expirationTtl: 60 });
        await kv.delete(failKey);
        return true; // 刚进入冷却
      }
    } catch (e) {
      throw new Error('kv-error');
    }
    return false;
  }

  async function clearFail() {
    try {
      await kv.delete(failKey);
      await kv.delete(cooldownKey);
    } catch (e) {}
  }

  /* ============ verify：解锁验证（锁屏密码） ============ */
  /* 只认锁屏密码；账号密码不能解锁（各层凭证不互相替代）。 */
  if (action === 'verify') {
    const toDoor = !!(body && body.door === true);
    /* 门口验证：访客写死「密码错误」，不读任何存储；不是站长会话 → 401 session */
    let doorSess = null;
    if (toDoor) {
      if (looksVisitor(request)) {
        return Response.json({ ok: false, error: 'wrong' }, { status: 403 });
      }
      doorSess = await verifySessionDetailed(request, env);
      if (!doorSess.ok || doorSess.role !== ROLE_OWNER) {
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
       绝不静默跳过然后返回 ok:true）。密码验证签站长会话（12 小时） */
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (toDoor) {
      /* 门口：只签锁屏门票（3 分钟），会话不动 */
      const dErr = await issueDoorCookie(env, headers, DOOR_LOCK, 'password');
      if (dErr) return Response.json(dErr.body, { status: dErr.status });
      return new Response(JSON.stringify({ ok: true }), { headers });
    }
    const signErr = await issueSessionCookie(env, headers, ROLE_OWNER);
    if (signErr) {
      return new Response(JSON.stringify(signErr.body), {
        status: signErr.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  /* ============ set/change/remove ============
     需锁屏门票（door=lock，进门可用锁屏凭证或根凭证）+ 站长会话；
     重置锁屏门票（door=lockreset）可 set/change（重置流程，无会话），不可 remove。 */
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
          const keys = await getPasskeys(kv);
          lockKeys = keys.filter(function (k) { return (k.class || PK_CLASS_LOCK) === PK_CLASS_LOCK; });
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
          const keys = await getPasskeys(kv);
          const hasLockKey = keys.some(function (k) { return (k.class || PK_CLASS_LOCK) === PK_CLASS_LOCK; });
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
      /* 会话吊销：session-epoch +1（KV 出错→503，绝不继续）
         纪元推进后重签门票 + 当前设备会话，保持门内连续操作、当前设备不掉线。 */
      let newEpoch = null;
      try {
        newEpoch = await bumpSessionEpoch(kv);
      } catch (e) {
        return Response.json({ ok: false, error: 'server' }, { status: 503 });
      }
      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (newEpoch !== null) {
        await reissueDoorWithEpoch(env, headers, gate.door, gate.dv, newEpoch);
        await reissueSessionWithEpoch(env, headers, sessP, newEpoch);
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

    /* 改密码后：session-epoch +1，旧会话 cookie 失效（KV 出错→503）
       纪元推进后重签门票 + 当前设备会话，保持门内连续操作、当前设备不掉线。 */
    let newEpoch2 = null;
    try {
      newEpoch2 = await bumpSessionEpoch(kv);
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    const headers2 = new Headers({ 'Content-Type': 'application/json' });
    if (newEpoch2 !== null) {
      await reissueDoorWithEpoch(env, headers2, gate.door, gate.dv, newEpoch2);
      await reissueSessionWithEpoch(env, headers2, sessP, newEpoch2);
    }
    return new Response(JSON.stringify({ ok: true }), { headers: headers2 });
  }

  return Response.json({ ok: false, error: 'action' }, { status: 400 });
}
