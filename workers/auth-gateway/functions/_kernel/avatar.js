/**
 * @fileoverview 主站头像的公共定义：尺寸、上限、KV 键名、格式识别、读取。
 * GET /avatar/<尺寸>.webp（functions/avatar/[file].js）和
 * PUT/DELETE /api/avatar（functions/api/avatar.js）共用。
 */

export const AVATAR_SIZES = [32, 96, 192, 512];
/* 每个尺寸的上限（字节）：给足余量，正常照片远小于此 */
export const AVATAR_MAX = { 32: 64 * 1024, 96: 128 * 1024, 192: 384 * 1024, 512: 1536 * 1024 };
export const KEY_VER = 'avatar:ver';

/**
 * 头像存在 KV_PROFILE（账号资料库 styrigx-account 里的 avatar:*）。
 * 没绑 → null（上传 / 移除 500，读取走默认头像）。
 * @param {any} env
 */
export function avatarKv(env) {
  return (env && env.KV_PROFILE) || null;
}
/** @param {number} s */
export const keyOf = (s) => 'avatar:' + s;
export const PUBLIC_CACHE = 'public, max-age=300, stale-while-revalidate=2592000';
export const NO_STORE = { 'Cache-Control': 'private, no-store' };

/**
 * 看文件头认格式：WebP（RIFF....WEBP）或 PNG（\x89PNG\r\n\x1a\n）。其他一律不收。
 * @param {Uint8Array} b
 * @returns {'image/webp'|'image/png'|''}
 */
export function sniffImage(b) {
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  return '';
}

/**
 * /avatar/<尺寸>.webp 里的尺寸：只认 AVATAR_SIZES，其他返回 0。
 * @param {string} file 例如 '96.webp'
 */
export function sizeOfFile(file) {
  const m = /^(\d+)\.webp$/.exec(String(file || ''));
  const n = m ? parseInt(m[1], 10) : 0;
  return AVATAR_SIZES.includes(n) ? n : 0;
}

