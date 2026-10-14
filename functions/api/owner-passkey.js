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
 * - 用户信息由服务端下发：displayName=Sloan Gray, name=ownerkey/lockkey/<app>key, rp.name=Styrigx
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
  bumpSessionEpoch,
  reissueSessionWithEpoch,
  ROLE_OWNER,
} from '../_kernel/session.js';
import { getApp } from '../_kernel/app-registry.js';
import { verifyStepupCookie, reissueStepupWithEpoch, STEPUP_COOKIE, STEPUP_BY_ROOT, STEPUP_BY_OWNER, STEPUP_SCOPE_ROOT, STEPUP_SCOPE_KEYS, STEPUP_SCOPE_LOCKRESET } from './stepup.js';
import { LAYER_OWNER, LAYER_LOCK, layerApp, setLayerConfigured, clearLayerConfigured, isLayerConfigured, isLockEffectivelyConfigured, isOwnerEffectivelyConfigured } from '../_kernel/layers.js';
import { verifySessionDetailed } from '../_middleware.js';
import {
  STORE_CLASS_OWNERKEY,
  STORE_CLASS_LOCKKEY,
  STORE_CLASS_APPKEY,
  KEY_OWNER,
  KEY_LOCK,
  appKeyName,
  ownerPasskeyKey,
  OWNER_PASSKEY_PREFIX,
} from '../_kernel/key-names.js';

/* 2.10.0：通行密钥分类；2.11 新增 owner。
   钥匙命名规范（key-names.js）：存储层 class 字段值保留 'owner'/'lock'/'app'
   不迁移；概念名用 ownerkey/lockkey/<aud>key（如 bookkey）。 */
export const PK_CLASS_OWNER = STORE_CLASS_OWNERKEY;
export const PK_CLASS_LOCK = STORE_CLASS_LOCKKEY;
export const PK_CLASS_APP = STORE_CLASS_APPKEY;
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
    const list = await kv.list({ prefix: OWNER_PASSKEY_PREFIX });
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
        const keyName = ownerPasskeyKey(credId);
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
              const keyName = ownerPasskeyKey(item.credId);
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
 * 2.11 定稿：owner/lock/app 三种原样保存；其他值拒绝（抛错），绝不默认归 lock。
 * @param {any} kv
 * @param {any} item
 */
export async function savePasskey(kv, item) {
  const keyName = ownerPasskeyKey(item.credId);
  /* P0-15：class 必须原样保存，owner 绝不能被改成 lock */
  const cls = item.class;
  if (cls !== PK_CLASS_OWNER && cls !== PK_CLASS_LOCK && cls !== PK_CLASS_APP) {
    throw new Error('invalid-class');
  }
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
    class: cls,
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
  const keyName = ownerPasskeyKey(credId);
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
 * 批次 A 收尾 C1：owner 类改用 'owner-user-id:owner'，不再与 lock 类共用，
 * 防止 Samsung Pass 把 ownerkey 覆盖到 lockkey 上。
 * @param {any} kv
 * @param {string} pkClass 凭据类别：'owner' | 'lock' | 'app'
 * @param {string} [aud] 应用 aud（应用类必填）
 */
async function getUserHandle(kv, pkClass, aud) {
  let key;
  if (pkClass === PK_CLASS_OWNER) {
    key = 'owner-user-id:owner';
  } else if (pkClass === PK_CLASS_APP) {
    key = 'owner-user-id:app:' + aud;
  } else {
    key = 'owner-user-id';
  }
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
 * 2.11 定稿：passkey 管理统一门禁。
 *
 * - owner 类：只认入口 1（stepup by=root, scope=root）
 * - lock 类：入口 2（scope=keys：by=owner，或 by=root 且 owner 层未配置）；
 *   owner 未配置时 scope=root(by=root) 可直接代管；
 *   scope=lockreset 可 list/register/delete（重置流程，无会话），不可 rename
 * - app 类：入口 2（同 lock 的 keys 规则）；lockreset 一律拒绝
 * - 会话：除 lockreset 外，要求有效 owner 会话；by=root 的代开会话在 lock
 *   已配置时拒绝（纵深防御；epoch 机制已使其失效）
 *
 * @param {any} request
 * @param {any} env
 * @param {any} kv
 * @param {string} pkClass 'owner' | 'lock' | 'app'
 * @param {string} op 'list' | 'register' | 'rename' | 'delete'
 * @returns {Promise<{ok:true, sv:object, sess:object|null}|{ok:false, status:number, body:object}>}
 */
async function checkPasskeyMgmt(request, env, kv, pkClass, op) {
  /* 先看有没有 stepup cookie：没有 → 先查会话（401）；有 → 先验票 */
  let hasStepupCookie = false;
  try {
    const h = request.headers.get('Cookie') || '';
    for (const part of h.split(';')) {
      const [k] = part.trim().split('=');
      if (k === STEPUP_COOKIE) { hasStepupCookie = true; break; }
    }
  } catch (e) {}
  const sv = await verifyStepupCookie(request, env);
  if (!sv.ok) {
    if (!hasStepupCookie) {
      /* 无 stepup 也无从判断 lockreset：先查会话 */
      const sess0 = await verifySessionDetailed(request, env);
      if (!sess0.ok || sess0.role !== ROLE_OWNER) {
        return { ok: false, status: 401, body: { ok: false, error: 'session' } };
      }
    }
    return { ok: false, status: 403, body: { ok: false, error: 'stepup-required', reason: sv.reason } };
  }
  const isLockreset = sv.scope === STEPUP_SCOPE_LOCKRESET;
  const deny = function (reason) {
    const body = { ok: false, error: 'scope' };
    /* 代管中途站长层被配置：前端据此显示明确文案，不无提示踢回安全页 */
    if (reason) body.reason = reason;
    return { ok: false, status: 403, body: body };
  };

  if (pkClass === PK_CLASS_OWNER) {
    /* 站长凭证：只认入口 1 */
    if (sv.scope !== STEPUP_SCOPE_ROOT || sv.by !== STEPUP_BY_ROOT) return deny();
  } else if (pkClass === PK_CLASS_LOCK) {
    if (isLockreset) {
      if (op === 'rename') return deny();
    } else if (sv.scope === STEPUP_SCOPE_KEYS) {
      if (sv.by === STEPUP_BY_ROOT) {
        /* by=root 的 keys 票：仅 owner 未配置时代管有效；中途被配置 → 明确原因 */
        if (await isLayerConfigured(kv, LAYER_OWNER)) return deny('owner-configured');
      } else if (sv.by !== STEPUP_BY_OWNER) {
        return deny();
      }
    } else if (sv.scope === STEPUP_SCOPE_ROOT && sv.by === STEPUP_BY_ROOT) {
      /* root 直接代管未配置的 owner 层；中途被配置 → 明确原因 */
      if (await isLayerConfigured(kv, LAYER_OWNER)) return deny('owner-configured');
    } else {
      return deny();
    }
  } else {
    /* app 类：lockreset 一律拒绝 */
    if (isLockreset) return deny();
    if (sv.scope === STEPUP_SCOPE_KEYS) {
      if (sv.by === STEPUP_BY_ROOT) {
        if (await isLayerConfigured(kv, LAYER_OWNER)) return deny('owner-configured');
      } else if (sv.by !== STEPUP_BY_OWNER) {
        return deny();
      }
    } else if (sv.scope === STEPUP_SCOPE_ROOT && sv.by === STEPUP_BY_ROOT) {
      if (await isLayerConfigured(kv, LAYER_OWNER)) return deny('owner-configured');
    } else {
      return deny();
    }
  }

  /* 会话门禁：lockreset 重置流程无会话 */
  if (isLockreset) {
    return { ok: true, sv: sv, sess: null };
  }
  const sess = await verifySessionDetailed(request, env);
  if (!sess.ok || sess.role !== ROLE_OWNER) {
    return { ok: false, status: 401, body: { ok: false, error: 'session' } };
  }
  if (sess.by === 'root' && (await isLockEffectivelyConfigured(kv))) {
    return { ok: false, status: 403, body: { ok: false, error: 'by-root' } };
  }
  return { ok: true, sv: sv, sess: sess };
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
    /* 2.11 定稿：register 统一门禁（checkPasskeyMgmt）。
       - owner 类：入口 1（by=root, scope=root）
       - lock/app 类：入口 2（scope=keys）或 root 代管；lockreset 可注册 lock */
    if (type === 'register') {
      const mg = await checkPasskeyMgmt(request, env, kv, pkClass, 'register');
      if (!mg.ok) {
        return Response.json(mg.body, { status: mg.status });
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
         displayName=Sloan Gray（常量）；
         name：站长凭证 → ownerkey；锁屏 → lockkey；app → 应用名小写+key（如 bookkey）。
         user.id 每类/aud 独立，存 KV 复用（生成方式不变）。 */
      const userHandle = await getUserHandle(kv, pkClass, pkClass === PK_CLASS_APP ? aud : '');
      const userName = pkClass === PK_CLASS_OWNER ? KEY_OWNER
        : pkClass === PK_CLASS_APP ? appKeyName(aud)
        : KEY_LOCK;
      resp.user = {
        id: userHandle,
        name: userName,
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
    const pkClass = chRec.pkClass === PK_CLASS_APP ? PK_CLASS_APP
      : chRec.pkClass === PK_CLASS_OWNER ? PK_CLASS_OWNER : PK_CLASS_LOCK;
    const aud = pkClass === PK_CLASS_APP ? (chRec.aud || '') : '';
    if (pkClass === PK_CLASS_APP && !getApp(aud)) {
      return Response.json({ ok: false, error: 'aud' }, { status: 400 });
    }
    /* 2.11 定稿纵深防御：按 challenge 的 pkClass 再验一次统一门禁 */
    let mgReg = null;
    {
      const mg = await checkPasskeyMgmt(request, env, kv, pkClass, 'register');
      if (!mg.ok) {
        return Response.json(mg.body, { status: mg.status });
      }
      mgReg = mg;
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
      /* 2.11 定稿：首次配置某层时标记 + 推进纪元（fail closed 写入失败不阻断注册主体，
         但标记/纪元失败时尽力而为；纪元推进失败则返回 503）
         - 首次配 owner：废止 by=root,scope=keys 的票（必修安全项 1）
         - 首次配 lock：废止根凭证代开的解锁会话（必修安全项 2）
         - 首次配某 app：推进 app-epoch:<aud>（必修安全项 3）
         D2：epoch 推进后用新 epoch 重签 stepup + 当前设备会话，保持当前设备不掉线。 */
      let regNewEpoch = null;
      try {
        if (pkClass === PK_CLASS_OWNER) {
          const was = await isLayerConfigured(kv, LAYER_OWNER);
          if (!was) {
            await setLayerConfigured(kv, LAYER_OWNER);
            regNewEpoch = await bumpSessionEpoch(kv);
          }
        } else if (pkClass === PK_CLASS_LOCK) {
          const was = await isLayerConfigured(kv, LAYER_LOCK);
          if (!was) {
            await setLayerConfigured(kv, LAYER_LOCK);
            regNewEpoch = await bumpSessionEpoch(kv);
          }
        } else if (pkClass === PK_CLASS_APP && aud) {
          const was = await isLayerConfigured(kv, layerApp(aud));
          if (!was) {
            await setLayerConfigured(kv, layerApp(aud));
            await bumpAppEpoch(kv, aud);
          }
        }
      } catch (e) {
        return Response.json({ ok: false, error: 'epoch' }, { status: 503 });
      }
      if (regNewEpoch !== null && mgReg) {
        const headers = new Headers({ 'Content-Type': 'application/json' });
        await reissueStepupWithEpoch(env, headers, mgReg.sv, regNewEpoch);
        await reissueSessionWithEpoch(env, headers, mgReg.sess, regNewEpoch);
        return new Response(JSON.stringify({ ok: true, credId: credIdB64 }), { headers });
      }
      return Response.json({ ok: true, credId: credIdB64 });
    } catch (e) {
      /* 具体原因只写控制台；UV 失败返回专属错误码，其他仍返回普通错误 */
      console.error('[passkey-register]', e && e.message ? e.message : e);
      const code = (e && e.message === 'uv-required') ? 'uv-required'
        : (e && e.message === 'invalid-class') ? 'class' : 'verify';
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
         应用类用 owner-user-id:app:<aud>，不再拿锁屏的比对。
         批次 A 收尾：owner 类同时接受新 handle 'owner-user-id:owner' 和旧 handle
         'owner-user-id'（旧 ownerkey 注册时用旧 handle）。只对 owner 类放宽，
         lock/app 不变；验证本身仍以凭据公钥签名为准。 */
      try {
        const expectUh = await getUserHandle(kv, pkClass, pkClass === PK_CLASS_APP ? aud : '');
        const gotUh = cred.response.userHandle;
        if (expectUh && gotUh && gotUh !== expectUh) {
          if (pkClass === PK_CLASS_OWNER) {
            let legacyUh = null;
            try { legacyUh = await kv.get('owner-user-id'); } catch (e) {}
            if (!legacyUh || gotUh !== legacyUh) throw new Error('userHandle');
          } else {
            throw new Error('userHandle');
          }
        }
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

  /* ============ list：列出 passkey（2.11 定稿：需 owner 会话 + sgx-stepup） ============
     批次 A 验收修复 P0：钥匙类别由页面决定，不由票据 scope 推断。
     调用方必须显式传 pkClass（'owner' | 'lock' | 'app'，app 可带 aud 过滤单个应用）；
     服务端用 checkPasskeyMgmt(…, pkClass, 'list') 判断权限，只返回该类。 */
  if (action === 'list') {
    const pkClass = body && body.pkClass;
    if (pkClass !== PK_CLASS_OWNER && pkClass !== PK_CLASS_LOCK && pkClass !== PK_CLASS_APP) {
      return Response.json({ ok: false, error: 'params' }, { status: 400 });
    }
    let aud = '';
    if (pkClass === PK_CLASS_APP) {
      aud = (body && body.aud) || '';
      if (aud && !getApp(aud)) {
        return Response.json({ ok: false, error: 'aud' }, { status: 400 });
      }
    }
    const mg = await checkPasskeyMgmt(request, env, kv, pkClass, 'list');
    if (!mg.ok) {
      return Response.json(mg.body, { status: mg.status });
    }
    const keys = await getPasskeys(kv);
    return Response.json({
      ok: true,
      /* 兼容旧前端：仍回传票据 scope，但前端不再据此推断类别 */
      scope: mg.sv.scope,
      keys: keys
        .filter(function (k) {
          if ((k.class || PK_CLASS_LOCK) !== pkClass) return false;
          if (pkClass === PK_CLASS_APP && aud && k.aud !== aud) return false;
          return true;
        })
        .map(function (k) {
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

  /* ============ rename：重命名 passkey（2.11 定稿：统一门禁；lockreset 不可 rename） ============ */
  if (action === 'rename') {
    const credId = (body && body.credId) || '';
    let name = (body && body.name) || '';
    if (!credId) return Response.json({ ok: false, error: 'params' }, { status: 400 });
    /* 先取到凭据以确定类别（门禁按类别） */
    const keyName0 = ownerPasskeyKey(credId);
    let found0 = null;
    try { found0 = await kv.get(keyName0, 'json'); } catch (e) {}
    if (!found0 || found0.credId !== credId) {
      return Response.json({ ok: false, error: 'not-found' }, { status: 404 });
    }
    const mg = await checkPasskeyMgmt(request, env, kv, found0.class || PK_CLASS_LOCK, 'rename');
    if (!mg.ok) {
      return Response.json(mg.body, { status: mg.status });
    }
    /* 清理：去首尾空格和控制字符，限 1-40 字 */
    name = String(name).replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 40);
    if (!name) return Response.json({ ok: false, error: 'params' }, { status: 400 });
    found0.name = name;
    await savePasskey(kv, found0);
    return Response.json({ ok: true });
  }

  /* ============ delete：删除 passkey（2.10.2：需 owner 会话 + sgx-stepup） ============
     - 删应用类凭据 → 先 app-epoch:<aud> +1（成功才删；失败 503 且密钥仍在），
       只作废该应用，不推进会话纪元
     - 删锁屏类凭据 → 先 session-epoch +1（成功才删；失败 503，fail closed）
     - 没有密码时，禁止删除最后一把 lock 凭据（保住最后一种主人解锁方式）
     - 成功后清除 sgx-stepup */
  if (action === 'delete') {
    const credId = (body && body.credId) || '';
    if (!credId) return Response.json({ ok: false, error: 'params' }, { status: 400 });
    /* 直接 kv.get 校验存在，不走 list（最终一致） */
    const keyName = ownerPasskeyKey(credId);
    let found = null;
    try { found = await kv.get(keyName, 'json'); } catch (e) {}
    if (!found || found.credId !== credId) {
      return Response.json({ ok: false, error: 'not-found' }, { status: 404 });
    }
    const delClass = found.class || PK_CLASS_LOCK;
    /* 2.11 定稿：统一门禁（lockreset 可删 lock） */
    const mg = await checkPasskeyMgmt(request, env, kv, delClass, 'delete');
    if (!mg.ok) {
      return Response.json(mg.body, { status: mg.status });
    }
    const isLockresetOp = mg.sv.scope === STEPUP_SCOPE_LOCKRESET;
    /* A-2：锁屏凭证减到 0 的那次删除，只在 owner 已有效配置时允许；
       owner 未配置时禁止（403 last-key，文案不变）。判断在任何 mutation 之前。 */
    if (delClass === PK_CLASS_LOCK) {
      let hasLockPw = false;
      try {
        const pwRec = await kv.get('lock-pw', 'json');
        hasLockPw = !!(pwRec && pwRec.hash);
      } catch (e) {}
      const keys = await getPasskeys(kv);
      const lockKeys = keys.filter(function (k) { return (k.class || PK_CLASS_LOCK) === PK_CLASS_LOCK; });
      /* 删后锁屏凭证归零：无锁屏密码且只剩这一把 lock 钥匙 */
      if (!hasLockPw && lockKeys.length <= 1) {
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
    /* 2.10.2：先推进纪元，成功才删（fail closed；纪元推进失败则密钥仍在）
       D1：删 owner 类钥匙不推进 session-epoch（定稿没有要求删 ownerkey 踢掉所有会话；
       只有第 33 条要求删应用密钥时该应用授权失效，应用类只加 app-epoch）。
       D2：删 lock 类钥匙保留 epoch +1（踢掉其他设备），但同响应重签当前设备会话。 */
    let newEpoch = null;
    if (delClass === PK_CLASS_APP && found.aud) {
      /* 删应用类凭据 → 该应用的应用纪元 +1（失败则拒绝删除） */
      try {
        await bumpAppEpoch(kv, found.aud);
      } catch (e) {
        return Response.json({ ok: false, error: 'epoch' }, { status: 503 });
      }
      /* 删应用类只加 app-epoch，不推进会话纪元 */
    } else if (delClass === PK_CLASS_LOCK) {
      /* 删锁屏类密钥 → session-epoch +1（失败则拒绝删除，fail closed） */
      try {
        const v = parseInt(await kv.get('session-epoch') || '0', 10) || 0;
        newEpoch = v + 1;
        await kv.put('session-epoch', String(newEpoch));
      } catch (e) {
        return Response.json({ ok: false, error: 'epoch' }, { status: 503 });
      }
    }
    /* D1：删 owner 类不推进 session-epoch（newEpoch 保持 null，不重签）。 */
    await deletePasskey(kv, credId);
    /* 2.11 定稿：删完后若该层已无凭证，清除层标记。
       root 删站长凭证 → 推进 session-epoch（已在上完成），避免无声回退到 root 代管 */
    try {
      const keys = await getPasskeys(kv);
      if (delClass === PK_CLASS_OWNER) {
        const hasOwnerKey = keys.some(function (k) { return (k.class || PK_CLASS_LOCK) === PK_CLASS_OWNER; });
        let hasOwnerPw = false;
        try { const r = await kv.get('owner-pw', 'json'); hasOwnerPw = !!(r && r.hash); } catch (e) {}
        if (!hasOwnerKey && !hasOwnerPw) {
          /* 清标记失败不吞掉：标记残留会导致 root 无法代管（用户被锁死），直接 503 */
          try {
            await clearLayerConfigured(kv, LAYER_OWNER);
          } catch (e) {
            return Response.json({ ok: false, error: 'server' }, { status: 503 });
          }
        }
      } else if (delClass === PK_CLASS_LOCK) {
        const hasLockKey = keys.some(function (k) { return (k.class || PK_CLASS_LOCK) === PK_CLASS_LOCK; });
        let hasLockPw = false;
        try { const r = await kv.get('lock-pw', 'json'); hasLockPw = !!(r && r.hash); } catch (e) {}
        if (!hasLockKey && !hasLockPw) {
          /* A-2：删光 lock 凭证且 owner 已配置 → 保留 layer:lock 不清
             （根凭证代开继续被拒，锁屏只显示访客 + 重置）；
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
      } else if (delClass === PK_CLASS_APP && found.aud) {
        const hasAppKey = keys.some(function (k) {
          return (k.class || PK_CLASS_LOCK) === PK_CLASS_APP && k.aud === found.aud;
        });
        if (!hasAppKey) {
          /* 清标记失败不吞掉：同上 */
          try {
            await clearLayerConfigured(kv, layerApp(found.aud));
          } catch (e) {
            return Response.json({ ok: false, error: 'server' }, { status: 503 });
          }
        }
      }
    } catch (e) {}
    /* D2：删 lock 类推进 epoch 后，用新 epoch 重签 stepup 票据 + 当前设备会话，
       保持门内连续操作不中断、当前设备不掉线。删 owner 类不推进 epoch，无需重签。 */
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (newEpoch !== null && mg.sv && mg.sv.ok) {
      await reissueStepupWithEpoch(env, headers, mg.sv, newEpoch);
      /* 当前设备会话重签（lockreset 无会话时 mg.sess 为 null，helper 内部跳过） */
      await reissueSessionWithEpoch(env, headers, mg.sess, newEpoch);
    }
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  return Response.json({ ok: false, error: 'params' }, { status: 400 });
}
