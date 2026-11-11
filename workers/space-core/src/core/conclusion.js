/**
 * 网关结论（方案 2.3、4.3；P2-1 授权骨架）。v6 P4（定稿 v5.2 §十三）起进站会话与旧账号会话都删了：
 *
 * - RPC 结论 conclusionFor()：SpaceVerifier.conclusion()（rpc/space-verifier.js）的实现。没有进站会话可验了，一律回
 *   { space: { ok:false, reason:'no-session' }, account: { ok:false, reason:'no-space' } }（denied）。
 *   调用方 curio-core / daymark-core 的 _auth.js 仍先问它、不成立再走 v6（SpaceVerifier.admit）；形状不变，它们不用改。
 * - HTTP 结论头：只剩 X-Styrigx-Account-Session（styrigx-ai 只看这一个头决定私密召回 / 能不能切模型）：
 *   writeV6PrivateConclusion(headers) 先剥再写 1；stripAccountConclusion(headers) 只剥。浏览器带来的同名头在 app.js 第一步
 *   （core/lock-identity.js stripInternalHeaders，剥所有 x-styrigx-*）就已经剥掉，写之前这里再剥一次。
 *
 * 网关里不出现账号票名（space/scripts/check-layers.mjs 规则 16）。不 import 任何东西。
 */

/** 账号结论头（方案 2.3.1）；v6 P4 起只写 session（device / scopes / reauth 随旧账号会话删除，名字留着给剥头用） */
export const ACCOUNT_CONCLUSION_HEADERS = Object.freeze({
  session: 'X-Styrigx-Account-Session',
});

/** 账号结论头的公共前缀（小写） */
export const ACCOUNT_CONCLUSION_PREFIX = 'x-styrigx-account-';

/**
 * @typedef {{ ok: boolean, by: string, linkId: string, reason: string }} LockConclusion
 * @typedef {{ ok: boolean, deviceId: string, scopes: string[], reauth: boolean, reason: string }} AccountConclusion
 * @typedef {{ space: LockConclusion, account: AccountConclusion }} Conclusion
 */

/**
 * 网关结论（SpaceVerifier.conclusion 的实现）：v6 P4 起一律 denied（没有进站会话可验，也不问账号）。永不抛错。
 * 参数留着（RPC 签名不变）：cookieHeader、clientContext、opts 都不读。
 * @returns {Promise<Conclusion>}
 */
export async function conclusionFor() {
  return {
    space: { ok: false, by: '', linkId: '', reason: 'no-session' },
    account: { ok: false, deviceId: '', scopes: [], reauth: false, reason: 'no-space' },
  };
}

/** 这个头名是账号结论头吗（大小写不敏感） @param {string} name */
function isAccountConclusionHeader(name) {
  return String(name || '').toLowerCase().startsWith(ACCOUNT_CONCLUSION_PREFIX);
}

/**
 * 就地删掉所有 X-Styrigx-Account-*（任意大小写），返回同一个对象。
 * @param {Headers|null|undefined} headers
 */
export function stripAccountConclusion(headers) {
  if (!headers) return headers;
  const drop = [];
  for (const [k] of headers) if (isAccountConclusionHeader(k)) drop.push(k);
  for (const k of drop) headers.delete(k);
  return headers;
}

/**
 * 2c（v6 割接）：v6 身份够得上 AI 私密档（账号 Worker ROUTE_ACCESS POST /api/ai 的 action private，经 permits() 判）时写的结论头：
 * 先剥，再只写 X-Styrigx-Account-Session: 1。
 * @param {Headers} headers 要写的头（就地改）
 * @returns {Headers}
 */
export function writeV6PrivateConclusion(headers) {
  stripAccountConclusion(headers);
  headers.set(ACCOUNT_CONCLUSION_HEADERS.session, '1');
  return headers;
}
