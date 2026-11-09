// workers/curio-core/src/api/access.js
// GET /api/access   进门即可：{ok, canWrite, showPrivate, music}——奇趣首页用它决定显不显示私人入口（音乐）。
//   music = 能进私人音乐（账号会话 + curio.write，同 _music.js requireMusic）；canWrite / showPrivate 同其它读接口（_auth.js visibility）。
// 只回布尔，不读 D1。
import { json, err, methodNotAllowed } from './_lib.js';
import { conclusionOf, visibility } from './_auth.js';

export async function onRequestGet(context) {
  const c = await conclusionOf(context);
  if (!c.space.ok) return err('unauthorized', 401);
  const v = visibility(c);
  return json({ ok: true, ...v, music: v.canWrite });
}

export function onRequest() {
  return methodNotAllowed('GET');
}
