/**
 * 共享加密工具（各凭证接口共用）。
 *
 * timingSafeEqual：先对两边各做一次 SHA-256 再比较，避免长度不等时提前返回泄露长度信息。
 * Ed25519 签名 / 验签：会话票、门票都用它；签名串由调用方带用途前缀做域隔离。
 */

/** @param {ArrayBuffer|Uint8Array} s */
export function b64enc(s) {
  const u8 = s instanceof Uint8Array ? s : new Uint8Array(s);
  return btoa(String.fromCharCode(...u8));
}

/** @param {string} b64 */
export function b64dec(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

/** @param {string} b64 */
export function b64urlEnc(s) {
  return b64enc(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 恒定时间比较（防时序攻击 + 防长度泄露）。
 * 两边先各做 SHA-256，长度恒为 32 字节，再逐字节比较。
 * @param {string} a
 * @param {string} b
 */
export async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const ba = new Uint8Array(ha);
  const bb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

/**
 * 根凭证规范化（批次 A 收尾 B2）：去掉所有空白字符（空格、制表符、换行 \r \n）。
 * 根凭证是单行密码框输入，粘贴多行时浏览器会去掉换行；服务端两边（提交值与
 * SGX_ROOT_KEY）都用同一函数规范化后再比对。去空白后为空一律拒绝。
 * 只有根凭证这样处理；站长密码、解锁密码不做任何规范化。
 * @param {string} s
 * @returns {string}
 */
export function normalizeRootKey(s) {
  return String(s || '').replace(/\s+/g, '');
}

/**
 * Ed25519 签名（主站签发会话 cookie 用）。
 * @param {string} privatePem PKCS8 PEM 格式私钥
 * @param {string} payload 待签名内容
 * @returns {Promise<string>} base64url 签名
 */
export async function ed25519Sign(privatePem, payload) {
  const pem = privatePem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const der = b64dec(pem);
  const key = await crypto.subtle.importKey(
    'pkcs8', der, { name: 'Ed25519' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(payload));
  return b64urlEnc(sig);
}

/**
 * Ed25519 验签（子站 验证会话 cookie 用，主站自验也用）。
 * @param {string} publicPem SPKI PEM 格式公钥
 * @param {string} payload 原文
 * @param {string} sigB64url base64url 签名
 * @returns {Promise<boolean>}
 */
export async function ed25519Verify(publicPem, payload, sigB64url) {
  try {
    const pem = publicPem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
    const der = b64dec(pem);
    const key = await crypto.subtle.importKey(
      'spki', der, { name: 'Ed25519' }, false, ['verify']
    );
    const sig = b64dec(sigB64url.replace(/-/g, '+').replace(/_/g, '/'));
    return await crypto.subtle.verify(
      'Ed25519', key, sig, new TextEncoder().encode(payload)
    );
  } catch (e) {
    return false;
  }
}
