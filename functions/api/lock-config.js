/**
 * 锁屏凭证配置查询（补充定稿七.1，复审 §2 修正）。
 *
 * GET /api/lock-config → { ok:true, passkey:bool, password:bool }
 * - 无需鉴权（锁屏页无会话时调用）。
 * - 只返回「是否已设置」，不返回任何敏感数据。
 * - 口径统一：用 _kernel/layers.js 的 isLockEffectivelyConfigured。
 *   KV 标记 layer:lock 为 '1'、或真实锁屏凭证存在、或任何读取失败，
 *   都算已配置（passkey/password 均为 true），避免失败时暴露根凭证入口
 *   （fail closed）。只剩标记（无真实凭证）时同样不显示根凭证入口，
 *   避免 root-auth 走假入口 401 导致锁死。
 */
import { isLockEffectivelyConfigured } from '../_kernel/layers.js';

const PK_CLASS_LOCK = 'lock';

/**
 * @param {any} context
 */
export async function onRequestGet(context) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const kv = context.env && context.env.OWNER_KV;
    /* 口径统一：标记或真实凭证任一存在、或读取失败，都算已配置 */
    let effective = true;
    if (kv) {
      try {
        effective = await isLockEffectivelyConfigured(kv);
      } catch (e) {
        effective = true;
      }
    }
    if (!effective) {
      /* 确定未配置：显示根凭证入口 */
      return Response.json(
        { ok: true, passkey: false, password: false },
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
        const pw = await kv.get('lock-pw', 'json');
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
                const v = await kv.get('owner-passkey:' + credId, 'json');
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
              const list = await kv.list({ prefix: 'owner-passkey:' });
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
    /* 标记独有场景：effective 为真但 granular 全否 → 不暴露根凭证入口 */
    if (!password && !passkey) {
      password = true;
      passkey = true;
    }
    return Response.json(
      { ok: true, passkey: passkey, password: password },
      { headers }
    );
  } catch (e) {
    /* 外层兜底：同样按已配置处理 */
    return Response.json(
      { ok: true, passkey: true, password: true },
      { headers }
    );
  }
}
