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
import { b64enc, b64dec, timingSafeEqual } from '../_kernel/crypto.js';
import {
  issueSessionCookie,
  bumpSessionEpoch,
  ROLE_OWNER,
} from '../_kernel/session.js';
import {
  verifyStepupCookie,
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
  LAYER_OWNER,
  LAYER_LOCK,
} from '../_kernel/layers.js';
import { getPasskeys, PK_CLASS_OWNER } from './owner-passkey.js';

const ITERATIONS = 100000; // Workers PBKDF2 上限（实测：超过抛 NotSupportedError）
const SALT_LEN = 16;
const KEY_LEN = 32; // 256 bit
const MAX_FAIL = 5;
const LOCK_MS = 30000;
/**
 * 2.11：密码哈希加 pepper（SGX_PW_PEPPER）。
 * pepper 为空时按无 pepper 哈希（仅用于校验旧 hash；新 hash 必须有 pepper，
 * 调用方负责 fail closed）。
 * @param {string} password
 * @param {Uint8Array} salt
 * @param {number} iterations
 * @param {string} pepper
 */
async function hashPassword(password, salt, iterations, pepper) {
  const enc = new TextEncoder();
  const pwd = pepper ? password + pepper : password;
  const key = await crypto.subtle.importKey('raw', enc.encode(pwd), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
    key,
    KEY_LEN * 8
  );
  return bits;
}

/**
 * 获取 pepper；缺失时返回空（调用方 fail closed）。
 * @param {any} env
 */
export function getPepper(env) {
  return (env && env.SGX_PW_PEPPER) || '';
}

/**
 * 校验一把密码（2.11 定稿抽出，供 /api/stepup verify-password 和 /api/lockreset 复用）。
 * - stored 为空 → { ok:false, set:false }
 * - peppered 记录：带 pepper 校验
 * - 旧记录（无 peppered 标记）：按无 pepper 校验，成功则 needsRehash=true
 * KV 读取出错时抛错（调用方返回 503）。
 * @param {object|null} stored kv.get(key,'json') 的结果
 * @param {string} password
 * @param {string} pepper
 * @returns {Promise<{ok:boolean, set:boolean, needsRehash:boolean}>}
 */
export async function checkPasswordRecord(stored, password, pepper) {
  if (!stored || !stored.salt || !stored.hash) {
    return { ok: false, set: false, needsRehash: false };
  }
  const iters = (stored.iterations && Number(stored.iterations)) || ITERATIONS;
  const salt = new Uint8Array(b64dec(stored.salt));
  if (stored.peppered) {
    const bits = await hashPassword(password, salt, iters, pepper);
    const ok = await timingSafeEqual(b64enc(bits), stored.hash);
    return { ok, set: true, needsRehash: false };
  }
  const bits = await hashPassword(password, salt, iters, '');
  const ok = await timingSafeEqual(b64enc(bits), stored.hash);
  return { ok, set: true, needsRehash: ok };
}

/**
 * 生成一条新的 peppered 密码记录。
 * @param {string} password
 * @param {string} pepper
 */
export async function makePasswordRecord(password, pepper) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const bits = await hashPassword(password, salt, ITERATIONS, pepper);
  return {
    salt: b64enc(salt.buffer),
    hash: b64enc(bits),
    iterations: ITERATIONS,
    peppered: true,
    updatedAt: Date.now(),
  };
}

/**
 * 校验 owner 密码（owner-pw）。KV 出错时抛错。
 * @param {any} kv
 * @param {string} pepper
 * @param {string} password
 * @returns {Promise<{ok:boolean, set:boolean, needsRehash:boolean}>}
 */
export async function verifyOwnerPassword(kv, pepper, password) {
  const stored = await kv.get('owner-pw', 'json'); /* 出错直接抛 */
  return checkPasswordRecord(stored, password, pepper);
}

/**
 * 校验锁屏密码（lock-pw）。KV 出错时抛错。
 * @param {any} kv
 * @param {string} pepper
 * @param {string} password
 * @returns {Promise<{ok:boolean, set:boolean, needsRehash:boolean}>}
 */
export async function verifyLockPassword(kv, pepper, password) {
  const stored = await kv.get('lock-pw', 'json'); /* 出错直接抛 */
  return checkPasswordRecord(stored, password, pepper);
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
  /* 2.10.2：Origin 必须存在、可解析且 host 一致（CSRF 防护）；
     缺失或解析失败一律 403，不再放行。 */
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
        await kv.put('lock-pw', JSON.stringify(await makePasswordRecord(password, pepper)));
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
    const pwKey = kind === 'lock' ? 'lock-pw' : 'owner-pw';

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
       by=root 的代开会话在 lock 已配置时拒绝（纵深防御；epoch 机制已使其失效）。 */
    if (!isLockreset) {
      const sessP = await verifySessionDetailed(request, env);
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
          try { const r = await kv.get('owner-pw', 'json'); hasOwnerPw = !!(r && r.hash); } catch (e) {}
          if (!hasOwnerKey && !hasOwnerPw) {
            try { await clearLayerConfigured(kv, LAYER_OWNER); } catch (e) {}
          }
        } catch (e) {}
      }
      if (kind === 'lock') {
        try {
          const keys = await getPasskeys(kv);
          const hasLockKey = keys.some(function (k) { return (k.class || 'lock') === 'lock'; });
          let hasLockPw = false;
          try { const r = await kv.get('lock-pw', 'json'); hasLockPw = !!(r && r.hash); } catch (e) {}
          if (!hasLockKey && !hasLockPw) {
            try { await clearLayerConfigured(kv, LAYER_LOCK); } catch (e) {}
          }
        } catch (e) {}
      }
      /* 会话吊销：session-epoch +1（KV 出错→503，绝不继续） */
      try {
        await bumpSessionEpoch(kv);
      } catch (e) {
        return Response.json({ ok: false, error: 'server' }, { status: 503 });
      }
      /* 2.10.0：删除密码成功后立即清除 sgx-stepup */
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': 'sgx-stepup=; Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
        },
      });
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
      const otherKey = kind === 'lock' ? 'owner-pw' : 'lock-pw';
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

    /* 改密码后：session-epoch +1，旧会话 cookie 失效（KV 出错→503） */
    try {
      await bumpSessionEpoch(kv);
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    /* 2.10.0：改密码成功后立即清除 sgx-stepup（set 为首次设置，不清除） */
    if (action === 'change') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': 'sgx-stepup=; Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
        },
      });
    }
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: 'action' }, { status: 400 });
}
