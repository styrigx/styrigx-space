/**
 * 2.4.0 I：Passkey（WebAuthn）注册与验证。
 * fix/hi-owner：
 * - attestationObject 改用完整 CBOR 解析（替代启发式找 authData）。
 * - 支持多个 passkey：KV 每把一个 `owner-passkey:<前12位>`；索引 `owner-passkey-index` 存 credId 数组（避开 list 最终一致）；可列出、删除、重命名。
 * - 外层 try/catch：异常一律返回 JSON { ok:false, error:'server' }。
 * 安全与隐私（Hark 方案）：
 * - attestationObject 是文本键 CBOR map（"fmt"/"attStmt"/"authData"），不用整数键；
 * - COSE key 用 cborDecode 严格解析：校验 1(kty)=2、3(alg)=-7、-1(crv)=1，取 -2/-3 为 x/y；
 * - 校验 authData：rpIdHash == SHA-256(RP_ID)，UP 位必须为 1，记录 UV 位与 signCount；
 * - clientData.origin 严格等于期望 origin（不用 endsWith）；RP_ID/origin 优先读环境变量
 *   （SGX_RP_ID / SGX_ORIGIN），回退到请求 host，保证预览站可注册；
 * - auth 断言：DER→raw 签名转换；校验 rpIdHash、UP 位、origin；signCount 非零时必须递增；
 * - catch 写具体原因到控制台日志，前端仍只返回普通错误；
 * - 会话 cookie 改为 Ed25519 签名 + 过期时间（2.11：旧 HMAC 密钥已移除）。
 *
 * POST /api/owner-passkey
 * - { action: 'challenge', type: 'register'|'auth', pkClass, aud, cid } → 返回 challenge
 *   - register 需要 owner 会话 + sgx-stepup（2.10.1 起无例外，第一把也要）
 *   - auth 不需要（用于锁屏解锁）；app 类走单次 app-auth 记录
 * - { action: 'register', cid, credential } → 验证并追加存储（再验会话+stepup）
 * - { action: 'auth', cid, credential } → 验证断言；lock 签发会话 cookie，
 *   app 签发单次 appCid（供 /api/app-token）
 * - { action: 'list' } → 列出已注册 passkey（需 owner 会话 + sgx-stepup）
 * - { action: 'rename', credId, name } → 重命名设备名（需 owner 会话 + sgx-stepup）
 * - { action: 'delete', credId } → 删除指定 passkey（需 owner 会话 + sgx-stepup；
 *   先推纪元再删，失败 503 且密钥仍在）
 *
 * 只接受 POST；Origin 缺失/解析失败/跨站一律 403。
 *
 * P0-3 安全审计：
 * - 注册和解锁都要求 UV=1（userVerification: required）
 * - RP_ID/ORIGIN 必须配环境变量 SGX_RP_ID/SGX_ORIGIN，不回落
 * - 用户信息由服务端下发：displayName=Sloan Gray, name=owner, rp.name=Styrigx
 * - 固定 user handle（KV owner-user-id），auth 时校验 userHandle
 * - register 带 excludeCredentials 防重复注册
 * - KV 结构：每把一个 key（owner-passkey:<credId前12位>），字段顺序固定
 */
import { b64urlEnc } from '../_kernel/crypto.js';
import {
  b64urlDec,
  randB64,
  cborDecode,
  parseRegAuthData,
  coseToJwk,
  verifyAssertion,
} from '../_kernel/passkey-verify.js';
import {
  issueSessionCookie,
  ROLE_OWNER,
} from '../_kernel/session.js';
import { getApp } from '../_kernel/app-registry.js';
import { verifyStepupCookie, STEPUP_BY_ROOT, STEPUP_BY_OWNER, STEPUP_SCOPE_ROOT, STEPUP_SCOPE_KEYS } from './stepup.js';
import { checkRootTakeover, LAYER_OWNER, LAYER_LOCK, layerApp, setLayerConfigured, clearLayerConfigured, isLayerConfigured } from '../_kernel/layers.js';
import { verifySessionDetailed } from '../_middleware.js';

/* 2.10.0：通行密钥分类；2.11 新增 owner */
export const PK_CLASS_OWNER = 'owner';
export const PK_CLASS_LOCK = 'lock';
export const PK_CLASS_APP = 'app';
/* 所有者显示名（注册参数写死，用户不填） */
export const OWNER_DISPLAY_NAME = 'Sloan Gray';
/* 应用类认证完成后的单次绑定记录前缀（app-token 签发时消费） */
export const APP_AUTH_PREFIX = 'app-auth:';
const APP_AUTH_TTL = 300; /* 5 分钟 */

/* AAGUID → 密码管理器（只用于显示，不参与安全判断） */
const AAGUID_PROVIDERS = {
  'adce0002-35bc-c60a-648b-0b25f5f05522': 'Google 密码管理器',
  'f8a011f3-8c0a-4d15-8006-17111f9edc7d': 'iCloud 钥匙串',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'accced6a-63d0-4ef2-bb6c-7516d463e07f': 'Bitwarden',
  '39a9f8c4-8405-4bc4-8af9-7d616b0df0ab': 'Microsoft',
  /* Samsung Pass AAGUID 需真机确认后填入 */
};

/* randB64 / b64urlDec / cborDecode / parseRegAuthData / coseToJwk / derToRaw /
   checkAssertAuthData / verifyAssertion 已抽到 ../_kernel/passkey-verify.js（登录与 stepup 共用） */

/**
/**
 * 获取所有通行密钥（新结构：每把一个 key）。
 * 索引补建逻辑见 ensureIndex。
 * 2.10.0：幂等迁移——没有 class 字段的旧凭据视为 lock 并写回（重复执行无副作用）。
 */
async function ensureIndex(kv) {
  try {
    let idx = await kv.get('owner-passkey-index', 'json');
    if (Array.isArray(idx)) return idx;
  } catch (e) {}
  /* 索引不存在：一次性补建 */
  const idx = [];
  try {
    const list = await kv.list({ prefix: 'owner-passkey:' });
    for (const k of list.keys || []) {
      try {
        const v = await kv.get(k.name, 'json');
        if (v && v.credId && !idx.includes(v.credId)) idx.push(v.credId);
      } catch (e2) {}
    }
    await kv.put('owner-passkey-index', JSON.stringify(idx));
  } catch (e3) {}
  return idx;
}

/** stepup 复用：按索引读取已注册 passkey（不走 kv.list，避开最终一致延迟） */
export async function getPasskeys(kv) {
  try {
    /* 按索引读，不走 kv.list（避开最终一致延迟） */
    const idx = await ensureIndex(kv);
    const keys = [];
    for (const credId of idx) {
      try {
        const keyName = 'owner-passkey:' + String(credId).slice(0, 12);
        const v = await kv.get(keyName, 'json');
        if (v && v.credId === credId) {
          /* 2.10.0 幂等迁移：无 class 的旧凭据 → lock，写回（重复执行无副作用） */
          if (!v.class) {
            v.class = PK_CLASS_LOCK;
            try { await kv.put(keyName, JSON.stringify(v)); } catch (e2) {}
          }
          keys.push(v);
        }
      } catch (e) {}
    }
    /* 一次性迁移：旧数组结构 → 新结构（含索引补建） */
    if (keys.length === 0) {
      try {
        const old = await kv.get('owner-passkeys', 'json');
        if (Array.isArray(old) && old.length > 0) {
          const newIdx = [];
          for (const item of old) {
            if (item && item.credId) {
              const migrated = {
                name: item.name || '通行密钥',
                provider: item.provider || '',
                aaguid: item.aaguid || '',
                createdAt: item.createdAt || Date.now(),
                lastUsedAt: item.lastUsedAt || 0,
                credId: item.credId,
                publicKey: item.publicKey,
                signCount: item.signCount || 0,
                uv: item.uv ? 1 : 0,
                class: PK_CLASS_LOCK,
              };
              const keyName = 'owner-passkey:' + String(item.credId).slice(0, 12);
              await kv.put(keyName, JSON.stringify(migrated), {
                metadata: { name: migrated.name, provider: migrated.provider, createdAt: migrated.createdAt },
              });
              keys.push(migrated);
              newIdx.push(item.credId);
            }
          }
          await kv.put('owner-passkey-index', JSON.stringify(newIdx));
          await kv.delete('owner-passkeys');
        }
      } catch (e) {}
    }
    return keys;
  } catch (e) {
    return [];
  }
}

/**
 * 保存单把通行密钥。
 * 2.10.0：记录 class（lock/app），应用类还记录 aud。
 * @param {any} kv
 * @param {any} item
 */
async function savePasskey(kv, item) {
  const keyName = 'owner-passkey:' + String(item.credId).slice(0, 12);
  /* 字段顺序固定：name 第一位，方便后台预览 */
  const ordered = {
    name: item.name || '通行密钥',
    provider: item.provider || '',
    aaguid: item.aaguid || '',
    createdAt: item.createdAt || Date.now(),
    lastUsedAt: item.lastUsedAt || 0,
    credId: item.credId,
    publicKey: item.publicKey,
    signCount: item.signCount || 0,
    uv: item.uv ? 1 : 0,
    class: item.class === PK_CLASS_APP ? PK_CLASS_APP : PK_CLASS_LOCK,
  };
  if (ordered.class === PK_CLASS_APP && item.aud) {
    ordered.aud = String(item.aud);
  }
  await kv.put(keyName, JSON.stringify(ordered), {
    metadata: { name: ordered.name, provider: ordered.provider, createdAt: ordered.createdAt },
  });
  /* 同步更新索引（避开 kv.list 的最终一致延迟） */
  try {
    let idx = await kv.get('owner-passkey-index', 'json');
    if (!Array.isArray(idx)) idx = [];
    if (!idx.includes(item.credId)) {
      idx.push(item.credId);
      await kv.put('owner-passkey-index', JSON.stringify(idx));
    }
  } catch (e) {}
  return ordered;
}

/**
 * 删除单把通行密钥。
 * @param {any} kv
 * @param {string} credId
 * @returns {Promise<any|null>} 被删除的记录（调用方据此判断是否推进 app-epoch）
 */
async function deletePasskey(kv, credId) {
  const keyName = 'owner-passkey:' + String(credId).slice(0, 12);
  let rec = null;
  try { rec = await kv.get(keyName, 'json'); } catch (e) {}
  await kv.delete(keyName);
  /* 同步更新索引 */
  try {
    let idx = await kv.get('owner-passkey-index', 'json');
    if (Array.isArray(idx)) {
      idx = idx.filter(id => id !== credId);
      await kv.put('owner-passkey-index', JSON.stringify(idx));
    }
  } catch (e) {}
  return rec;
}

/**
 * 获取或创建固定用户 ID（32 字节随机，存 KV）。
 * 2.10.0：锁屏类用 'owner-user-id'；每个 aud 各一个 'owner-user-id:app:<aud>'，
 * 让密码管理器把它们存成独立条目。
 * @param {any} kv
 * @param {string} [aud] 应用 aud（应用类必填）
 */
async function getUserHandle(kv, aud) {
  const key = aud ? 'owner-user-id:app:' + aud : 'owner-user-id';
  try {
    let uh = await kv.get(key);
    if (!uh) {
      const u8 = crypto.getRandomValues(new Uint8Array(32));
      uh = b64urlEnc(u8);
      await kv.put(key, uh);
    }
    return uh;
  } catch (e) {
    return null;
  }
}

/**
 * 2.10.0：要求有效的 sgx-stepup（安全设置操作门禁）。
 * 2.10.1：返回具体失败原因（补充指令 3），前端可显示。
 * 2.11：返回 by/scope，调用方做 scope 检查。
 * @returns {Promise<{ok:boolean, by:string|null, scope:string|null, reason:string}>}
 */
async function requireStepup(request, env) {
  const r = await verifyStepupCookie(request, env);
  return { ok: !!r.ok, by: r.by || null, scope: r.scope || null, reason: r.reason || 'unknown' };
}

/**
 * 2.11：检查 scope 是否满足操作要求。
 * - 要求 scope=root 的操作：stepup.scope 必须为 root
 * - 要求 scope=keys 的操作：stepup.scope 为 keys，或 (scope=root 且对应层未配置 → takeover)
 * @param {string} requiredScope 'root' | 'keys'
 * @param {{by:string, scope:string}} st
 * @param {any} kv
 * @param {string} layerForTakeover 仅当 requiredScope='keys' 且 st.scope='root' 时检查该层的 takeover
 * @returns {Promise<{ok:boolean, error:string}>}
 */
async function checkScope(requiredScope, st, kv, layerForTakeover) {
  if (!st.ok) return { ok: false, error: 'stepup-required' };
  if (requiredScope === STEPUP_SCOPE_ROOT) {
    if (st.scope !== STEPUP_SCOPE_ROOT) return { ok: false, error: 'scope' };
    return { ok: true };
  }
  /* requiredScope === 'keys' */
  if (st.scope === STEPUP_SCOPE_KEYS) return { ok: true };
  if (st.scope === STEPUP_SCOPE_ROOT && st.by === STEPUP_BY_ROOT) {
    /* root takeover：检查对应层是否未配置 */
    if (!layerForTakeover) return { ok: false, error: 'scope' };
    const t = await checkRootTakeover(kv, layerForTakeover);
    if (!t.allowed) {
      return { ok: false, error: t.reason === 'kv-error' ? 'server' : 'scope' };
    }
    return { ok: true };
  }
  return { ok: false, error: 'scope' };
}

/** 清除 sgx-stepup cookie（敏感操作成功后立即清除） */
function clearStepupCookie(headers) {
  headers.append(
    'Set-Cookie',
    'sgx-stepup=; Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
  );
}

/** app-epoch:<aud> +1（删除应用类通行密钥时调用）。
 * 2.10.1：KV 读写失败必须抛错（调用方 fail closed，拒绝删除），
 * 不再静默按 0 写回。 */
async function bumpAppEpoch(kv, aud) {
  const key = 'app-epoch:' + aud;
  const v = parseInt(await kv.get(key) || '0', 10) || 0;
  await kv.put(key, String(v + 1));
  return v + 1;
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
  if (!kv) return Response.json({ ok: false, error: 'config' }, { status: 500 });

  let body;
  try { body = await request.json(); } catch (e) {
    return Response.json({ ok: false, error: 'body' }, { status: 400 });
  }
  const action = (body && body.action) || '';

  /* RP_ID / 期望 origin：必须设置环境变量，不回落（防配置错误） */
  const RP_ID = env && env.SGX_RP_ID;
  const EXPECT_ORIGIN = env && env.SGX_ORIGIN;
  if (!RP_ID || !EXPECT_ORIGIN) {
    /* 缺变量：返回明确错误（503），前端据此禁用通行密钥入口 */
    return Response.json(
      { ok: false, error: 'config', message: 'SGX_RP_ID / SGX_ORIGIN 未配置' },
      { status: 503 }
    );
  }
  const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RP_ID)));

  /* ============ challenge ============
     2.10.0：新增 pkClass（lock/app）与 aud 参数。
     - type=register, pkClass=lock：需 sgx-stepup，第一把除外
     - type=register, pkClass=app：aud 必须在白名单，否则 400；必须 sgx-stepup（无例外）
     - type=auth, pkClass=lock（默认）：challenge 只列 lock 凭据（锁屏解锁）
     - type=auth, pkClass=app：aud 必须在白名单；challenge 只列该 aud 的 app 凭据
  */
  if (action === 'challenge') {
    const type = (body && body.type) || '';
    if (type !== 'register' && type !== 'auth') {
      return Response.json({ ok: false, error: 'params' }, { status: 400 });
    }
    let pkClass = (body && body.pkClass) || PK_CLASS_LOCK;
    if (pkClass !== PK_CLASS_OWNER && pkClass !== PK_CLASS_LOCK && pkClass !== PK_CLASS_APP) {
      return Response.json({ ok: false, error: 'params' }, { status: 400 });
    }
    let aud = (body && body.aud) || '';
    if (pkClass === PK_CLASS_APP) {
      if (!getApp(aud)) {
        return Response.json({ ok: false, error: 'aud' }, { status: 400 });
      }
    } else {
      aud = '';
    }
    const keys = await getPasskeys(kv);
    const classKeys = keys.filter(function (k) {
      if ((k.class || PK_CLASS_LOCK) !== pkClass) return false;
      if (pkClass === PK_CLASS_APP && k.aud !== aud) return false;
      return true;
    });
    /* register 需要 sgx-stepup：
       - lock：已有 lock 凭据时必须 stepup；第一把除外（否则永远加不上第一把）
       - app：永远需要（无例外，也就意味着必须先有一把 lock 凭据做 stepup） */
    /* 2.10.1：register 必须是 owner 会话（安全漏洞修复）。
       - 任何 register 都要求 owner 会话
       - lock：已有 lock 凭据时必须 stepup；第一把也要求 stepup
         （管理密钥登录即带 stepup，可用管理密钥注册第一把）
       - app：永远需要 stepup（无例外） */
    if (type === 'register') {
      const sess = await verifySessionDetailed(request, env);
      if (!sess.ok || sess.role !== ROLE_OWNER) {
        return Response.json({ ok: false, error: 'session' }, { status: 401 });
      }
      const s = await requireStepup(request, env);
      if (!s.ok) {
        return Response.json({ ok: false, error: 'stepup-required', reason: s.reason }, { status: 403 });
      }
      /* 2.11：scope 检查 */
      if (pkClass === PK_CLASS_OWNER) {
        /* 管理 owner 凭证需要 scope=root */
        const cs = await checkScope(STEPUP_SCOPE_ROOT, s, kv, null);
        if (!cs.ok) {
          return Response.json({ ok: false, error: cs.error }, { status: 403 });
        }
      } else {
        /* 管理 lock/app 需要 scope=keys；root 可 takeover 未配置的层 */
        const layer = pkClass === PK_CLASS_LOCK ? LAYER_LOCK : layerApp(aud);
        const cs = await checkScope(STEPUP_SCOPE_KEYS, s, kv, layer);
        if (!cs.ok) {
          const status = cs.error === 'server' ? 503 : 403;
          return Response.json({ ok: false, error: cs.error }, { status });
        }
      }
    }
    /* auth 需要已有对应凭据 */
    if (type === 'auth' && classKeys.length === 0) {
      return Response.json({ ok: false, error: 'not-set' }, { status: 403 });
    }
    const challenge = randB64(32);
    const cid = randB64(16);
    try {
      await kv.put('pk-challenge:' + cid, JSON.stringify({ challenge, type, pkClass, aud, exp: Date.now() + 300000 }), { expirationTtl: 300 });
    } catch (e) {}
    const resp = { ok: true, cid: cid, challenge: challenge, rpId: RP_ID };
    if (type === 'register') {
      /* 下发用户信息：全部写死，用户不填。
         displayName=Sloan Gray（常量）；lock 的 name=lock；app 的 name=aud；
         user.id 每类/aud 独立，存 KV 复用。 */
      const userHandle = await getUserHandle(kv, pkClass === PK_CLASS_APP ? aud : '');
      resp.user = {
        id: userHandle,
        name: pkClass === PK_CLASS_APP ? aud : 'lock',
        displayName: OWNER_DISPLAY_NAME,
      };
      resp.rp = {
        id: RP_ID,
        name: 'Styrigx',
      };
      /* excludeCredentials：防重复注册（同类凭据） */
      resp.excludeCredentials = classKeys.map(function (k) {
        return { id: k.credId, type: 'public-key' };
      });
    }
    if (type === 'auth') {
      /* 2.10.0：challenge 只列出本类（本 aud）的凭据；服务端 verify 时再次校验分类 */
      resp.allowCredentials = classKeys.map(function (k) { return { id: k.credId, type: 'public-key' }; });
    }
    return Response.json(resp);
  }

  /* ============ register ============
     2.10.0：从 challenge 记录取 pkClass/aud（不信任 body），存储时写入分类。
     stepup 门禁已在 challenge 环节执行（第一把 lock 除外）；这里再验一次（纵深防御）。 */
  if (action === 'register') {
    const cred = (body && body.credential) || {};
    const cid = (body && body.cid) || '';
    /* 取 challenge（单次使用） */
    let chRec = null;
    try {
      chRec = await kv.get('pk-challenge:' + cid, 'json');
      await kv.delete('pk-challenge:' + cid);
    } catch (e) {}
    if (!chRec || chRec.type !== 'register' || chRec.exp < Date.now()) {
      return Response.json({ ok: false, error: 'challenge' }, { status: 403 });
    }
    const pkClass = chRec.pkClass === PK_CLASS_APP ? PK_CLASS_APP : PK_CLASS_LOCK;
    const aud = pkClass === PK_CLASS_APP ? (chRec.aud || '') : '';
    if (pkClass === PK_CLASS_APP && !getApp(aud)) {
      return Response.json({ ok: false, error: 'aud' }, { status: 400 });
    }
    /* 2.10.1 纵深防御：再验一次 owner 会话 + stepup（无例外） */
    const sess2 = await verifySessionDetailed(request, env);
    if (!sess2.ok || sess2.role !== ROLE_OWNER) {
      return Response.json({ ok: false, error: 'session' }, { status: 401 });
    }
    {
      const s = await requireStepup(request, env);
      if (!s.ok) {
        return Response.json({ ok: false, error: 'stepup-required', reason: s.reason }, { status: 403 });
      }
    }
    try {
      /* 验证 clientData：type / challenge / origin 严格等于期望值 */
      const clientData = JSON.parse(new TextDecoder().decode(b64urlDec(cred.response.clientDataJSON)));
      if (clientData.type !== 'webauthn.create') throw new Error('type');
      const expChallenge = chRec.challenge.replace(/=+$/, '');
      const gotChallenge = (clientData.challenge || '').replace(/=+$/, '');
      if (gotChallenge !== expChallenge) throw new Error('challenge');
      if (clientData.origin !== EXPECT_ORIGIN) throw new Error('origin');
      /* attestationObject 是文本键 CBOR map：取 "authData"（整数键 2 是 CTAP 层格式） */
      const attRes = cborDecode(b64urlDec(cred.response.attestationObject));
      const attObj = attRes.value;
      if (!(attObj instanceof Map)) throw new Error('attestationObject');
      const authData = attObj.get('authData');
      if (!(authData instanceof Uint8Array)) throw new Error('authData');
      const parsed = parseRegAuthData(authData, rpIdHash);
      /* P0-3：必须 UV=1（用户验证） */
      if (!parsed.uv) throw new Error('uv-required');
      const jwk = coseToJwk(parsed.coseKey);
      const credIdB64 = b64urlEnc(parsed.credId);
      /* 取 AAGUID（用于显示密码管理器名称） */
      let aaguid = '';
      try {
        if (parsed.aaguid) {
          const h = Array.from(parsed.aaguid, b => b.toString(16).padStart(2, '0')).join('');
          aaguid = h.slice(0,8) + '-' + h.slice(8,12) + '-' + h.slice(12,16) + '-' + h.slice(16,20) + '-' + h.slice(20);
        }
      } catch (e) {}
      /* 存储（同 credId 去重；新结构每把一个 key） */
      const now = Date.now();
      const devName = String((body && body.name) || '').slice(0, 40);
      const keys = await getPasskeys(kv);
      let existing = null;
      for (const k of keys) {
        if (k.credId === credIdB64) { existing = k; break; }
      }
      /* AAGUID 映射 provider，作为默认名 */
      const mappedProvider = (aaguid && AAGUID_PROVIDERS[aaguid.toLowerCase()]) || '';
      const item = {
        name: devName || mappedProvider || (existing && existing.name) || '通行密钥',
        provider: mappedProvider || (body && body.provider) || (existing && existing.provider) || '',
        aaguid: aaguid || (existing && existing.aaguid) || '',
        createdAt: (existing && existing.createdAt) || now,
        lastUsedAt: (existing && existing.lastUsedAt) || 0,
        credId: credIdB64,
        publicKey: jwk,
        signCount: parsed.signCount,
        uv: 1,
        class: pkClass,
        aud: aud || undefined,
      };
      await savePasskey(kv, item);
      return Response.json({ ok: true, credId: credIdB64 });
    } catch (e) {
      /* 具体原因只写控制台；UV 失败返回专属错误码，其他仍返回普通错误 */
      console.error('[passkey-register]', e && e.message ? e.message : e);
      const code = (e && e.message === 'uv-required') ? 'uv-required' : 'verify';
      return Response.json({ ok: false, error: code }, { status: 403 });
    }
  }

  /* ============ auth ============
     2.10.0：按 challenge 记录的 pkClass/aud 过滤；verify 时服务端再次校验分类
     （浏览器凭据选择器不是安全边界）。app 类成功后签发单次 app-auth 记录，
     供 /api/app-token 消费（不经过 stepup）。 */
  if (action === 'auth') {
    const cred = (body && body.credential) || {};
    const cid = (body && body.cid) || '';
    let chRec = null;
    try {
      chRec = await kv.get('pk-challenge:' + cid, 'json');
      await kv.delete('pk-challenge:' + cid);
    } catch (e) {}
    if (!chRec || chRec.type !== 'auth' || chRec.exp < Date.now()) {
      return Response.json({ ok: false, error: 'challenge' }, { status: 403 });
    }
    const pkClass = chRec.pkClass === PK_CLASS_APP ? PK_CLASS_APP : PK_CLASS_LOCK;
    const aud = pkClass === PK_CLASS_APP ? (chRec.aud || '') : '';
    const keys = await getPasskeys(kv);
    const classKeys = keys.filter(function (k) {
      if ((k.class || PK_CLASS_LOCK) !== pkClass) return false;
      if (pkClass === PK_CLASS_APP && k.aud !== aud) return false;
      return true;
    });
    if (classKeys.length === 0) {
      return Response.json({ ok: false, error: 'not-set' }, { status: 403 });
    }
    /* 按 credential id 找对应公钥 */
    const rawIdB64 = cred.rawId || '';
    let stored = null;
    let storedIdx = -1;
    for (let i = 0; i < classKeys.length; i++) {
      if (classKeys[i].credId === rawIdB64) { stored = classKeys[i]; storedIdx = i; break; }
    }
    if (!stored || !stored.publicKey) {
      return Response.json({ ok: false, error: 'unknown-key' }, { status: 403 });
    }
    /* 2.10.0：服务端再次校验分类和 aud（防混用） */
    if ((stored.class || PK_CLASS_LOCK) !== pkClass) {
      return Response.json({ ok: false, error: 'class-mismatch' }, { status: 403 });
    }
    if (pkClass === PK_CLASS_APP && stored.aud !== aud) {
      return Response.json({ ok: false, error: 'aud-mismatch' }, { status: 403 });
    }
    try {
      /* 共享断言验证（_kernel/passkey-verify.js）：clientData、authData、
         signCount 递增、ES256 签名、UV=1（P0-3）。登录行为不变。 */
      const checked = await verifyAssertion({
        credential: cred,
        challenge: chRec.challenge,
        rpIdHash: rpIdHash,
        expectOrigin: EXPECT_ORIGIN,
        storedPublicKey: stored.publicKey,
        storedSignCount: stored.signCount,
        requireUV: true,
      });
      /* 校验 userHandle（如果有）。2.10.1：按 pkClass/aud 取对应的 user handle，
         应用类用 owner-user-id:app:<aud>，不再拿锁屏的比对。 */
      try {
        const expectUh = await getUserHandle(kv, pkClass === PK_CLASS_APP ? aud : '');
        const gotUh = cred.response.userHandle;
        if (expectUh && gotUh && gotUh !== expectUh) throw new Error('userHandle');
      } catch (e) {
        if (e && e.message === 'userHandle') throw e;
      }
      /* 更新 signCount 和 lastUsedAt */
      stored.signCount = checked.signCount;
      stored.lastUsedAt = Date.now();
      try { await savePasskey(kv, stored); } catch (e2) {}
      /* 通过：
         - lock：签发 Ed25519 会话 cookie（fail closed），并签发管理 token。
           issueSessionCookie 永不抛错，明确错误码不会被外层 catch 吞成 403。
           2.8.0：通行密钥验证签 owner（12 小时）。
         - app（2.10.0）：写入单次 app-auth 记录并返回 appCid，
           供 /api/app-token 消费（全程不依赖 stepup）。 */
      if (pkClass === PK_CLASS_APP) {
        const appCid = randB64(16);
        try {
          await kv.put(
            APP_AUTH_PREFIX + appCid,
            JSON.stringify({ aud: aud, exp: Date.now() + APP_AUTH_TTL * 1000 }),
            { expirationTtl: APP_AUTH_TTL }
          );
        } catch (e) {
          return Response.json({ ok: false, error: 'server' }, { status: 500 });
        }
        return Response.json({ ok: true, appCid: appCid });
      }
      const headers = new Headers({ 'Content-Type': 'application/json' });
      const signErr = await issueSessionCookie(env, headers, ROLE_OWNER);
      if (signErr) {
        return new Response(JSON.stringify(signErr.body), {
          status: signErr.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      /* 2.10.1：不再签发 owner-auth token（死代码已清理）；
         管理区门禁统一走 sgx-stepup cookie。 */
      return new Response(JSON.stringify({ ok: true }), { headers });
    } catch (e) {
      console.error('[passkey-auth]', e && e.message ? e.message : e);
      const code = (e && e.message === 'uv-required') ? 'uv-required' : 'verify';
      return Response.json({ ok: false, error: code }, { status: 403 });
    }
  }

  /* ============ list：列出 passkey（2.10.2：需 owner 会话 + sgx-stepup） ============ */
  if (action === 'list') {
    const sessL = await verifySessionDetailed(request, env);
    if (!sessL.ok || sessL.role !== ROLE_OWNER) {
      return Response.json({ ok: false, error: 'session' }, { status: 401 });
    }
    const s = await requireStepup(request, env);
    if (!s.ok) {
      return Response.json({ ok: false, error: 'stepup-required', reason: s.reason }, { status: 403 });
    }
    const keys = await getPasskeys(kv);
    return Response.json({
      ok: true,
      keys: keys.map(function (k) {
        return {
          credId: k.credId,
          name: k.name || '',
          provider: k.provider || '',
          aaguid: k.aaguid || '',
          createdAt: k.createdAt || 0,
          lastUsedAt: k.lastUsedAt || 0,
          class: k.class || PK_CLASS_LOCK,
          aud: k.aud || '',
        };
      }),
    });
  }

  /* ============ rename：重命名 passkey（2.10.2：需 owner 会话 + sgx-stepup；1-40 字，去首尾空格和控制字符） ============ */
  if (action === 'rename') {
    const sessR = await verifySessionDetailed(request, env);
    if (!sessR.ok || sessR.role !== ROLE_OWNER) {
      return Response.json({ ok: false, error: 'session' }, { status: 401 });
    }
    const s = await requireStepup(request, env);
    if (!s.ok) {
      return Response.json({ ok: false, error: 'stepup-required', reason: s.reason }, { status: 403 });
    }
    const credId = (body && body.credId) || '';
    let name = (body && body.name) || '';
    if (!credId) return Response.json({ ok: false, error: 'params' }, { status: 400 });
    /* 清理：去首尾空格和控制字符，限 1-40 字 */
    name = String(name).replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 40);
    if (!name) return Response.json({ ok: false, error: 'params' }, { status: 400 });
    /* 直接 kv.get，不走 list（KV list 最终一致，刚写入的 key 约 60 秒内列不出来） */
    const keyName = 'owner-passkey:' + String(credId).slice(0, 12);
    let found = null;
    try { found = await kv.get(keyName, 'json'); } catch (e) {}
    /* 校验 credId 完全相等（防前 12 位碰撞） */
    if (!found || found.credId !== credId) {
      return Response.json({ ok: false, error: 'not-found' }, { status: 404 });
    }
    found.name = name;
    await savePasskey(kv, found);
    return Response.json({ ok: true });
  }

  /* ============ delete：删除 passkey（2.10.2：需 owner 会话 + sgx-stepup） ============
     - 删应用类凭据 → 先 app-epoch:<aud> +1（成功才删；失败 503 且密钥仍在），
       只作废该应用，不推进会话纪元
     - 删锁屏类凭据 → 先 session-epoch +1（成功才删；失败 503，fail closed）
     - 没有密码时，禁止删除最后一把 lock 凭据（保住最后一种主人解锁方式）
     - 成功后清除 sgx-stepup */
  if (action === 'delete') {
    const sessD = await verifySessionDetailed(request, env);
    if (!sessD.ok || sessD.role !== ROLE_OWNER) {
      return Response.json({ ok: false, error: 'session' }, { status: 401 });
    }
    const s = await requireStepup(request, env);
    if (!s.ok) {
      return Response.json({ ok: false, error: 'stepup-required', reason: s.reason }, { status: 403 });
    }
    const credId = (body && body.credId) || '';
    if (!credId) return Response.json({ ok: false, error: 'params' }, { status: 400 });
    /* 直接 kv.get 校验存在，不走 list（最终一致） */
    const keyName = 'owner-passkey:' + String(credId).slice(0, 12);
    let found = null;
    try { found = await kv.get(keyName, 'json'); } catch (e) {}
    if (!found || found.credId !== credId) {
      return Response.json({ ok: false, error: 'not-found' }, { status: 404 });
    }
    const delClass = found.class || PK_CLASS_LOCK;
    /* 没有密码时，禁止删除最后一把 lock 凭据 */
    if (delClass === PK_CLASS_LOCK) {
      let hasPw = false;
      try { hasPw = !!(await kv.get('owner-pw')); } catch (e) {}
      if (!hasPw) {
        const keys = await getPasskeys(kv);
        const lockKeys = keys.filter(function (k) { return (k.class || PK_CLASS_LOCK) === PK_CLASS_LOCK; });
        if (lockKeys.length <= 1) {
          return Response.json({ ok: false, error: 'last-key' }, { status: 403 });
        }
      }
    }
    /* 2.10.2：先推进纪元，成功才删（fail closed；纪元推进失败则密钥仍在） */
    if (delClass === PK_CLASS_APP && found.aud) {
      /* 删应用类凭据 → 该应用的应用纪元 +1（失败则拒绝删除） */
      try {
        await bumpAppEpoch(kv, found.aud);
      } catch (e) {
        return Response.json({ ok: false, error: 'epoch' }, { status: 503 });
      }
      /* 删应用类只加 app-epoch，不推进会话纪元 */
    } else {
      /* 删锁屏类密钥 → session-epoch +1（失败则拒绝删除，fail closed） */
      try {
        const v = parseInt(await kv.get('session-epoch') || '0', 10) || 0;
        await kv.put('session-epoch', String(v + 1));
      } catch (e) {
        return Response.json({ ok: false, error: 'epoch' }, { status: 503 });
      }
    }
    await deletePasskey(kv, credId);
    /* 成功后清除 sgx-stepup */
    const headers = new Headers({ 'Content-Type': 'application/json' });
    clearStepupCookie(headers);
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  return Response.json({ ok: false, error: 'params' }, { status: 400 });
}
