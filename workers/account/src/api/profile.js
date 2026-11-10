/**
 * GET / PUT /api/profile —— 个人资料（2026-11-07 Gray 定）：姓名、昵称、签名、对外联系邮箱 + 头像版本号。
 *
 * GET（有进站会话即可，不要账号会话）
 * - 回 { ok:true, profile:{ name, nickname, motto, email }, avatar:<版本号|''>, updatedAt }。
 *   只回这五项里可公开的；没改过的字段是 null，前端回退构建期默认值（space/web/data/profile.yaml）。
 *   KV 没绑 / 读不到 / 坏 JSON → 全是 null（照样 200），页面显示默认值。
 * - 门在网关（转发表 gate='session'：没有进站会话 401）；本 Worker 的 lockIdentityDenial 同样要进站会话。锁屏前不开放
 *   （锁屏头像的替代文字用构建期默认值 + 本机上次进站时缓存的资料，前端 lib/profile.js）。
 *
 * PUT（JSON，任意几个字段：{ name?, nickname?, motto?, email? }）
 * - 进站会话 + 账号会话 + 作用域 profile.write（src/gate.js scopeDenial，同一份 core/authorize.js）；必须同源。
 *   没有进站会话 401 session；没账号会话 401 account；没作用域 403 scope。
 * - 每个字段按 lib/profile.js 的字段表校验：字符串去首尾空白；姓名 ≤40、昵称 ≤32、签名不限长度（只受请求体 4 KB 上限）、邮箱 ≤254 个字符；
 *   单行（不收控制字符 / 换行）；姓名、昵称、邮箱不能为空串，签名可以为空；邮箱要像邮箱；值为 null = 清掉回默认值。
 *   不认识的字段、空对象、不是 JSON 对象 → 400；请求体超过 4 KB → 413。任何一个字段不合法整个请求不写。
 * - 与已存的合并后写回一个键 `profile`；回 { ok:true, profile, avatar, updatedAt }（同 GET）。
 *
 * v6（P2，定稿 v4 §五）：PUT 的档是 owner——站长（styrigx）+ root（root 由 permits 放行），其余 uid 一律拒（v6 新会话按
 * core/route-access.js 判；旧会话照旧要账号会话 + profile.write）。root 改名片写身份审计（profile，root 的特权内容操作都留痕）。
 * GET：有进站会话，或有一个有效的 v6 新会话，即可读。
 */
import { isSameOrigin, originDenied, json, apiError, clientIp } from '../lib/http.js';
import { KEY_VER, NO_STORE } from '../lib/avatar.js';
import { PROFILE_FIELD_IDS, PROFILE_BODY_MAX, checkField, publicView, profileKv, readStored, writeStored } from '../lib/profile.js';
import { scopeDenial } from '../gate.js';
import { ROOT_UID } from '../core/groups.js';
import { writeUserAudit } from '../core/user-audit.js';

/** 本接口的作用域（core/scopes.js） */
const SCOPE = 'profile.write';

/** @param {any} kv */
async function avatarVer(kv) {
  if (!kv) return '';
  try {
    return (await kv.get(KEY_VER)) || '';
  } catch (e) {
    return '';
  }
}

/** @param {any} kv @param {Record<string,string>} stored @param {number} updatedAt */
async function view(kv, stored, updatedAt) {
  return { ok: true, profile: publicView(stored), avatar: await avatarVer(kv), updatedAt };
}

/** @param {any} context */
export async function onRequestGet(context) {
  const { env } = context;
  const lock = await context.auth.gateway();
  if (!lock.ok) {
    const v = context.auth.hasV6 ? await context.auth.v6() : null;
    if (!(v && v.allowed === true && Number.isInteger(v.uid))) return apiError(401, 'session', undefined, NO_STORE);
  }
  const kv = profileKv(env);
  const { stored, updatedAt } = await readStored(kv);
  return json(200, await view(kv, stored, updatedAt), NO_STORE);
}

/** @param {any} context */
export async function onRequestPut(context) {
  const { request, env } = context;
  if (!isSameOrigin(request)) return originDenied();
  const denied = await scopeDenial(context.auth, SCOPE, NO_STORE);
  if (denied) return denied;
  const kv = profileKv(env);
  if (!kv) return apiError(500, 'server', undefined, NO_STORE);
  let text = '';
  try {
    text = await request.text();
  } catch (e) {
    return apiError(400, 'body', undefined, NO_STORE);
  }
  if (new TextEncoder().encode(text).byteLength > PROFILE_BODY_MAX) return apiError(413, 'too-large', undefined, NO_STORE);
  /** @type {any} */
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return apiError(400, 'body', undefined, NO_STORE);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(400, 'body', undefined, NO_STORE);
  const keys = Object.keys(body);
  if (!keys.length) return apiError(400, 'params', { reason: 'empty' }, NO_STORE);
  /** @type {Record<string, string|null>} */
  const changes = {};
  for (const k of keys) {
    if (PROFILE_FIELD_IDS.indexOf(k) === -1) return apiError(400, 'params', { field: k, reason: 'field' }, NO_STORE);
    const c = checkField(k, body[k]);
    if (!c.ok) return apiError(400, 'params', { field: k, reason: c.error }, NO_STORE);
    changes[k] = c.value;
  }
  try {
    const { stored } = await readStored(kv);
    for (const k of Object.keys(changes)) {
      const v = changes[k];
      if (v === null) delete stored[k];
      else stored[k] = v;
    }
    const now = Date.now();
    await writeStored(kv, stored, now);
    const v = context.auth.hasV6 ? await context.auth.v6() : null;
    if (v && v.allowed === true && v.uid === ROOT_UID) {
      await writeUserAudit(env, { uid: ROOT_UID, command: 'profile set ' + Object.keys(changes).join(','), ok: true, ip: clientIp(request) });
    }
    return json(200, await view(kv, stored, Object.keys(stored).length ? now : 0), NO_STORE);
  } catch (e) {
    return apiError(500, 'server', undefined, NO_STORE);
  }
}
