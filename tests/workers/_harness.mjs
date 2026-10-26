/**
 * Worker 单测的公共测试台。纯工具（derToPem、makeKV）的实现在 _harness.cjs（e2e 的 CJS 测试台也用它），这里转出。
 *
 * - derToPem(der, label) / makeKV(seed?, opts?)：见 _harness.cjs
 * - genKeyPair()：一对临时 Ed25519 钥匙 { priv, pub }（PEM），当 SGX_LOCK_* / SGX_ACCOUNT_* 用
 * - postReq(url, body, headers?)：JSON POST；默认带 Content-Type 和 Origin（= url 的 origin，真实浏览器 POST 必带）；
 *   headers 里 Origin: null 表示不带 Origin
 *
 * 带元数据的 KV 替身（getWithMetadata：头像、云同步、auth-worker / security-headers 里写死 lock-epoch 的那份）
 * 行为各不相同，留在各自的测试文件里。
 */
import harness from './_harness.cjs';

/** @type {(der: ArrayBuffer|Uint8Array, label: string) => string} */
export const derToPem = harness.derToPem;
/** @type {(seed?: Record<string, any>, opts?: {throwOn?: ((k: string) => boolean) | null}) => any} */
export const makeKV = harness.makeKV;

/** @returns {Promise<{priv: string, pub: string}>} */
export async function genKeyPair() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    priv: derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY'),
    pub: derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY'),
  };
}

/**
 * @param {string} url
 * @param {any} body
 * @param {Record<string, string|null>} [headers]
 */
export function postReq(url, body, headers = {}) {
  /** @type {Record<string, any>} */
  const h = { 'Content-Type': 'application/json', 'Origin': new URL(url).origin, ...headers };
  if (h['Origin'] === null) delete h['Origin'];
  return new Request(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
}
