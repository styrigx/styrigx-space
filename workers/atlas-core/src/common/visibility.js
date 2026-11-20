/**
 * @fileoverview atlas-core 公用：私密行与管理权限的统一做法（组权限重设计 v1.1 §八，Gray 2026-11-20 23:59 认可）。
 *
 * 组仍是唯一的权限单位，判断仍只在账号 Worker 的 permits()；本文件不比组，只问两档、过滤、回 404：
 * - visibility(context) → { showPrivate, canManage }：分别按 action 'private'（= `<产品>-use`）、'manage'（= `<产品>-manage`）
 *   问 v6（账号 Worker 路由表按行上的 product 推组名）。产品取 context.data.route（app.js / index.js 命中的本 Worker 路由行）的 product，
 *   不另传；没有命中行 / 行上没有 product / 没有问 v6 的函数（context.data.ask）→ 两样都 false（fail closed）。
 *   奇趣、日刻、音乐的公开读接口都只调它（取代原来 curio / daymark 两份 _auth.js 里重复的 readAccess：
 *   原来只问一次 private，结果同时当 showPrivate 和 canWrite；私密档改成 -use 之后两样必须分开问）。
 * - canSeePrivate(context)：只问 'private' 一档（附件：照片、图标，每张图一个请求，不多问一次 manage）。
 * - filterPrivate(rows, showPrivate[, isPrivate])：列表的私密行过滤（约定列 private 0/1；没有这一列 = 整表公开）。
 * - privateNotFound(context, isPrivate)：附件「看不到就 404」，同不存在（不让人探出私密条目在不在）。
 *
 * 响应字段叫 canManage（v1.1 §八「不再用 write 这个词」，旧名 canWrite 不留别名）。
 *
 * 叶子模块：不 import 任何东西（问 v6 的函数由各产品的 app 放进 context.data.ask，同一个请求每个 action 最多问一次）。
 */

const NO_STORE = 'private, no-store';

/** 看不到、也管不了 */
export const NO_VISIBILITY = Object.freeze({ showPrivate: false, canManage: false });

/** @param {any} context @returns {{product: string, ask: Function}|null} */
function asker(context) {
  const d = context && context.data;
  const route = d && d.route;
  const product = route && typeof route.product === 'string' ? route.product : '';
  if (!product || typeof d.ask !== 'function') return null;
  return { product, ask: d.ask };
}

/** @param {any} v */
function allowed(v) {
  return !!(v && v.allowed === true);
}

/**
 * 公开读接口的两个布尔：showPrivate（私密行，action 'private' = `<产品>-use`）、canManage（管理入口提示，action 'manage' = `<产品>-manage`）。
 * 两档分开问（manage 包含 use 在 permits 里，不在这里推）。永不抛错。
 * @param {any} context
 * @returns {Promise<{showPrivate: boolean, canManage: boolean}>}
 */
export async function visibility(context) {
  const a = asker(context);
  if (!a) return NO_VISIBILITY;
  try {
    const [p, m] = await Promise.all([a.ask(context, 'private'), a.ask(context, 'manage')]);
    return { showPrivate: allowed(p), canManage: allowed(m) };
  } catch (e) {
    return NO_VISIBILITY;
  }
}

/**
 * 只问私密那一档（附件用：照片、图标）。永不抛错。
 * @param {any} context @returns {Promise<boolean>}
 */
export async function canSeePrivate(context) {
  const a = asker(context);
  if (!a) return false;
  try {
    return allowed(await a.ask(context, 'private'));
  } catch (e) {
    return false;
  }
}

/** 约定列 private（0/1 / 布尔）：是不是私密行 @param {any} r */
export function isPrivateRow(r) {
  return !!(r && r.private);
}

/**
 * 列表的私密行过滤（全 Atlas 同一个函数）：showPrivate → 原样；否则去掉私密行。
 * isPrivate 给没按约定列存的表用（日刻句子的 visibility 'private'）。
 * @template T @param {ReadonlyArray<T>} rows @param {boolean} showPrivate @param {(r: T) => boolean} [isPrivate]
 * @returns {T[]}
 */
export function filterPrivate(rows, showPrivate, isPrivate) {
  const list = Array.isArray(rows) ? rows : [];
  if (showPrivate) return list.slice();
  const f = typeof isPrivate === 'function' ? isPrivate : isPrivateRow;
  return list.filter((r) => !f(r));
}

/** 404 not-found（同各产品 _lib.js err('not-found', 404) 的形状） */
function notFound() {
  return new Response(JSON.stringify({ ok: false, error: 'not-found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': NO_STORE },
  });
}

/**
 * 附件「看不到就 404」：这一条是私密的、而这个请求看不到私密 → 404 响应；否则 null（接着往下走）。
 * 只在私密时才问 v6（公开条目不多问一次）。
 * @param {any} context @param {boolean} isPrivate
 * @returns {Promise<Response|null>}
 */
export async function privateNotFound(context, isPrivate) {
  if (!isPrivate) return null;
  return (await canSeePrivate(context)) ? null : notFound();
}
