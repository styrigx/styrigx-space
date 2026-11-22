// workers/atlas-core/src/games/api/games.js
// 游戏子站的游戏列表与写操作（公开地址 styrigx.com/games/api/games；奇趣重组设计稿 v1.0 第三节 PR 1）。
// 数据和奇趣「游戏」栏同一张表（D1 games），handler 复用奇趣的数据层与写操作（../../curio/api/_items.js、_items-post.js），不复制。
//   GET  公开：{ok, showPrivate, canManage, games:[...]}（showPrivate = games-use，canManage = games-manage，公用 visibility()
//        按命中的路由行 product 'games' 问；看不到私密的只拿公开的；不回设备）
//   POST games-manage + 同源：body {op:'game.add'|'game.edit'|'game.del'|'game.order', ...}（校验见 _items.js parseItemOp；device.* → 400 bad-op）
//        成功 → {ok:true, canManage:true, showPrivate:true, id?, games}（add 带新条目 id，好接着传封面）；删游戏连 R2 封面一起删。
//        400 参数不对；404 不存在；409 limit / mismatch
// 旧地址 /curio/api/items 照常（奇趣重组 PR 3 才删）。game 的 device_id 字段在 PR 2 去掉界面、PR 3 清零，这里原样回。
import { json, err, methodNotAllowed } from '../../curio/api/_lib.js';
import { visibility } from '../../common/visibility.js';
import { ensureItemSchema, listGames } from '../../curio/api/_items.js';
import { postItemOp } from '../../curio/api/_items-post.js';

/** 本接口只收游戏 */
const GAME_KINDS = Object.freeze(['game']);

export async function onRequestGet(context) {
  const { env } = context;
  const vis = await visibility(context);
  if (!env || !env.D1_GAMES) return err('server', 503);
  await ensureItemSchema(env.D1_GAMES);
  return json({ ok: true, ...vis, ...(await listGames(env.D1_GAMES, vis.showPrivate)) });
}

export async function onRequestPost(context) {
  const r = await postItemOp(context, GAME_KINDS);
  if (r.response) return r.response;
  const out = { ok: true, canManage: true, showPrivate: true, ...(await listGames(context.env.D1_GAMES, true)) };
  if (r.id) out.id = r.id;
  return json(out);
}

export function onRequest() {
  return methodNotAllowed('GET, POST');
}
