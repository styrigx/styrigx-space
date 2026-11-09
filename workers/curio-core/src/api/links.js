// workers/core/src/api/links.js
// GET  /api/links   进门即可：账号已登录拿全部（含私密），没登录只拿公开的（私密分类 / 私密收藏 / 空分类都不给）。
//                   返回 {ok:true, canWrite, showPrivate, cats:[{id, name:{zh,en}, private, links:[{id, url, name, desc, icon, private}]}]}
// POST /api/links   账号会话 + 作用域 curio.write + 同源：body {op, ...}（操作见 _store.js 的 parseOp）。
//                   成功 → {ok:true, canWrite:true, showPrivate:true, cats:[...]}（直接带回最新的全部收藏，前端整页重画）
//                   400 参数不对；401 account；403 origin / scope；404 不存在；409 not-empty / mismatch / limit / duplicate
import { json, err, methodNotAllowed } from './_lib.js';
import { conclusionOf, canReadPrivate, visibility } from './_auth.js';
import { readBody, guardWrite } from './_write.js';
import { ensureSchema, listAll, parseOp, applyOp } from './_store.js';

const STATUS = { 'not-found': 404, 'not-empty': 409, mismatch: 409, limit: 409, duplicate: 409 };

function db(env) {
  return env && env.D1_FINDS ? env.D1_FINDS : null;
}

export async function onRequestGet(context) {
  const { env } = context;
  const c = await conclusionOf(context);
  if (!c.space.ok) return err('unauthorized', 401);
  const d = db(env);
  if (!d) return err('server', 503);
  await ensureSchema(d);
  return json({ ok: true, ...visibility(c), cats: await listAll(d, canReadPrivate(c)) });
}

export async function onRequestPost(context) {
  const denied = await guardWrite(context);
  if (denied) return denied;
  const d = db(context.env);
  if (!d) return err('server', 503);
  const { body, response } = await readBody(context.request);
  if (response) return response;
  const o = parseOp(body);
  if ('error' in o) return err(o.error, 400);
  await ensureSchema(d);
  const e = await applyOp(d, o);
  if (e) return err(e, STATUS[e] || 400);
  return json({ ok: true, canWrite: true, showPrivate: true, cats: await listAll(d, true) });
}

export function onRequest() {
  return methodNotAllowed('GET, POST');
}
