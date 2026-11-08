/**
 * PUT / DELETE /api/avatar —— 换头像、恢复默认头像（读取在 GET /avatar/<尺寸>.webp）。
 *
 * PUT（multipart/form-data，字段 32 / 96 / 192 / 512 各一张图）
 * - 进站会话 + 账号会话 + 作用域 avatar.write（方案 3.4 R12；src/gate.js scopeDenial，同一份 core/authorize.js）；必须同源。
 *   没有进站会话 401 session；没账号会话 401 account；没作用域 403 scope。
 * - 图在前端裁好、缩好（Workers 里没有图片库），这里只校验格式（WebP 或 PNG 文件头）和大小。
 * - 先写四张图，最后写版本号 avatar:ver；返回 { ok:true, ver }。
 *
 * DELETE
 * - 同 PUT：进站会话 + 账号会话 + avatar.write；必须同源。先删版本号（立刻回到默认图），再删四张图。
 */
import { isSameOrigin, originDenied, json, apiError } from '../lib/http.js';
import { AVATAR_SIZES, AVATAR_MAX, KEY_VER, keyOf, sniffImage, NO_STORE, avatarKv } from '../lib/avatar.js';
import { scopeDenial } from '../gate.js';

/** 本接口的作用域（core/scopes.js） */
const SCOPE = 'avatar.write';

/** @param {any} context */
export async function onRequestPut(context) {
  const { request, env } = context;
  if (!isSameOrigin(request)) return originDenied();
  const denied = await scopeDenial(context.auth, SCOPE, NO_STORE);
  if (denied) return denied;
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
  const denied = await scopeDenial(context.auth, SCOPE, NO_STORE);
  if (denied) return denied;
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
