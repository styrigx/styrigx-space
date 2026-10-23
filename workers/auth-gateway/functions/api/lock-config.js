/**
 * 锁屏凭证配置查询（补充定稿七.1，复审 §2 修正）。
 *
 * GET /api/lock-config → { ok:true, passkey:bool, password:bool,
 *   ownerConfigured:bool, resetOnly:bool }
 * - 无需鉴权（锁屏页无会话时调用）。
 * - 只返回「是否已设置」，不返回任何敏感数据。
 * - 口径统一：用 _kernel/layers.js 的 isLockEffectivelyConfigured。
 *   KV 标记 layer:lock 为 '1'、或真实锁屏凭证存在、或任何读取失败，
 *   都算已配置（passkey/password 均为 true），避免失败时暴露根凭证入口
 *   （fail closed）。只剩标记（无真实凭证）时同样不显示根凭证入口，
 *   避免 root-auth 走假入口 401 导致锁死。
 * - A-2：新增 ownerConfigured（站长层是否有效配置）、
 *   resetOnly（锁屏真实凭证为 0 且 owner 已配置 →
 *   锁屏只显示访客 + 重置锁屏，不显示根凭证入口）。
 *   layer:lock-emptied 是 B #10 的键，A-2 不读不写（生产残留被忽略）。
 */
import { isLockEffectivelyConfigured, isAccountEffectivelyConfigured } from '../_kernel/layers.js';
import { STORE_CLASS_LOCKKEY as PK_CLASS_LOCK, ownerPasskeyKey, OWNER_PASSKEY_PREFIX } from '../_kernel/key-names.js';
import { REALM_LOCK } from '../_kernel/realms.js';

/**
 * @param {any} context
 */
export async function onRequestGet(context) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const kv = context.env && context.env.KV_LOCK_DOOR;
    /* 口径统一：标记或真实凭证任一存在、或读取失败，都算已配置 */
    let effective = true;
    if (kv) {
      try {
        effective = await isLockEffectivelyConfigured(kv);
      } catch (e) {
        effective = true;
      }
    }
    /* A-2：站长层是否有效配置（fail closed：读取失败按已配置） */
    let ownerConfigured = true;
    if (kv) {
      try {
        ownerConfigured = await isAccountEffectivelyConfigured(kv);
      } catch (e) {
        ownerConfigured = true;
      }
    }
    if (!effective) {
      /* 确定未配置：显示根凭证入口（A 启动流程保留；resetOnly 不置，
         否则 owner 已配置、lock 从未配置的站会丢根凭证代开入口） */
      return Response.json(
        { ok: true, passkey: false, password: false, ownerConfigured: ownerConfigured, resetOnly: false },
        { headers }
      );
    }
    /* 已配置：返回 granular 状态（默认 true，确认不存在才设 false）。
       标记独有（无真实凭证）时 granular 全否 → 仍按已配置处理，不暴露根凭证入口。 */
    let password = true;
    let passkey = true;
    let failed = false;
    if (kv) {
      try {
        const pw = await kv.get(REALM_LOCK.kv.password, 'json');
        password = !!(pw && pw.hash);
      } catch (e) {
        failed = true;
      }
      try {
        let hasLock = false;
        let idx = null;
        try {
          idx = await kv.get('owner-passkey-index', 'json');
        } catch (e) {
          failed = true;
        }
        if (!failed) {
          if (Array.isArray(idx)) {
            for (const credId of idx) {
              try {
                const v = await kv.get(ownerPasskeyKey(credId), 'json');
                if (v && v.credId && (v.class || PK_CLASS_LOCK) === PK_CLASS_LOCK) {
                  hasLock = true;
                  break;
                }
              } catch (e) {
                failed = true;
                break;
              }
            }
          } else {
            /* 索引不存在：用 kv.list 补查一次 */
            try {
              const list = await kv.list({ prefix: OWNER_PASSKEY_PREFIX });
              for (const k of (list && list.keys) || []) {
                try {
                  const v = await kv.get(k.name, 'json');
                  if (v && v.credId && (v.class || PK_CLASS_LOCK) === PK_CLASS_LOCK) {
                    hasLock = true;
                    break;
                  }
                } catch (e) {
                  failed = true;
                  break;
                }
              }
            } catch (e) {
              failed = true;
            }
          }
          if (!failed) passkey = hasLock;
        }
      } catch (e) {
        failed = true;
      }
      if (failed) {
        password = true;
        passkey = true;
      }
    }
    /* 标记独有场景：effective 为真但 granular 全否 → 不暴露根凭证入口。
       「锁屏凭证已删光」按真实凭证数判断（无 lock 密码且无 lock 通行密钥）：
       owner 已配置时 resetOnly（锁屏只显示访客 + 重置锁屏）。 */
    let resetOnly = false;
    if (!password && !passkey) {
      resetOnly = ownerConfigured && !failed;
      password = true;
      passkey = true;
    }
    return Response.json(
      { ok: true, passkey: passkey, password: password, ownerConfigured: ownerConfigured, resetOnly: resetOnly },
      { headers }
    );
  } catch (e) {
    /* 外层兜底：同样按已配置处理 */
    return Response.json(
      { ok: true, passkey: true, password: true, ownerConfigured: true, resetOnly: false },
      { headers }
    );
  }
}
