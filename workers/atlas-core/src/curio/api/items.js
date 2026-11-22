// workers/core/src/api/items.js
// GET  /api/items   公开（v5 S3）：{ok, canManage, showPrivate, devices:[...], games:[...]}（showPrivate = curio-use，canManage = curio-manage，公用 visibility()）；看不到私密的只拿公开的（见 _items.js listItems）。
// POST /api/items   curio-manage + 同源：body {op:'device.add'|'device.edit'|'device.del'|'device.order'|'game.*', ...}（校验见 _items.js parseItemOp）。
//                   成功 → {ok:true, canManage:true, showPrivate:true, id?, devices, games}（带回最新全部，前端整页重画；add 带新条目 id，好接着传照片）
//                   删条目时它的照片从 R2 一起删（R2 删失败不影响结果，只记日志）。
//                   400 参数不对；404 不存在（含关联的设备不存在）；409 limit / mismatch
//                   门槛、校验、执行、删照片在 _items-post.js（游戏 POST /games/api/games 用同一份，只收 game.*；奇趣重组 PR 1）。
import { json, err, methodNotAllowed } from './_lib.js';
import { visibility } from '../../common/visibility.js';
import { ensureItemSchema, listItems } from './_items.js';
import { postItemOp } from './_items-post.js';

/** 本接口收的条目（op 前缀） */
const ITEM_KINDS = Object.freeze(['device', 'game']);

export async function onRequestGet(context) {
  const { env } = context;
  const vis = await visibility(context);
  /* 设备 + 游戏一起读是跨两套数据的一个 batch：用主表 devices 的绑定 D1_DEVICES（见 _items.js listItems） */
  if (!env || !env.D1_DEVICES) return err('server', 503);
  await ensureItemSchema(env.D1_DEVICES);
  return json({ ok: true, ...vis, ...(await listItems(env.D1_DEVICES, vis.showPrivate)) });
}

export async function onRequestPost(context) {
  const r = await postItemOp(context, ITEM_KINDS);
  if (r.response) return r.response;
  const out = { ok: true, canManage: true, showPrivate: true, ...(await listItems(context.env.D1_DEVICES, true)) };
  if (r.id) out.id = r.id;
  return json(out);
}

export function onRequest() {
  return methodNotAllowed('GET, POST');
}
