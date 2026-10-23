/**
 * 2.4.0 I：本人密码解锁 —— 密码设置/修改/验证。
 * fix/hi-owner：PBKDF2 迭代次数 600000 → 100000（Cloudflare Workers 生产环境上限，
 * 超过抛 NotSupportedError）。verify 按记录里的 iterations 校验。
 *
 * 2.11 定稿：双密码；账号体系后：
 * - lock-pw（锁屏密码）：verify 解锁用；verify 带 door:true 时（有 owner 会话）不签会话，改签
 *   3 分钟锁屏门票（安全与隐私 → 锁屏凭证的门）；管理走 kind=lock（锁屏门票 door=lock，
 *   或重置锁屏门票 door=lockreset）。
 * - owner-pw（账号密码，原站长密码）：账号登录的密码入口；只在账号页管理
 *   （/api/account），本接口不再接受 kind=owner。
 * - 锁屏密码不得与账号密码相同（双向检查；账号侧在 /api/account）。
 * - 哈希加 SGX_PW_PEPPER；旧 hash 下次成功登录时重哈希；缺 pepper fail closed。
 *
 * POST /api/owner-password
 * Body: { action: "set"|"change"|"verify"|"remove", kind: "lock", ... }
 *
 * - verify: { password } — 锁屏密码解锁验证（只认 lock-pw；IP 限流：5 次失败 → 30 秒锁定）
 * - set/change/remove: 需 kind；set/change 需 pepper
 * 2.8.0：lockout（锁定所有设备）已拆为独立 L2 API /api/lock-all-devices。
 *
 * 密码存储：PBKDF2-SHA256 + 随机 salt + pepper，存 KV_LOCK_DOOR；恒定时间比较。
 * 会话可吊销：KV 存 session-epoch，Ed25519(SGX_LOCK_PRIVATE) 签进 cookie；
 * 改密码/删密码时 +1，旧 cookie 失效（锁定所有设备走 /api/lock-all-devices）。
 * sgx-verified cookie 的设置/清除统一走 _kernel/session.js（属性只定义一处）。
 * KV 读取出错时抛错→接口返回 503，绝不继续写入。
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
} from '../_kernel/session.js';
import { checkLockDoor, looksVisitor } from './lock-door.js';
import { issueDoorCookie, reissueDoorWithEpoch, DOOR_LOCK } from '../_kernel/door.js';
import { verifySessionDetailed } from '../_middleware.js';
import {
  isLayerConfigured,
  setLayerConfigured,
  clearLayerConfigured,
  isAccountEffectivelyConfigured,
  LAYER_LOCK,
} from '../_kernel/layers.js';
import { getPasskeys, PK_CLASS_LOCK } from './owner-passkey.js';
import { isSameOrigin, originDenied } from '../_kernel/http.js';

const MAX_FAIL = 5;
const LOCK_MS = 30000;

/* 密码哈希/校验已搬到 _kernel/password.js（各凭证域共用）；这里保留原导出名，调用方不变 */
export { getPepper, makePasswordRecord };

/**
 * 校验账号密码（owner-pw，原站长密码）。KV 出错时抛错。
 * 账号登录（/api/account）与重置锁屏（/api/lockreset）共用。
 * @param {any} kv
 * @param {string} pepper
 * @param {string} password
 * @returns {Promise<{ok:boolean, set:boolean, needsRehash:boolean}>}
 */
export async function verifyAccountPassword(kv, pepper, password) {
  return verifyRealmPassword(kv, REALM_ACCOUNT, pepper, password);
}

/**
 * 校验锁屏密码（lock-pw）。KV 出错时抛错。
 * @param {any} kv
 * @param {string} pepper
 * @param {string} password
 * @returns {Promise<{ok:boolean, set:boolean, needsRehash:boolean}>}
 */
async function verifyLockPassword(kv, pepper, password) {
  return verifyRealmPassword(kv, REALM_LOCK, pepper, password);
}

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
  const failKey = 'pw-fail:' + ip;
  const lockKey = 'pw-lock:' + ip;

  /* 检查是否被锁定。2.10.2：KV 出错时抛错（调用方返回 503，fail closed），
     不再静默放行。 */
  async function isLocked() {
    try {
      const v = await kv.get(lockKey);
      if (v && Number(v) > Date.now()) return true;
      if (v) await kv.delete(lockKey);
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
        await kv.put(lockKey, String(Date.now() + LOCK_MS), { expirationTtl: 60 });
        await kv.delete(failKey);
        return true; // 刚被锁定
      }
    } catch (e) {
      throw new Error('kv-error');
    }
    return false;
  }

  async function clearFail() {
    try {
      await kv.delete(failKey);
      await kv.delete(lockKey);
    } catch (e) {}
  }

  /* ============ verify：解锁验证（锁屏密码） ============ */
  /* 2.11 定稿：只认 lock-pw（锁屏密码）；owner 密码不能解锁（各层凭证不互相替代）。 */
  if (action === 'verify') {
    const toDoor = !!(body && body.door === true);
    /* 门口验证：访客写死「密码错误」，不读任何存储；不是 owner 会话 → 401 session */
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
    let locked = false;
    try {
      locked = await isLocked();
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    if (locked) {
      return Response.json({ ok: false, error: 'locked' }, { status: 429 });
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
      vr = await verifyLockPassword(kv, pepper, password);
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    if (!vr.set) {
      return Response.json({ ok: false, error: 'not-set' }, { status: 403 });
    }
    if (!vr.ok) {
      let justLocked = false;
      try {
        justLocked = await recordFail();
      } catch (e) {
        return Response.json({ ok: false, error: 'server' }, { status: 503 });
      }
      return Response.json(
        { ok: false, error: justLocked ? 'locked' : 'wrong' },
        { status: justLocked ? 429 : 403 }
      );
    }
    await clearFail();
    /* 旧 hash 成功验证后重哈希（加 pepper），写回 lock-pw */
    if (vr.needsRehash) {
      try {
        await kv.put(REALM_LOCK.kv.password, JSON.stringify(await makePasswordRecord(password, pepper)));
      } catch (e) {}
    }
    /* 通过：签发 Ed25519 会话 cookie（fail closed：无密钥/签发失败 → 5xx，
       绝不静默跳过然后返回 ok:true）
       2.8.0：密码验证签 owner（12 小时） */
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

  /* ============ set/change/remove（2.11 定稿；账号体系后只剩 kind=lock） ============
     kind=owner（账号密码）已移到 /api/account（只在账号页管理）→ 这里 400 params。
     kind=lock（锁屏密码）：需锁屏门票（door=lock，进门可用锁屏凭证或根凭证）+ owner 会话；
       重置锁屏门票（door=lockreset）可 set/change（重置流程，无会话），不可 remove。
     2.8.0：lockout 已拆为独立 L2 API /api/lock-all-devices（只认 owner 会话）。 */
  if (action === 'set' || action === 'change' || action === 'remove') {
    const kind = (body && body.kind) || '';
    if (kind !== 'lock') {
      return Response.json({ ok: false, error: 'params' }, { status: 400 });
    }
    const pwKey = REALM_LOCK.kv.password; /* 'lock-pw' */

    /* 锁屏门禁：锁屏门票（+ owner 会话），或重置锁屏门票（只能 set/change，不能 remove）。
       sessP 保留到 remove/set/change，纪元推进后用它重签当前设备会话。 */
    const gate = await checkLockDoor(request, env, { allowReset: action !== 'remove' });
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
      /* A-2：删 lock 密码且删后锁屏凭证归零（无 lock 钥匙）时，
         只在 owner 已有效配置时允许；owner 未配置时 403 last-key。
         检查在任何 mutation 之前。 */
      if (kind === 'lock') {
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
        await kv.delete(pwKey);
      } catch (e) {
        return Response.json({ ok: false, error: 'server' }, { status: 503 });
      }
      /* 清掉所有 pw-fail:* 和 pw-lock:*（IP 限流残留） */
      try {
        const list = await kv.list({ prefix: 'pw-fail:' });
        for (const k of list.keys || []) { try { await kv.delete(k.name); } catch (e) {} }
      } catch (e) {}
      try {
        const list = await kv.list({ prefix: 'pw-lock:' });
        for (const k of list.keys || []) { try { await kv.delete(k.name); } catch (e) {} }
      } catch (e) {}
      if (kind === 'lock') {
        try {
          const keys = await getPasskeys(kv);
          const hasLockKey = keys.some(function (k) { return (k.class || 'lock') === 'lock'; });
          let hasLockPw = false;
          try { const r = await kv.get(REALM_LOCK.kv.password, 'json'); hasLockPw = !!(r && r.hash); } catch (e) {}
          if (!hasLockKey && !hasLockPw) {
            /* A-2：删光 lock 凭证且 owner 已配置 → 保留 layer:lock 不清；
               owner 未配置时（竞态）按旧逻辑清 layer:lock。
               layer:lock-emptied 是 B #10 的键，A-2 不读不写。 */
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
      try { existing = await kv.get(pwKey, 'json'); } catch (e) {}
      if (existing && existing.hash) {
        return Response.json({ ok: false, error: 'exists' }, { status: 403 });
      }
    }

    /* 2.11 定稿：锁屏密码不得与账号密码相同（双向检查；账号侧见 /api/account）。
       错误码 same-as-owner 保留原名（前端文案已改为「账号密码」）。 */
    try {
      const other = await kv.get(REALM_ACCOUNT.kv.password, 'json'); /* 'owner-pw' */
      if (other && other.hash) {
        const cr = await checkPasswordRecord(other, newPassword, pepper);
        if (cr.ok) {
          return Response.json({ ok: false, error: 'same-as-owner' }, { status: 403 });
        }
      }
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }

    /* 哈希并存储（peppered 标记） */
    try {
      await kv.put(pwKey, JSON.stringify(await makePasswordRecord(newPassword, pepper)));
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }

    /* 2.11 定稿：首次配置某层时标记 + 推进 session-epoch
       - 首次配 lock：废止根凭证代开的解锁会话（必修安全项 2） */
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
