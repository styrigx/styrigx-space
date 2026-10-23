/**
 * GET /avatar/<尺寸>.webp（尺寸 32 / 96 / 192 / 512）—— 主站头像，公开。
 * 主站顶栏、首页名片、锁屏、设置账户卡、标签页图标，以及博客的头像和图标都读这里。
 *
 * - 主人上传过（KV_PROFILE 有 avatar:ver）→ 读 `avatar:<尺寸>`；
 *   否则交给静态资源 static/avatar/<尺寸>.webp（默认头像；本地静态服务器测试时也直接命中它）。
 * - Cache-Control: public, max-age=300, stale-while-revalidate=30 天（换头像后最多旧一次）；
 *   ETag = "<版本>-<尺寸>"，默认图是 "d-<尺寸>"；If-None-Match 命中回 304。
 *   设置页靠 ETag 是不是 "d-" 开头判断有没有自定义头像。
 * - 不认识的尺寸 → 404。
 */
import { sizeOfFile, keyOf, KEY_VER, PUBLIC_CACHE, NO_STORE, avatarKv } from '../_kernel/avatar.js';

/** @param {any} context */
export async function onRequestGet(context) {
  const { request, env, params } = context;
  const s = sizeOfFile(params && params.file);
  if (!s) return new Response(null, { status: 404, headers: NO_STORE });
  const kv = avatarKv(env);
  let ver = '';
  /** @type {ArrayBuffer|null} */
  let body = null;
  let type = 'image/webp';
  if (kv) {
    try {
      ver = (await kv.get(KEY_VER, { cacheTtl: 60 })) || '';
      if (ver) {
        const r = await kv.getWithMetadata(keyOf(s), { type: 'arrayBuffer', cacheTtl: 60 });
        if (r && r.value) {
          body = r.value;
          if (r.metadata && r.metadata.type) type = r.metadata.type;
        } else {
          ver = '';
        }
      }
    } catch (e) {
      ver = '';
      body = null;
    }
  }
  const etag = '"' + (ver || 'd') + '-' + s + '"';
  /** @type {Record<string,string>} */
  const headers = {
    'Cache-Control': PUBLIC_CACHE,
    'ETag': etag,
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
  if ((request.headers.get('If-None-Match') || '') === etag) {
    return new Response(null, { status: 304, headers });
  }
  if (body) return new Response(body, { headers });
  /* 默认头像：静态资源，读出来再套上同样的缓存头和 ETag */
  try {
    const res = await env.ASSETS.fetch(new URL('/avatar/' + s + '.webp', request.url));
    if (res.ok) return new Response(res.body, { headers });
  } catch (e) {}
  return new Response(null, { status: 404, headers: NO_STORE });
}
