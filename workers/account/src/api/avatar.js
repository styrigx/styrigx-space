/**
 * PUT / DELETE /api/avatar —— 换头像、恢复默认头像（读取在 GET /avatar/<尺寸>.webp）。
 *
 * PUT（multipart/form-data，字段 32 / 96 / 192 / 512 各一张图）
 * - v6 会话、路由档 owner（站长 + root，src/gate.js scopeDenial → core/route-access.js）；必须同源。没有 → 401 session。
 *   v6 P4（定稿 v5.2 §十三）起旧进站会话 + 账号会话 + 作用域 avatar.write 删除。
 * - 图在前端裁好、缩好（Workers 里没有图片库），这里只校验格式（WebP 或 PNG 文件头）和大小。
 * - 先写四张图，最后写版本号 avatar:ver；返回 { ok:true, ver }。
 *
 * DELETE
 * - 同 PUT；必须同源。先删版本号（立刻回到默认图），再删四张图。
 *
 * v6 P4-3（定稿 v5.5 §七「全站只有一份配置（头像、偏好、名片等），归站长 styrigx；root 与站长共同持有；普通用户只能看」）：
 * 写的永远是站长那一份（lib/avatar.js avatarPrefix(1000) = 原来的 avatar:*，站点头像），不再按会话 uid 分；
 * root 直接写、站长直接写（路由档 owner），普通用户 403。P2 期间别的 uid 写下的 avatar:u<uid>:* 不再读写（留在 KV，删不删见 PR 未决）。
 */
import { isSameOrigin, originDenied, json, apiError } from '../lib/http.js';
import { AVATAR_SIZES, AVATAR_MAX, keyOf, verKeyOf, sniffImage, NO_STORE, avatarKv } from '../lib/avatar.js';
import { scopeDenial } from '../gate.js';
import { STYRIGX_UID } from '../core/groups.js';

/** 本接口的作用域名（只作标注：scopeDenial 只看 v6 身份；作用域表 core/scopes.js 随应用授权删除，定稿 v5.3 §十二） */
const SCOPE = 'avatar.write';

/** @param {any} context */
export async function onRequestPut(context) {
  const { request, env } = context;
  if (!isSameOrigin(request)) return originDenied();
  const denied = await scopeDenial(context.auth, SCOPE, NO_STORE);
  if (denied) return denied;
  if ((await context.auth.dataUid()) === null) return apiError(401, 'unauthorized', undefined, NO_STORE);
  const uid = STYRIGX_UID; /* 一份配置，归站长（定稿 v5.5 §七） */
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
    for (const it of imgs) await kv.put(keyOf(it.s, uid), it.buf, { metadata: { type: it.type } });
    const ver = Date.now().toString(36);
    await kv.put(verKeyOf(uid), ver);
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
  if ((await context.auth.dataUid()) === null) return apiError(401, 'unauthorized', undefined, NO_STORE);
  const uid = STYRIGX_UID; /* 一份配置，归站长（定稿 v5.5 §七） */
  const kv = avatarKv(env);
  if (!kv) return apiError(500, 'server', undefined, NO_STORE);
  try {
    await kv.delete(verKeyOf(uid));
    for (const s of AVATAR_SIZES) await kv.delete(keyOf(s, uid));
    return json(200, { ok: true }, NO_STORE);
  } catch (e) {
    return apiError(500, 'server', undefined, NO_STORE);
  }
}
