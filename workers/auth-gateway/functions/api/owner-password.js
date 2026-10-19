/**
 * 2.4.0 I：本人密码解锁 —— 密码设置/修改/验证。
 * fix/hi-owner：PBKDF2 迭代次数 600000 → 100000（Cloudflare Workers 生产环境上限，
 * 超过抛 NotSupportedError）。verify 按记录里的 iterations 校验。
 *
 * 2.11 定稿：双密码。
 * - lock-pw（锁屏密码）：verify 解锁用；管理走 kind=lock（入口 2 scope=keys，
 *   或 scope=lockreset 重置流程）。
 * - owner-pw（站长密码）：入口 2 的密码路径（/api/stepup verify-password）；
 *   管理走 kind=owner（入口 1 scope=root）。
 * - owner 密码不得与锁屏密码相同（双向检查）。
 * - 哈希加 SGX_PW_PEPPER；旧 hash 下次成功登录时重哈希；缺 pepper fail closed。
 *
 * POST /api/owner-password
 * Body: { action: "set"|"change"|"verify"|"remove", kind: "lock"|"owner", ... }
 *
 * - verify: { password } — 锁屏密码解锁验证（只认 lock-pw；IP 限流：5 次失败 → 30 秒锁定）
 * - set/change/remove: 需 kind；set/change 需 pepper
 * 2.8.0：lockout（锁定所有设备）已拆为独立 L2 API /api/lock-all-devices。
 *
 * 密码存储：PBKDF2-SHA256 + 随机 salt + pepper，存 OWNER_KV；恒定时间比较。
 * 会话可吊销：KV 存 session-epoch，Ed25519(SGX_LOCK_PRIVATE) 签进 cookie；
 * 改密码/删密码时 +1，旧 cookie 失效（锁定所有设备走 /api/lock-all-devices）。
 * sgx-verified cookie 的设置/清除统一走 _kernel/session.js（属性只定义一处）。
 * KV 读取出错时抛错→接口返回 503，绝不继续写入。
 * 只接受 POST；校验 Origin；未设置密码时 verify 一律拒绝。
 * 外层 try/catch：任何未捕获异常都返回 JSON { ok:false, error:'server' }，不返回 500 HTML。
 */
import { getPepper, makePasswordRecord, checkPasswordRecord, verifyRealmPassword } from '../_kernel/password.js';
import { REALM_LOCK, REALM_OWNER } from '../_kernel/realms.js';
import {
  issueSessionCookie,
  bumpSessionEpoch,
  reissueSessionWithEpoch,
  ROLE_OWNER,
} from '../_kernel/session.js';
import {
  verifyStepupCookie,
  reissueStepupWithEpoch,
  STEPUP_BY_ROOT,
  STEPUP_BY_OWNER,
  STEPUP_SCOPE_ROOT,
  STEPUP_SCOPE_KEYS,
  STEPUP_SCOPE_LOCKRESET,
} from './stepup.js';
import { verifySessionDetailed } from '../_middleware.js';
import {
  isLayerConfigured,
  setLayerConfigured,
  clearLayerConfigured,
  isOwnerEffectivelyConfigured,
  LAYER_OWNER,
  LAYER_LOCK,
} from '../_kernel/layers.js';
import { getPasskeys, PK_CLASS_OWNER, PK_CLASS_LOCK } from './owner-passkey.js';
import { isSameOrigin, originDenied } from '../_kernel/http.js';

const MAX_FAIL = 5;
const LOCK_MS = 30000;

/* 密码哈希/校验已搬到 _kernel/password.js（各凭证域共用）；这里保留原导出名，调用方不变 */
export { getPepper, makePasswordRecord };

/**
 * 校验 owner 密码（owner-pw）。KV 出错时抛错。
 * @param {any} kv
 * @param {string} pepper
 * @param {string} password
 * @returns {Promise<{ok:boolean, set:boolean, needsRehash:boolean}>}
 */
export async function verifyOwnerPassword(kv, pepper, password) {
  return verifyRealmPassword(kv, REALM_OWNER, pepper, password);
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
  const kv = env && env.OWNER_KV;

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
    const signErr = await issueSessionCookie(env, headers, ROLE_OWNER);
    if (signErr) {
      return new Response(JSON.stringify(signErr.body), {
        status: signErr.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  /* ============ set/change/remove（2.11 定稿） ============
     kind=owner（站长密码）：入口 1，需 stepup(scope=root, by=root)。
     kind=lock（锁屏密码）：入口 2，需 stepup(scope=keys)；owner 未配置时 root 可代管；
       scope=lockreset 可 set/change（重置流程，无会话），不可 remove。
     2.10.2 规则保留：除 lockreset 外，管理操作需 owner 会话 + sgx-stepup。
     2.8.0：lockout 已拆为独立 L2 API /api/lock-all-devices（只认 owner 会话）。 */
  if (action === 'set' || action === 'change' || action === 'remove') {
    const kind = (body && body.kind) || '';
    if (kind !== 'lock' && kind !== 'owner') {
      return Response.json({ ok: false, error: 'params' }, { status: 400 });
    }
    const pwKey = (kind === 'lock' ? REALM_LOCK : REALM_OWNER).kv.password; /* 'lock-pw' | 'owner-pw' */

    /* stepup 门禁（含 scope 检查） */
    const sv = await verifyStepupCookie(request, env);
    if (!sv.ok) {
      return Response.json({ ok: false, error: 'stepup-required', reason: sv.reason }, { status: 403 });
    }
    const isLockreset = sv.scope === STEPUP_SCOPE_LOCKRESET;
    if (kind === 'owner') {
      /* 站长密码：只认入口 1（by=root, scope=root） */
      if (sv.scope !== STEPUP_SCOPE_ROOT || sv.by !== STEPUP_BY_ROOT) {
        return Response.json({ ok: false, error: 'scope' }, { status: 403 });
      }
    } else {
      /* 锁屏密码：scope=keys（by=owner；by=root 需 owner 层未配置）；
         scope=root + by=root 在 owner 未配置时可代管；scope=lockreset 可 set/change */
      if (isLockreset) {
        if (action === 'remove') {
          return Response.json({ ok: false, error: 'scope' }, { status: 403 });
        }
      } else if (sv.scope === STEPUP_SCOPE_KEYS) {
        if (sv.by !== STEPUP_BY_ROOT) {
          /* by=owner：正常入口 2；其他 by 拒绝 */
          if (sv.by !== STEPUP_BY_OWNER) {
            return Response.json({ ok: false, error: 'scope' }, { status: 403 });
          }
        } else {
          /* by=root 的 keys 票：仅 owner 未配置时代管有效 */
          const ownerCfg = await isLayerConfigured(kv, LAYER_OWNER);
          if (ownerCfg) {
            return Response.json({ ok: false, error: 'scope' }, { status: 403 });
          }
        }
      } else if (sv.scope === STEPUP_SCOPE_ROOT && sv.by === STEPUP_BY_ROOT) {
        const ownerCfg = await isLayerConfigured(kv, LAYER_OWNER);
        if (ownerCfg) {
          return Response.json({ ok: false, error: 'scope' }, { status: 403 });
        }
      } else {
        return Response.json({ ok: false, error: 'scope' }, { status: 403 });
      }
    }

    /* 会话门禁：lockreset 重置流程无会话，其余要求有效 owner 会话。
       by=root 的代开会话在 lock 已配置时拒绝（纵深防御；epoch 机制已使其失效）。
       D2：sessP 保留到 remove/set/change，epoch 推进后用它重签当前设备会话。 */
    let sessP = null;
    if (!isLockreset) {
      sessP = await verifySessionDetailed(request, env);
      if (!sessP.ok || sessP.role !== ROLE_OWNER) {
        return Response.json({ ok: false, error: 'session' }, { status: 401 });
      }
      if (sessP.by === 'root') {
        const lockCfg = await isLayerConfigured(kv, LAYER_LOCK);
        if (lockCfg) {
          return Response.json({ ok: false, error: 'by-root' }, { status: 403 });
        }
      }
    }

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
          let ownerCfg = true;
          try {
            ownerCfg = await isOwnerEffectivelyConfigured(kv);
          } catch (e) {
            ownerCfg = true;
          }
          if (!ownerCfg) {
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
      /* 2.11 定稿：root 删除站长密码后，若站长层已无凭证则清除标记；
         推进 session-epoch，避免无声回退到 root 代管 */
      if (kind === 'owner' && sv.by === STEPUP_BY_ROOT) {
        try {
          const keys = await getPasskeys(kv);
          const hasOwnerKey = keys.some(function (k) { return (k.class || 'lock') === PK_CLASS_OWNER; });
          let hasOwnerPw = false;
          try { const r = await kv.get(REALM_OWNER.kv.password, 'json'); hasOwnerPw = !!(r && r.hash); } catch (e) {}
          if (!hasOwnerKey && !hasOwnerPw) {
            /* 清标记失败不吞掉：标记残留会导致 root 无法代管（用户被锁死），直接 503 */
            try {
              await clearLayerConfigured(kv, LAYER_OWNER);
            } catch (e) {
              return Response.json({ ok: false, error: 'server' }, { status: 503 });
            }
          }
        } catch (e) {}
      }
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
            let ownerCfg = true;
            try { ownerCfg = await isOwnerEffectivelyConfigured(kv); } catch (e) { ownerCfg = true; }
            if (!ownerCfg) {
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
         D2：epoch 推进后重签 stepup 票据 + 当前设备会话，保持门内连续操作、当前设备不掉线。 */
      let newEpoch = null;
      try {
        newEpoch = await bumpSessionEpoch(kv);
      } catch (e) {
        return Response.json({ ok: false, error: 'server' }, { status: 503 });
      }
      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (newEpoch !== null) {
        await reissueStepupWithEpoch(env, headers, sv, newEpoch);
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

    /* 2.11 定稿：owner 密码不得与锁屏密码相同（双向检查） */
    try {
      const otherKey = (kind === 'lock' ? REALM_OWNER : REALM_LOCK).kv.password; /* 'owner-pw' | 'lock-pw' */
      const other = await kv.get(otherKey, 'json');
      if (other && other.hash) {
        const cr = await checkPasswordRecord(other, newPassword, pepper);
        if (cr.ok) {
          return Response.json({ ok: false, error: kind === 'lock' ? 'same-as-owner' : 'same-as-lock' }, { status: 403 });
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
       - 首次配 owner：废止 by=root,scope=keys 的票（必修安全项 1）
       - 首次配 lock：废止根凭证代开的解锁会话（必修安全项 2） */
    if (action === 'set') {
      try {
        const layer = kind === 'lock' ? LAYER_LOCK : LAYER_OWNER;
        const was = await isLayerConfigured(kv, layer);
        if (!was) {
          await setLayerConfigured(kv, layer);
        }
      } catch (e) {}
    }

    /* 改密码后：session-epoch +1，旧会话 cookie 失效（KV 出错→503）
       D2：epoch 推进后重签 stepup 票据 + 当前设备会话，保持门内连续操作、当前设备不掉线。 */
    let newEpoch2 = null;
    try {
      newEpoch2 = await bumpSessionEpoch(kv);
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    const headers2 = new Headers({ 'Content-Type': 'application/json' });
    if (newEpoch2 !== null) {
      await reissueStepupWithEpoch(env, headers2, sv, newEpoch2);
      await reissueSessionWithEpoch(env, headers2, sessP, newEpoch2);
    }
    return new Response(JSON.stringify({ ok: true }), { headers: headers2 });
  }

  return Response.json({ ok: false, error: 'action' }, { status: 400 });
}
