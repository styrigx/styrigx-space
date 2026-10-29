/**
 * 内部请求头名（共享常量，账号拆分 PR1）。
 *
 * 只有常量，不含逻辑：网关把锁屏身份、客户端上下文转给下游 Worker 时用的头名，两边都从这里取，免得各写一份字面量。
 * 头名大小写不敏感（Headers 会统一小写）；剥离外来同名头时按 INTERNAL_HEADER_PREFIX（小写）匹配前缀。
 *
 * 本 PR 只定义常量，还没有任何地方读写这些头（零行为变化）。
 */

/** 锁屏身份：角色、凭什么解的锁、临时钥匙 id */
export const LOCK_IDENTITY_HEADERS = Object.freeze({
  role: 'X-Styrigx-Lock-Role',
  by: 'X-Styrigx-Lock-By',
  tempkeyId: 'X-Styrigx-Lock-Tempkey-Id',
});

/** 客户端上下文：地址、国家、城市 */
export const CLIENT_CONTEXT_HEADERS = Object.freeze({
  address: 'X-Styrigx-Client-Address',
  country: 'X-Styrigx-Client-Country',
  city: 'X-Styrigx-Client-City',
});

/** 所有内部头的公共前缀（小写） */
export const INTERNAL_HEADER_PREFIX = 'x-styrigx-';
