/**
 * v6 2g 设备标记（定稿 v5.5 §十一：「sessions……2g 加可空设备列，su 时发长期设备标记写入，老会话留空不回填」；
 * 「设备标记 cookie 名 sgx-device、有效期 400 天，设备列表按它合并同一台设备的会话」，Gray 2026-11-11 17:49、19:59）。
 *
 * - cookie sgx-device：12 字节随机（base64url 16 字符，同旧 account_device 的 deviceId 格式；isDeviceId / newDeviceId 原在 core/devices.js，v6 清理 #11/#12 删旧设备模块时搬到本文件），
 *   HttpOnly、Secure、SameSite=Lax、Path=/，Max-Age 400 天；不是凭据（只用来把同一台设备的会话归在一起），鉴权从不读它。
 * - su <用户> 签发会话时：请求带合法的 sgx-device 就沿用（同一台设备），没有就新发；写进 account_sessions.device，并把 cookie 续到 400 天。
 *
 * 只 import lib/。
 */
import { readCookie } from '../lib/cookies.js';
import { b64urlEnc } from '../lib/crypto.js';

/** 设备标记：只认 [A-Za-z0-9_-]{8,32}，不含 '.' @param {any} v */
export function isDeviceId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,32}$/.test(v);
}

/** 新设备标记：12 字节随机，base64url（16 字符，不含 '.'） */
export function newDeviceId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return b64urlEnc(b);
}

/** cookie 名（定稿 v5.5 §十一） */
export const DEVICE_COOKIE = 'sgx-device';
/** 有效期 400 天（秒；定稿 v5.5 §十一，同浏览器 cookie 上限） */
export const DEVICE_MAX_AGE = 400 * 24 * 60 * 60;

/** 请求里合法的设备标记（没有 / 不合法 → ''） @param {Request} request */
export function readDeviceMark(request) {
  const v = readCookie(request, DEVICE_COOKIE) || '';
  return isDeviceId(v) ? v : '';
}

/** 这次签发用哪个设备标记：沿用请求里的，没有就新发 @param {Request} request */
export function deviceMarkFor(request) {
  return readDeviceMark(request) || newDeviceId();
}

/** 设设备标记 cookie 的 Set-Cookie 值 @param {string} mark */
export function deviceCookie(mark) {
  return DEVICE_COOKIE + '=' + mark + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + DEVICE_MAX_AGE;
}

