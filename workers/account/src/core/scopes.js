/**
 * 作用域表（方案 2.4、4.2；P2-1 授权骨架）：账号授权的唯一一份作用域定义，只在账号 Worker 里有。
 *
 * 粒度：按应用（= 数据域）各一个写作用域；读私密跟账号会话走（不要作用域）；敏感操作在作用域之外另要账号复验
 * （sgx-account-reauth），不再多拆作用域。应用 id 就是以后的授权卡 id（第 3 件，另批）。
 *
 * 作用域 id 规则：<应用>.<动作>，全小写，只用 [a-z.]（SCOPE_ID_RE）。以后加应用只在 SCOPES 里加一行。
 * 网关和下游 Worker 只认字符串，不 import 本文件（space/scripts/check-layers.mjs 规则 14）。
 *
 * 每一项：
 * - id：作用域 id
 * - app：所属应用 id（授权卡 id）
 * - name：应用名（授权卡标题）的英文原文（语言包化第二部分 2026-11-07：英文是源，接口只回英文；
 *   界面按字符串表 js.account.app_<应用 id> 显示当前语言，表里没有的应用回退这里的英文名）
 * - sensitive：在本作用域之外另要账号复验的敏感操作（空 = 没有）；只作说明和以后授权卡页展示，
 *   判断在下游（方案 4.6 requireScope(context, scope, { reauth: true })）
 *
 * 叶子模块：不 import 任何东西。
 */

/** 作用域 id 格式：<应用>.<动作>，全小写，只用 [a-z.] */
export const SCOPE_ID_RE = /^[a-z]+\.[a-z]+$/;

/** 作用域表（方案 4.2，5 项；顺序即授权卡顺序） */
export const SCOPES = Object.freeze([
  Object.freeze({ id: 'curio.write', app: 'curio', name: 'Curio', sensitive: Object.freeze(['POST /curio/api/import']) }),
  Object.freeze({ id: 'daymark.write', app: 'daymark', name: 'Daymark', sensitive: Object.freeze([]) }),
  Object.freeze({ id: 'prefs.sync', app: 'prefs', name: 'Settings sync', sensitive: Object.freeze([]) }),
  Object.freeze({ id: 'wellbeing.write', app: 'wellbeing', name: 'Digital wellbeing', sensitive: Object.freeze([]) }),
  Object.freeze({ id: 'avatar.write', app: 'avatar', name: 'Avatar', sensitive: Object.freeze([]) }),
]);

/** 全部已知作用域 id，按字母排序（结论里的 scopes 一律按字母排序） */
export const SCOPE_IDS = Object.freeze(SCOPES.map((s) => s.id).sort());

/** 是不是已知作用域 @param {any} id */
export function isScopeId(id) {
  return typeof id === 'string' && SCOPE_IDS.indexOf(id) !== -1;
}

/**
 * 只留已知作用域，去重、按字母排序（授权 ∩ 作用域表）。非数组 → []。
 * @param {any} list
 * @returns {string[]}
 */
export function knownScopes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) if (isScopeId(s) && out.indexOf(s) === -1) out.push(s);
  return out.sort();
}
