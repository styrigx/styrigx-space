/**
 * 锁屏凭证配置查询（补充定稿七.1）。
 *
 * GET /api/lock-config → { ok:true, passkey:bool, password:bool }
 * - 无需鉴权（锁屏页无会话时调用）。
 * - 只返回「是否已设置」，不返回任何敏感数据。
 * - 任何读取失败一律按「已配置」处理（passkey/password 均为 true），
 *   避免失败时暴露根凭证入口（fail closed）。
 *
 * passkey：owner-passkey-index 中存在 class='lock' 的凭据（无 class 的旧凭据视为 lock）。
 * password：lock-pw 存在且有 hash。
 */
const PK_CLASS_LOCK = 'lock';

/**
 * @param {any} context
 */
export async function onRequestGet(context) {
  try {
    const kv = context.env && context.env.OWNER_KV;
    /* 默认已配置（fail closed）：无 KV 或任何读取失败都不暴露根凭证入口 */
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
    return Response.json(
      { ok: true, passkey: passkey, password: password },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (e) {
    /* 外层兜底：同样按已配置处理 */
    return Response.json(
      { ok: true, passkey: true, password: true },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
