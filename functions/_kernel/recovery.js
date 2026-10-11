/**
 * 2.11：恢复开关（SGX_RECOVERY_UNTIL）。
 *
 * 可选环境变量 SGX_RECOVERY_UNTIL（ISO 8601 带时区，如 2026-10-12T10:00:00+08:00）。
 * 仅当同时满足以下四条时视为开启：
 * 1. 存在且非空
 * 2. 可解析为有效时间（必须带时区：Z 或 ±HH:MM / ±HHMM）
 * 3. 未过期（until > now）
 * 4. 距今不超过 24 小时（until - now <= 24h）
 * 否则一律关闭（fail closed）。
 *
 * 开启时，重置锁屏可只用根凭证（by=root, via=switch），权限与 lockreset 完全相同；
 * 开启时单用站长凭证仍不能重置。
 */

/* 带时区的 ISO 8601 后缀：Z 或 ±HH:MM / ±HHMM / ±HH */
const TZ_SUFFIX_RE = /(Z|[+-]\d{2}:?\d{2})$/i;
/* 24 小时（毫秒） */
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

/**
 * 解析 SGX_RECOVERY_UNTIL。
 * @param {any} env
 * @returns {{enabled:boolean, until:number|null, reason:string}}
 *   reason: 'ok' | 'missing' | 'bad-format' | 'expired' | 'too-far'
 */
export function parseRecoveryUntil(env) {
  const raw = (env && env.SGX_RECOVERY_UNTIL) || '';
  if (!raw || typeof raw !== 'string') {
    return { enabled: false, until: null, reason: 'missing' };
  }
  const s = raw.trim();
  if (!TZ_SUFFIX_RE.test(s)) {
    return { enabled: false, until: null, reason: 'bad-format' };
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) {
    return { enabled: false, until: null, reason: 'bad-format' };
  }
  const now = Date.now();
  if (t <= now) {
    return { enabled: false, until: null, reason: 'expired' };
  }
  if (t - now > MAX_FUTURE_MS) {
    return { enabled: false, until: null, reason: 'too-far' };
  }
  return { enabled: true, until: t, reason: 'ok' };
}

/**
 * 恢复开关是否开启（fail closed：任何异常都返回 false）。
 * @param {any} env
 * @returns {boolean}
 */
export function isRecoveryEnabled(env) {
  try {
    return parseRecoveryUntil(env).enabled;
  } catch (e) {
    return false;
  }
}
