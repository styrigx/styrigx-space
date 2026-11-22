// workers/atlas-core/src/games/api/cover.js
// 游戏封面（公开地址 styrigx.com/games/api/cover?id=N；奇趣重组设计稿 v1.0 第三节 PR 1）。
// 和奇趣 /curio/api/photo?kind=game&id=N 是同一张图（R2 photos/game/<id>-<时间>.<ext>，D1 games.cover），
// 读 / 换 / 删的规则复用 ../../curio/api/_photo.js（不复制），这里只把 kind 固定成 game：
//   GET    公开；私密游戏的封面没有 games-use 看不到（privateNotFound，按命中的路由行 product 'games' 问）= 404，同不存在。没封面 404。
//   POST   games-manage + 同源；body 是图片本身（webp / jpeg / png，看字节），≤ 3 MB。→ {ok:true}
//   DELETE games-manage + 同源；删封面并清空 games.cover。→ {ok:true}
// 坏 id → 400 bad-id。旧地址 /curio/api/photo 照常（奇趣重组 PR 3 才删）。
import { methodNotAllowed } from '../../curio/api/_lib.js';
import { idParam } from '../../curio/api/_write.js';
import { photoKind, getPhoto, putPhoto, deletePhoto } from '../../curio/api/_photo.js';

const GAME = /** @type {{kind: string, K: any}} */ (photoKind('game'));

/** ?id=N → 这一款游戏；坏 id → null（400 bad-id） @param {Request} request */
function target(request) {
  const id = idParam(request);
  return id ? { kind: GAME.kind, K: GAME.K, id } : null;
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
