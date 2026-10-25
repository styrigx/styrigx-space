/**
 * PUT / DELETE /api/avatar —— 换头像、恢复默认头像（读取在 GET /avatar/<尺寸>.webp）。
 *
 * PUT（multipart/form-data，字段 32 / 96 / 192 / 512 各一张图）
 * - 只有 admin 会话（网关 AuthVerifier 验，见 src/auth.js）；必须同源。
 * - 图在前端裁好、缩好（Workers 里没有图片库），这里只校验格式（WebP 或 PNG 文件头）和大小。
 * - 先写四张图，最后写版本号 avatar:ver；返回 { ok:true, ver }。
 *
 * DELETE
 * - 只有 admin 会话；必须同源。先删版本号（立刻回到默认图），再删四张图。
 */
import { isSameOrigin, originDenied } from '../lib/http.js';
import { AVATAR_SIZES, AVATAR_MAX, KEY_VER, keyOf, sniffImage, NO_STORE, avatarKv } from '../lib/avatar.js';
import { ROLE_ADMIN } from '../auth.js';

/** 会话由网关验（context.auth，见 src/auth.js） @param {any} context */
async function isAdmin(context) {
  const sess = await context.auth.lockSession();
  return sess.ok && sess.role === ROLE_ADMIN;
}

/** @param {any} context */
export async function onRequestPut(context) {
  const { request, env } = context;
  if (!isSameOrigin(request)) return originDenied();
  if (!(await isAdmin(context))) return Response.json({ ok: false, error: 'role' }, { status: 403, headers: NO_STORE });
  const kv = avatarKv(env);
  if (!kv) return Response.json({ ok: false, error: 'server' }, { status: 500, headers: NO_STORE });
  /** @type {FormData} */
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return Response.json({ ok: false, error: 'bad-form' }, { status: 400, headers: NO_STORE });
  }
  /** @type {{s:number, buf:ArrayBuffer, type:string}[]} */
  const imgs = [];
  for (const s of AVATAR_SIZES) {
    const f = form.get(String(s));
    if (!f || typeof f === 'string') return Response.json({ ok: false, error: 'missing' }, { status: 400, headers: NO_STORE });
    const buf = await f.arrayBuffer();
    if (buf.byteLength > AVATAR_MAX[/** @type {32|96|192|512} */ (s)]) {
      return Response.json({ ok: false, error: 'too-large' }, { status: 413, headers: NO_STORE });
    }
    const type = sniffImage(new Uint8Array(buf));
    if (!type) return Response.json({ ok: false, error: 'bad-type' }, { status: 415, headers: NO_STORE });
    imgs.push({ s, buf, type });
  }
  try {
    for (const it of imgs) await kv.put(keyOf(it.s), it.buf, { metadata: { type: it.type } });
    const ver = Date.now().toString(36);
    await kv.put(KEY_VER, ver);
    return Response.json({ ok: true, ver }, { headers: NO_STORE });
  } catch (e) {
    return Response.json({ ok: false, error: 'server' }, { status: 500, headers: NO_STORE });
  }
}

/** @param {any} context */
export async function onRequestDelete(context) {
  const { request, env } = context;
  if (!isSameOrigin(request)) return originDenied();
  if (!(await isAdmin(context))) return Response.json({ ok: false, error: 'role' }, { status: 403, headers: NO_STORE });
  const kv = avatarKv(env);
  if (!kv) return Response.json({ ok: false, error: 'server' }, { status: 500, headers: NO_STORE });
  try {
    await kv.delete(KEY_VER);
    for (const s of AVATAR_SIZES) await kv.delete(keyOf(s));
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    return Response.json({ ok: false, error: 'server' }, { status: 500, headers: NO_STORE });
  }
}
