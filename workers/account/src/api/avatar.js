/**
 * PUT / DELETE /api/avatar —— 换头像、恢复默认头像（读取在 GET /avatar/<尺寸>.webp）。
 *
 * PUT（multipart/form-data，字段 32 / 96 / 192 / 512 各一张图）
 * - 只有 admin 会话（网关写的身份头，AccountService 读，见 src/entrypoints.js headerAuth）；必须同源。
 * - 图在前端裁好、缩好（Workers 里没有图片库），这里只校验格式（WebP 或 PNG 文件头）和大小。
 * - 先写四张图，最后写版本号 avatar:ver；返回 { ok:true, ver }。
 *
 * DELETE
 * - 只有 admin 会话；必须同源。先删版本号（立刻回到默认图），再删四张图。
 */
import { isSameOrigin, originDenied, json, apiError } from '../lib/http.js';
import { AVATAR_SIZES, AVATAR_MAX, KEY_VER, keyOf, sniffImage, NO_STORE, avatarKv } from '../lib/avatar.js';
import { ROLE_ADMIN } from '../identity/account.js';

/** 锁屏身份来自网关写的 X-Styrigx-Lock-Role（context.auth，见 src/entrypoints.js headerAuth） @param {any} context */
async function isAdmin(context) {
  const sess = await context.auth.lockSession();
  return sess.ok && sess.role === ROLE_ADMIN;
}

/** @param {any} context */
export async function onRequestPut(context) {
  const { request, env } = context;
  if (!isSameOrigin(request)) return originDenied();
  if (!(await isAdmin(context))) return apiError(403, 'role', undefined, NO_STORE);
  const kv = avatarKv(env);
  if (!kv) return apiError(500, 'server', undefined, NO_STORE);
  /** @type {FormData} */
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return apiError(400, 'bad-form', undefined, NO_STORE);
  }
  /** @type {{s:number, buf:ArrayBuffer, type:string}[]} */
  const imgs = [];
  for (const s of AVATAR_SIZES) {
    const f = form.get(String(s));
    if (!f || typeof f === 'string') return apiError(400, 'missing', undefined, NO_STORE);
    const buf = await f.arrayBuffer();
    if (buf.byteLength > AVATAR_MAX[/** @type {32|96|192|512} */ (s)]) {
      return apiError(413, 'too-large', undefined, NO_STORE);
    }
    const type = sniffImage(new Uint8Array(buf));
    if (!type) return apiError(415, 'bad-type', undefined, NO_STORE);
    imgs.push({ s, buf, type });
  }
  try {
    for (const it of imgs) await kv.put(keyOf(it.s), it.buf, { metadata: { type: it.type } });
    const ver = Date.now().toString(36);
    await kv.put(KEY_VER, ver);
    return json(200, { ok: true, ver }, NO_STORE);
  } catch (e) {
    return apiError(500, 'server', undefined, NO_STORE);
  }
}

/** @param {any} context */
export async function onRequestDelete(context) {
  const { request, env } = context;
  if (!isSameOrigin(request)) return originDenied();
  if (!(await isAdmin(context))) return apiError(403, 'role', undefined, NO_STORE);
  const kv = avatarKv(env);
  if (!kv) return apiError(500, 'server', undefined, NO_STORE);
  try {
    await kv.delete(KEY_VER);
    for (const s of AVATAR_SIZES) await kv.delete(keyOf(s));
    return json(200, { ok: true }, NO_STORE);
  } catch (e) {
    return apiError(500, 'server', undefined, NO_STORE);
  }
}
