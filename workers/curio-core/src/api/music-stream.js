// workers/curio-core/src/api/music-stream.js
// GET / HEAD /api/music-stream?t=<令牌>&id=<曲目>   播放短链（<audio src>）：进门（index.js 已验进站会话）+ 令牌有效（_music.js trackForToken：
//   存在、没过期、曲目属于令牌那张专辑）。令牌格式不对 / 不存在 / 过期 / 曲目不对 → 403 token（不分原因）。
// 支持单段 Range（拖进度）：bytes=a-b / a- / -n → 206 + Content-Range；没有 Range → 200 整个文件；Range 不合法 → 416。
// Cache-Control: private, no-store（短链过期后不留在任何缓存里）；Accept-Ranges: bytes；类型按上传时的 Content-Type + nosniff。
import { err, methodNotAllowed } from './_lib.js';
import { ensureMusicSchema, trackForToken, parseRange } from './_music.js';

const NO_STORE = 'private, no-store';

async function serve(context, head) {
  const { request, env } = context;
  if (!env || !env.D1_MUSIC || !env.R2_MUSIC) return err('server', 503);
  const sp = new URL(request.url).searchParams;
  const id = Number(sp.get('id') || '');
  await ensureMusicSchema(env.D1_MUSIC);
  const t = Number.isInteger(id) && id > 0 ? await trackForToken(env.D1_MUSIC, sp.get('t') || '', id, Date.now()) : null;
  if (!t || !t.key) return err('token', 403);
  let size = Number(t.size) || 0;
  if (!size) {
    const h = await env.R2_MUSIC.head(t.key);
    if (!h) return err('not-found', 404);
    size = h.size;
  }
  const base = { 'Content-Type': t.type || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': NO_STORE, 'X-Content-Type-Options': 'nosniff' };
  const range = parseRange(request.headers.get('Range'), size);
  if (range === 'invalid') return new Response(null, { status: 416, headers: { ...base, 'Content-Range': 'bytes */' + size } });
  if (head) return new Response(null, { status: range ? 206 : 200, headers: { ...base, 'Content-Length': String(range ? range.length : size), ...(range ? { 'Content-Range': `bytes ${range.offset}-${range.offset + range.length - 1}/${size}` } : {}) } });
  const obj = range ? await env.R2_MUSIC.get(t.key, { range: { offset: range.offset, length: range.length } }) : await env.R2_MUSIC.get(t.key);
  if (!obj) return err('not-found', 404);
  if (!range) return new Response(obj.body, { status: 200, headers: { ...base, 'Content-Length': String(size) } });
  return new Response(obj.body, {
    status: 206,
    headers: { ...base, 'Content-Length': String(range.length), 'Content-Range': `bytes ${range.offset}-${range.offset + range.length - 1}/${size}` },
  });
}

export function onRequestGet(context) { return serve(context, false); }
export function onRequestHead(context) { return serve(context, true); }

export function onRequest() {
  return methodNotAllowed('GET, HEAD');
}
