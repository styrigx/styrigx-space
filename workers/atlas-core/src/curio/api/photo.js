// workers/core/src/api/photo.js
// 设备照片 / 游戏封面 / 电影海报（R2 R2_PHOTOS：photos/<device|game|movie>/<id>-<时间>.<webp|jpg|png>）。
//   GET    /api/photo?kind=device|game|movie&id=N   公开（v5 S3）；没登录账号拿不到私密条目的图（404，同不存在；电影没有私密）。没照片 404。
//   POST   /api/photo?kind=…&id=N             curio-manage + 同源；body 是图片本身（Content-Type image/webp|jpeg|png，看头几个字节核对），≤ 3 MB。
//                                             换照片：先写新的、再改 D1、最后删旧的。→ {ok:true}
//   DELETE /api/photo?kind=…&id=N             curio-manage + 同源；删照片并清空 D1 里的 key。→ {ok:true}
// 前端上传前在浏览器里缩到长边 1600、转 webp，所以一般只有几百 KB。
// 读 / 换 / 删的规则（私密图看不到 = privateNotFound 404、缓存头、先写新再删旧）在 _photo.js，游戏封面 /games/api/cover 用同一份（奇趣重组 PR 1）；
// 这里只认 ?kind=。
import { methodNotAllowed } from './_lib.js';
import { idParam } from './_write.js';
import { PHOTO_MAX_BYTES, PHOTO_KINDS, photoKind, getPhoto, putPhoto, deletePhoto } from './_photo.js';

/** 看头几个字节认图片类型（实现在 _image.js，音乐封面上传也用；这里保留导出） */
export { sniffImage } from './_image.js';
/** 上限与能带照片的条目（实现在 _photo.js；这里保留导出） */
export { PHOTO_MAX_BYTES, PHOTO_KINDS };

/** ?kind=device|game|movie&id=N → 目标；不认识的 kind / 坏 id → null（400 bad-id） @param {Request} request */
function target(request) {
  const k = photoKind(new URL(request.url).searchParams.get('kind') || '');
  const id = idParam(request);
  return k && id ? { kind: k.kind, K: k.K, id } : null;
}

export function onRequestGet(context) {
  return getPhoto(context, target);
}

export function onRequestPost(context) {
  return putPhoto(context, target);
}

export function onRequestDelete(context) {
  return deletePhoto(context, target);
}

export function onRequest() {
  return methodNotAllowed('GET, POST, DELETE');
}
