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
 * 只管锁屏通行密钥（class=lock）；账号通行密钥（class=owner）只在 /api/account 管理。
 * - { action: 'challenge', type: 'register'|'auth', cid } → 返回 challenge
 *   - register 需要锁屏门票（door=lock + owner 会话，或重置锁屏门票 door=lockreset）
 *   - auth 不需要（用于锁屏解锁 / 锁屏凭证的门）
 * - { action: 'register', cid, credential } → 验证并追加存储（再验门票）
 * - { action: 'auth', cid, credential, door? } → 验证断言；签发会话 cookie；
 *   door:true（安全与隐私 → 锁屏凭证的门，需 owner 会话）改签 3 分钟锁屏门票，会话不动
 * - { action: 'list' } → 列出锁屏通行密钥（需锁屏门票）
 * - { action: 'rename', credId, name } → 重命名设备名（需锁屏门票；重置锁屏不可）
 * - { action: 'delete', credId } → 删除指定 passkey（需锁屏门票；
 *   先推纪元再删，失败 503 且密钥仍在）
 *
 * 只接受 POST；Origin 缺失/解析失败/跨站一律 403。
 *
 * P0-3 安全审计：
 * - 注册和解锁都要求 UV=1（userVerification: required）
 * - RP_ID/ORIGIN 必须配环境变量 SGX_RP_ID/SGX_ORIGIN，不回落
 * - 用户信息由服务端下发：displayName=Sloan Gray, name=LockKey, rp.name=Styrigx
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
  rpIdHashOf,
  consumeChallenge,
} from '../_kernel/passkey-verify.js';
import {
  issueSessionCookie,
  bumpSessionEpoch,
  reissueSessionWithEpoch,
  ROLE_OWNER,
} from '../_kernel/session.js';
import { checkLockDoor, looksVisitor } from './lock-door.js';
import { issueDoorCookie, reissueDoorWithEpoch, DOOR_LOCK } from '../_kernel/door.js';
import { LAYER_LOCK, setLayerConfigured, clearLayerConfigured, isLayerConfigured, isAccountEffectivelyConfigured } from '../_kernel/layers.js';
import { verifySessionDetailed } from '../_middleware.js';
import { REALM_LOCK, SESSION_EPOCH_KEY, rpConfig, rpConfigMissing } from '../_kernel/realms.js';

/* 通行密钥注册/登录 challenge 的 KV 前缀（'pk-challenge:'；与 account-challenge: 隔离） */
const PK_CHALLENGE_PREFIX = REALM_LOCK.kv.passkeyChallengePrefix;
import {
  STORE_CLASS_ACCOUNTKEY,
  STORE_CLASS_LOCKKEY,
  KEY_LOCK,
  ownerPasskeyKey,
  OWNER_PASSKEY_PREFIX,
} from '../_kernel/key-names.js';
import { isSameOrigin, originDenied } from '../_kernel/http.js';

/* 通行密钥分类：钥匙命名规范（key-names.js）：存储层 class 字段值保留 'owner'/'lock'
   不迁移；概念名用 AccountKey/LockKey。应用凭证已删除（旧 class=app 记录不再被任何接口读取）。 */
export const PK_CLASS_ACCOUNT = STORE_CLASS_ACCOUNTKEY;
export const PK_CLASS_LOCK = STORE_CLASS_LOCKKEY;
/* 所有者显示名（注册参数写死，用户不填） */
export const OWNER_DISPLAY_NAME = 'Sloan Gray';

/* AAGUID → 密码管理器（只用于显示，不参与安全判断）。
   取自 passkeydeveloper/passkey-authenticator-aaguids；iCloud 钥匙串通常回报全 0 AAGUID，显示为空。 */
const AAGUID_PROVIDERS = {
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google 密码管理器',
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'Apple 密码',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud 钥匙串',
  'd3452668-01fd-4c12-926c-83a4204853aa': 'Microsoft 密码管理器',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
};

/**
 * AAGUID → 密码管理器显示名（只用于显示；账号页注册账号通行密钥时复用）。
 * @param {string} aaguid
 */
export function providerOf(aaguid) {
  return (aaguid && AAGUID_PROVIDERS[String(aaguid).toLowerCase()]) || '';
}

/* randB64 / b64urlDec / cborDecode / parseRegAuthData / coseToJwk / derToRaw /
   checkAssertAuthData / verifyAssertion 已抽到 ../_kernel/passkey-verify.js（解锁、账号登录、重置锁屏共用） */

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

/** 按索引读取已注册 passkey（不走 kv.list，避开最终一致延迟） */
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
 * owner/lock 两种原样保存；其他值拒绝（抛错），绝不默认归 lock。
 * @param {any} kv
 * @param {any} item
 */
export async function savePasskey(kv, item) {
  const keyName = ownerPasskeyKey(item.credId);
  /* P0-15：class 必须原样保存，owner 绝不能被改成 lock */
  const cls = item.class;
  if (cls !== PK_CLASS_ACCOUNT && cls !== PK_CLASS_LOCK) {
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
 * @returns {Promise<any|null>} 被删除的记录
 */
export async function deletePasskey(kv, credId) {
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
 * 锁屏类用 'owner-user-id'。
 * 批次 A 收尾 C1：owner 类改用 'owner-user-id:owner'，不再与 lock 类共用，
 * 防止 Samsung Pass 把 AccountKey（原 OwnerKey）覆盖到 LockKey 上。
 * @param {any} kv
 * @param {string} pkClass 凭据类别：'owner' | 'lock'
 */
export async function getUserHandle(kv, pkClass) {
  const key = pkClass === PK_CLASS_ACCOUNT ? 'owner-user-id:owner' : 'owner-user-id';
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
 * 锁屏通行密钥管理门禁：锁屏门票（door=lock + owner 会话），或重置锁屏门票（door=lockreset，
 * 可 list/register/delete，不可 rename）。账号通行密钥（class=owner）只在账号页（/api/account）
 * 管理，这里一律 403 scope（reason=account）。
 * @param {any} request
 * @param {any} env
 * @param {string} pkClass
 * @param {string} op 'list' | 'register' | 'rename' | 'delete'
 */
async function checkPasskeyMgmt(request, env, pkClass, op) {
  if (pkClass !== PK_CLASS_LOCK) {
    return { ok: false, status: 403, body: { ok: false, error: 'scope', reason: 'account' } };
  }
  return checkLockDoor(request, env, { allowReset: op !== 'rename' });
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
  const kv = env && env.KV_LOCK_DOOR;

  if (request.method !== 'POST') {
    return Response.json({ ok: false, error: 'method' }, { status: 405 });
  }
  /* Origin 必须与本站同 host（CSRF 防护），缺失或解析失败一律 403 */
  if (!isSameOrigin(request)) return originDenied();
  if (!kv) return Response.json({ ok: false, error: 'config' }, { status: 500 });

  let body;
  try { body = await request.json(); } catch (e) {
    return Response.json({ ok: false, error: 'body' }, { status: 400 });
  }
  const action = (body && body.action) || '';

  /* RP_ID / 期望 origin：必须设置环境变量，不回落（防配置错误） */
  const rp = rpConfig(env);
  if (!rp) return rpConfigMissing(); /* 缺变量：返回明确错误（503），前端据此禁用通行密钥入口 */
  const RP_ID = rp.rpId;
  const EXPECT_ORIGIN = rp.origin;
  const rpIdHash = await rpIdHashOf(RP_ID);

  /* ============ challenge ============
     - type=register：需锁屏门票（checkPasskeyMgmt）
     - type=auth：challenge 只列 lock 凭据（锁屏解锁 / 锁屏凭证的门） */
  if (action === 'challenge') {
    const type = (body && body.type) || '';
    if (type !== 'register' && type !== 'auth') {
      return Response.json({ ok: false, error: 'params' }, { status: 400 });
    }
    const pkClass = (body && body.pkClass) || PK_CLASS_LOCK;
    if (pkClass !== PK_CLASS_ACCOUNT && pkClass !== PK_CLASS_LOCK) {
      return Response.json({ ok: false, error: 'params' }, { status: 400 });
    }
    const keys = await getPasskeys(kv);
    const classKeys = keys.filter(function (k) {
      return (k.class || PK_CLASS_LOCK) === pkClass;
    });
    /* register 统一门禁（checkPasskeyMgmt）：owner 类一律拒绝（只在账号页注册） */
    if (type === 'register') {
      const mg = await checkPasskeyMgmt(request, env, pkClass, 'register');
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
      await kv.put(PK_CHALLENGE_PREFIX + cid, JSON.stringify({ challenge, type, pkClass, exp: Date.now() + 300000 }), { expirationTtl: 300 });
    } catch (e) {}
    const resp = { ok: true, cid: cid, challenge: challenge, rpId: RP_ID };
    if (type === 'register') {
      /* 下发用户信息：全部写死，用户不填。displayName=Sloan Gray（常量）；name=LockKey。
         user.id 存 KV 复用（生成方式不变）。 */
      const userHandle = await getUserHandle(kv, pkClass);
      const userName = KEY_LOCK;
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
      /* challenge 只列出本类的凭据；服务端 verify 时再次校验分类 */
      resp.allowCredentials = classKeys.map(function (k) { return { id: k.credId, type: 'public-key' }; });
    }
    return Response.json(resp);
  }

  /* ============ register ============
     从 challenge 记录取 pkClass（不信任 body），存储时写入分类。
     门禁已在 challenge 环节执行；这里再验一次（纵深防御）。 */
  if (action === 'register') {
    const cred = (body && body.credential) || {};
    const cid = (body && body.cid) || '';
    /* 取 challenge（单次使用） */
    const chRec = await consumeChallenge(kv, PK_CHALLENGE_PREFIX + cid);
    if (!chRec || chRec.type !== 'register' || chRec.exp < Date.now()) {
      return Response.json({ ok: false, error: 'challenge' }, { status: 403 });
    }
    const pkClass = chRec.pkClass === PK_CLASS_ACCOUNT ? PK_CLASS_ACCOUNT : PK_CLASS_LOCK;
    /* 纵深防御：按 challenge 的 pkClass 再验一次统一门禁 */
    const mgReg = await checkPasskeyMgmt(request, env, pkClass, 'register');
    if (!mgReg.ok) {
      return Response.json(mgReg.body, { status: mgReg.status });
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
      };
      await savePasskey(kv, item);
      /* 首次配置锁屏层时标记 + 推进纪元（废止根凭证代开的解锁会话，必修安全项 2；
         纪元推进失败则返回 503）。纪元推进后用新纪元重签门票 + 当前设备会话，保持当前设备不掉线。 */
      let regNewEpoch = null;
      try {
        const was = await isLayerConfigured(kv, LAYER_LOCK);
        if (!was) {
          await setLayerConfigured(kv, LAYER_LOCK);
          regNewEpoch = await bumpSessionEpoch(kv);
        }
      } catch (e) {
        return Response.json({ ok: false, error: 'epoch' }, { status: 503 });
      }
      if (regNewEpoch !== null) {
        const headers = new Headers({ 'Content-Type': 'application/json' });
        await reissueDoorWithEpoch(env, headers, mgReg.door, mgReg.dv, regNewEpoch);
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
     只认 lock 凭据；verify 时服务端再次校验分类（浏览器凭据选择器不是安全边界）。
     door:true：安全与隐私 → 锁屏凭证的门，要求 owner 会话，成功只签 3 分钟锁屏门票（会话不动）；
     访客写死失败，不读存储。 */
  if (action === 'auth') {
    const toDoor = !!(body && body.door === true);
    if (toDoor) {
      if (looksVisitor(request)) {
        return Response.json({ ok: false, error: 'verify' }, { status: 403 });
      }
      const ds = await verifySessionDetailed(request, env);
      if (!ds.ok || ds.role !== ROLE_OWNER) {
        return Response.json({ ok: false, error: 'session' }, { status: 401 });
      }
    }
    const cred = (body && body.credential) || {};
    const cid = (body && body.cid) || '';
    const chRec = await consumeChallenge(kv, PK_CHALLENGE_PREFIX + cid);
    if (!chRec || chRec.type !== 'auth' || chRec.exp < Date.now()) {
      return Response.json({ ok: false, error: 'challenge' }, { status: 403 });
    }
    if ((chRec.pkClass || PK_CLASS_LOCK) !== PK_CLASS_LOCK) {
      return Response.json({ ok: false, error: 'class-mismatch' }, { status: 403 });
    }
    const pkClass = PK_CLASS_LOCK;
    const keys = await getPasskeys(kv);
    const classKeys = keys.filter(function (k) {
      return (k.class || PK_CLASS_LOCK) === pkClass;
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
    /* 服务端再次校验分类（防混用） */
    if ((stored.class || PK_CLASS_LOCK) !== pkClass) {
      return Response.json({ ok: false, error: 'class-mismatch' }, { status: 403 });
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
      /* 校验 userHandle（如果有）；验证本身仍以凭据公钥签名为准。 */
      try {
        const expectUh = await getUserHandle(kv, pkClass);
        const gotUh = cred.response.userHandle;
        if (expectUh && gotUh && gotUh !== expectUh) throw new Error('userHandle');
      } catch (e) {
        if (e && e.message === 'userHandle') throw e;
      }
      /* 更新 signCount 和 lastUsedAt */
      stored.signCount = checked.signCount;
      stored.lastUsedAt = Date.now();
      try { await savePasskey(kv, stored); } catch (e2) {}
      /* 通过：签发 Ed25519 会话 cookie（fail closed；issueSessionCookie 永不抛错，
         明确错误码不会被外层 catch 吞成 403）。2.8.0：通行密钥验证签 owner（12 小时）。
         door:true：只签锁屏门票（by=passkey）。 */
      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (toDoor) {
        const dErr = await issueDoorCookie(env, headers, DOOR_LOCK, 'passkey');
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
    } catch (e) {
      console.error('[passkey-auth]', e && e.message ? e.message : e);
      const code = (e && e.message === 'uv-required') ? 'uv-required' : 'verify';
      return Response.json({ ok: false, error: code }, { status: 403 });
    }
  }

  /* ============ list：列出 passkey（需锁屏门票） ============
     调用方必须显式传 pkClass（'lock'；'owner' 一律 403，只在账号页管理）。 */
  if (action === 'list') {
    const pkClass = body && body.pkClass;
    if (pkClass !== PK_CLASS_ACCOUNT && pkClass !== PK_CLASS_LOCK) {
      return Response.json({ ok: false, error: 'params' }, { status: 400 });
    }
    const mg = await checkPasskeyMgmt(request, env, pkClass, 'list');
    if (!mg.ok) {
      return Response.json(mg.body, { status: mg.status });
    }
    const keys = await getPasskeys(kv);
    return Response.json({
      ok: true,
      door: mg.door,
      keys: keys
        .filter(function (k) {
          return (k.class || PK_CLASS_LOCK) === pkClass;
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
          };
        }),
    });
  }

  /* ============ rename：重命名 passkey（统一门禁；重置锁屏不可 rename） ============ */
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
    const mg = await checkPasskeyMgmt(request, env, found0.class || PK_CLASS_LOCK, 'rename');
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

  /* ============ delete：删除 passkey（需锁屏门票；重置锁屏也可删） ============
     - 先 session-epoch +1（成功才删；失败 503，fail closed），门票与当前设备会话随即重签
     - 没有密码时，禁止删除最后一把 lock 凭据（账号未配置时；保住最后一种主人解锁方式） */
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
    /* 统一门禁（重置锁屏可删 lock） */
    const mg = await checkPasskeyMgmt(request, env, delClass, 'delete');
    if (!mg.ok) {
      return Response.json(mg.body, { status: mg.status });
    }
    /* A-2：锁屏凭证减到 0 的那次删除，只在 owner 已有效配置时允许；
       owner 未配置时禁止（403 last-key，文案不变）。判断在任何 mutation 之前。 */
    if (delClass === PK_CLASS_LOCK) {
      let hasLockPw = false;
      try {
        const pwRec = await kv.get(REALM_LOCK.kv.password, 'json');
        hasLockPw = !!(pwRec && pwRec.hash);
      } catch (e) {}
      const keys = await getPasskeys(kv);
      const lockKeys = keys.filter(function (k) { return (k.class || PK_CLASS_LOCK) === PK_CLASS_LOCK; });
      /* 删后锁屏凭证归零：无锁屏密码且只剩这一把 lock 钥匙 */
      if (!hasLockPw && lockKeys.length <= 1) {
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
    /* 先推进纪元，成功才删（fail closed；纪元推进失败则密钥仍在）。
       删 lock 类 → session-epoch +1（踢掉其他设备），同响应重签门票与当前设备会话。 */
    let newEpoch = null;
    try {
      const v = parseInt(await kv.get(SESSION_EPOCH_KEY) || '0', 10) || 0;
      newEpoch = v + 1;
      await kv.put(SESSION_EPOCH_KEY, String(newEpoch));
    } catch (e) {
      return Response.json({ ok: false, error: 'epoch' }, { status: 503 });
    }
    await deletePasskey(kv, credId);
    /* 删完后若锁屏层已无凭证：账号已配置 → 保留 layer:lock（根凭证代开继续被拒，
       锁屏只显示访客 + 重置）；账号未配置（竞态）→ 清 layer:lock。 */
    try {
      const keys = await getPasskeys(kv);
      const hasLockKey = keys.some(function (k) { return (k.class || PK_CLASS_LOCK) === PK_CLASS_LOCK; });
      let hasLockPw = false;
      try { const r = await kv.get(REALM_LOCK.kv.password, 'json'); hasLockPw = !!(r && r.hash); } catch (e) {}
      if (!hasLockKey && !hasLockPw) {
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
    /* 纪元推进后重签门票 + 当前设备会话，保持门内连续操作不中断、当前设备不掉线。 */
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (newEpoch !== null) {
      await reissueDoorWithEpoch(env, headers, mg.door, mg.dv, newEpoch);
      /* 当前设备会话重签（lockreset 无会话时 mg.sess 为 null，helper 内部跳过） */
      await reissueSessionWithEpoch(env, headers, mg.sess, newEpoch);
    }
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  return Response.json({ ok: false, error: 'params' }, { status: 400 });
}
