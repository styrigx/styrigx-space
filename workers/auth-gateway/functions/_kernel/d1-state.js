/**
 * 网关的 D1 认证状态入口：只认网关的三个域，实现在共享模块 workers/auth-gateway/functions/_kernel/lib/d1-state.js。
 *
 * 账号拆分 PR1（零行为变化）：表结构（SCHEMA）、纪元、通行密钥、密码、user handle 的读写搬到 workers/auth-gateway/functions/_kernel/lib/d1-state.js，
 * 那边只按形状认域描述对象；本文件保留原来的 realmOf（REALM_LOCK / REALM_ACCOUNT / REALM_ROOT，或它们的 id，
 * 别的一律抛 'd1-state: bad realm'），先把域解析成网关的域对象再交给共享实现。导出的名字、参数、同步 / 异步与以前完全相同。
 *
 * 读主库、出错一律抛、表不存在建表后重试一次等约定见 workers/auth-gateway/functions/_kernel/lib/d1-state.js 文件头。
 */
import { REALM_LOCK, REALM_ACCOUNT, REALM_ROOT } from './realms.js';
import * as base from './lib/d1-state.js';

export { SCHEMA, withSchema, sweepExpired, parseRecord } from './lib/d1-state.js';

/** @param {any} realm REALM_LOCK | REALM_ACCOUNT | REALM_ROOT，或它们的 id */
export function realmOf(realm) {
  if (realm === REALM_LOCK || realm === REALM_LOCK.id) return REALM_LOCK;
  if (realm === REALM_ACCOUNT || realm === REALM_ACCOUNT.id) return REALM_ACCOUNT;
  if (realm === REALM_ROOT || realm === REALM_ROOT.id) return REALM_ROOT;
  throw new Error('d1-state: bad realm ' + JSON.stringify(realm && realm.id ? realm.id : realm));
}

/** 某域的 D1 绑定（主库）。没绑 → 抛错。@param {any} env @param {any} realm */
export function authDb(env, realm) {
  return base.authDb(env, realmOf(realm));
}

/** 某域 D1 上跑一次操作（authDb + withSchema）。@template T @param {any} env @param {any} realm @param {(db:any, r:any) => Promise<T>} fn @returns {Promise<T>} */
export function onAuthDb(env, realm, fn) {
  return base.onAuthDb(env, realmOf(realm), fn);
}

/** @param {any} env @param {any} realm @returns {Promise<number>} */
export async function readEpoch(env, realm) {
  return base.readEpoch(env, realmOf(realm));
}

/** @param {any} env @param {any} realm @returns {Promise<number>} 新纪元 */
export async function bumpEpoch(env, realm) {
  return base.bumpEpoch(env, realmOf(realm));
}

/** @param {any} env @param {any} realm @returns {Promise<any[]>} */
export async function listPasskeyRecords(env, realm) {
  return base.listPasskeyRecords(env, realmOf(realm));
}

/** @param {any} env @param {any} realm @returns {Promise<boolean>} */
export async function hasPasskeyRecord(env, realm) {
  return base.hasPasskeyRecord(env, realmOf(realm));
}

/** @param {any} env @param {any} realm @param {string} credId */
export async function getPasskeyRecord(env, realm, credId) {
  return base.getPasskeyRecord(env, realmOf(realm), credId);
}

/** @param {any} env @param {any} realm @param {any} rec 必须带 credId */
export async function putPasskeyRecord(env, realm, rec) {
  return base.putPasskeyRecord(env, realmOf(realm), rec);
}

/** @param {any} env @param {any} realm @param {any} rec @returns {Promise<boolean>} */
export async function updatePasskeyRecord(env, realm, rec) {
  return base.updatePasskeyRecord(env, realmOf(realm), rec);
}

/** @param {any} env @param {any} realm @param {string} credId */
export async function deletePasskeyRecord(env, realm, credId) {
  return base.deletePasskeyRecord(env, realmOf(realm), credId);
}

/** @param {any} env @param {any} realm */
export async function getPasswordRecord(env, realm) {
  return base.getPasswordRecord(env, realmOf(realm));
}

/** @param {any} env @param {any} realm @param {any} rec */
export async function putPasswordRecord(env, realm, rec) {
  return base.putPasswordRecord(env, realmOf(realm), rec);
}

/** @param {any} env @param {any} realm */
export async function deletePasswordRecord(env, realm) {
  return base.deletePasswordRecord(env, realmOf(realm));
}

/** @param {any} env @param {any} realm @param {boolean} create @param {() => string} gen @returns {Promise<string>} */
export async function userHandleRecord(env, realm, create, gen) {
  return base.userHandleRecord(env, realmOf(realm), create, gen);
}
