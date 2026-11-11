/**
 * @fileoverview 个人资料（2026-11-07 Gray 定）：姓名、昵称、签名、对外联系邮箱的前端唯一来源。
 *
 * 来源三层，后者盖前者：
 * 1. 构建期默认值：space/web/data/profile.yaml → baseof 输出的 <script id="sgx-profile-default" type="application/json">，
 *    模板也直接把默认值画进首帧（名字卡、页脚、锁屏头像替代文字等）。
 * 2. 本机缓存：localStorage sgx-profile（{v:1, p:{改过的字段}, t}），上次进门时从接口拿到的。
 *    锁屏（进门前不问接口）和子站 AI 窗口「联系我」读它。四站同源，同一份。云同步白名单不收这个键（lib/cloud-sync.js syncKeys）。
 * 3. 运行时接口：GET /api/profile（进门即可，没账号会话也行）——只在锁屏已解锁的页面（<html data-sgx-lock-session="valid">）请求，
 *    回来的非 null 字段覆盖默认值并写回缓存。
 *
 * 页面上要跟着资料变的元素标 data-sgx-profile="<字段>"（name / nickname / motto / email），默认改文字；
 * data-sgx-profile-attr="alt" 改属性；"href" 写成 mailto:<邮箱>。这些元素同时是个人信息类（translate="no" data-sgx-personal，partials/sgx-personal.html）。
 * 品牌 Styrigx（字标、站名、og:site_name 等）不是昵称，不标、不读这里。
 *
 * 字段表 PROFILE_FIELDS 与账号 Worker workers/account/src/lib/profile.js 同名同序同长度（tests/workers/account/profile.test.mjs 核对）；
 * 以后加字段：两边各加一行 + profile.yaml 默认值 + 资料页一行（layouts/_default/account-profile.html 的行表）。
 */
import { get as sget, set as sset } from './storage.js';

/** 本机缓存键（不在云同步白名单里） */
export const PROFILE_CACHE_KEY = 'sgx-profile';
/** 接口 */
export const PROFILE_API = '/api/profile';
/** 资料变了（保存成功 / 接口拿到新值）：window 上派发，detail = 生效的资料 */
export const PROFILE_EVENT = 'sgx-profile-changed';

/**
 * 字段表（id / 最大长度（按字符）/ 必填 / 种类）。
 * @type {ReadonlyArray<Readonly<{id:string, max:number|null, required:boolean, kind:'text'|'email'}>>}
 */
export const PROFILE_FIELDS = Object.freeze([
  Object.freeze({ id: 'name', max: 40, required: true, kind: 'text' }),
  Object.freeze({ id: 'nickname', max: 32, required: true, kind: 'text' }),
  Object.freeze({ id: 'motto', max: null, required: false, kind: 'text' }),
  Object.freeze({ id: 'email', max: 254, required: true, kind: 'email' }),
]);

/** 邮箱格式（与 Worker 同一条） */
export const EMAIL_RE = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\.]{2,}$/;
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** @typedef {{name:string, nickname:string, motto:string, email:string}} Profile */

/**
 * 前端校验（服务端还会再校验一次）：返回错误种类或 ''。
 * @param {string} id @param {string} raw
 * @returns {''|'empty'|'too-long'|'format'}
 */
export function checkValue(id, raw) {
  const f = PROFILE_FIELDS.find(function (x) { return x.id === id; });
  if (!f) return 'format';
  const v = String(raw == null ? '' : raw).trim();
  if (CTRL_RE.test(v)) return 'format';
  if (!v) return f.required ? 'empty' : '';
  if (f.max !== null && Array.from(v).length > f.max) return 'too-long';
  if (f.kind === 'email' && !EMAIL_RE.test(v)) return 'format';
  return '';
}

/** @type {Profile|null} */
let defaultsMemo = null;

/** 构建期默认值（#sgx-profile-default）；读不到时四项空串 @returns {Profile} */
export function profileDefaults() {
  if (defaultsMemo) return defaultsMemo;
  /** @type {any} */
  let d = {};
  try {
    const el = typeof document !== 'undefined' ? document.getElementById('sgx-profile-default') : null;
    d = JSON.parse((el && el.textContent) || '{}') || {};
  } catch (e) {
    d = {};
  }
  defaultsMemo = { name: str(d.name), nickname: str(d.nickname), motto: str(d.motto), email: str(d.email) };
  return defaultsMemo;
}

/** @param {any} v */
function str(v) {
  return typeof v === 'string' ? v : '';
}

/**
 * 只留认识的、合法的字段（缓存 / 接口给的东西都先过一遍；不合法的当没有）。
 * 空串（含只有空白）一律当没设置、回退默认值（2026-11-08 修：以前非必填的签名存成 '' 会盖掉默认值；前端清空本来就发 null）。
 * @param {any} raw
 * @returns {Partial<Profile>}
 */
export function cleanProfile(raw) {
  /** @type {Record<string,string>} */
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const f of PROFILE_FIELDS) {
    const v = raw[f.id];
    if (typeof v !== 'string' || !v.trim()) continue;
    if (checkValue(f.id, v)) continue;
    out[f.id] = v.trim();
  }
  return out;
}

/**
 * 默认值 ← 改过的字段。
 * @param {Partial<Profile>} over
 * @param {Profile} [defs]
 * @returns {Profile}
 */
export function effectiveProfile(over, defs) {
  const d = defs || profileDefaults();
  const o = cleanProfile(over);
  return {
    name: o.name !== undefined ? o.name : d.name,
    nickname: o.nickname !== undefined ? o.nickname : d.nickname,
    motto: o.motto !== undefined ? o.motto : d.motto,
    email: o.email !== undefined ? o.email : d.email,
  };
}

/** 本机缓存里改过的字段（没有 / 坏了 = {}） @returns {Partial<Profile>} */
export function readCache() {
  try {
    const j = JSON.parse(sget(PROFILE_CACHE_KEY) || 'null');
    return j && j.v === 1 ? cleanProfile(j.p) : {};
  } catch (e) {
    return {};
  }
}

/**
 * 写本机缓存：只存接口说改过（非 null）的字段；一个都没有就删键。
 * @param {Record<string, string|null>|null|undefined} apiProfile 接口 profile（字段为 null = 用默认值）
 */
export function writeCache(apiProfile) {
  const p = cleanProfile(apiProfile || {});
  if (!Object.keys(p).length) {
    sset(PROFILE_CACHE_KEY, null);
    return;
  }
  sset(PROFILE_CACHE_KEY, JSON.stringify({ v: 1, p: p, t: Date.now() }));
}

/**
 * 把生效的资料画到页面上所有 [data-sgx-profile] 元素。
 * @param {Profile} p
 * @param {ParentNode} [root]
 */
export function applyProfile(p, root) {
  const r = root || document;
  r.querySelectorAll('[data-sgx-profile]').forEach(function (el) {
    const id = el.getAttribute('data-sgx-profile') || '';
    if (!Object.prototype.hasOwnProperty.call(p, id)) return;
    const v = /** @type {any} */ (p)[id];
    const attr = el.getAttribute('data-sgx-profile-attr');
    if (attr === 'href') {
      if (v) el.setAttribute('href', 'mailto:' + v);
    } else if (attr) {
      el.setAttribute(attr, v);
    } else if (el.textContent !== v) {
      el.textContent = v;
    }
  });
}

/** 锁屏已解锁（网关首帧注入）：只有这时才问接口 */
function doorOpen() {
  return document.documentElement.getAttribute('data-sgx-lock-session') === 'valid';
}

/** @param {Profile} p */
function announce(p) {
  try {
    window.dispatchEvent(new CustomEvent(PROFILE_EVENT, { detail: p }));
  } catch (e) {}
}

/** 本页正在进行 / 已完成的那次 GET（core 和资料页同时要时只发一次） @type {Promise<any>|null} */
let pending = null;

/**
 * GET /api/profile：拿到就写缓存、画页面、派发事件。失败返回 null（页面保持默认值 / 缓存）。同一页只请求一次。
 * @returns {Promise<{profile: Profile, raw: Record<string, string|null>, avatar: string}|null>}
 */
export function fetchProfile() {
  if (pending) return pending;
  pending = fetch(PROFILE_API, { method: 'GET', credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!j || !j.ok || !j.profile || typeof j.profile !== 'object') return null;
      writeCache(j.profile);
      const p = effectiveProfile(cleanProfile(j.profile));
      applyProfile(p);
      announce(p);
      return { profile: p, raw: j.profile, avatar: typeof j.avatar === 'string' ? j.avatar : '' };
    }, function () { return null; });
  return pending;
}

/**
 * PUT /api/profile（只传改的字段；null = 回默认值）。
 * 成功：写缓存、画页面、派发事件，回 { ok:true, profile, raw }；失败回 { ok:false, error, reason?, field? }（error = 接口错误码，网络错 'network'）。
 * @param {Record<string, string|null>} changes
 */
export function saveProfile(changes) {
  return fetch(PROFILE_API, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  })
    .then(function (r) {
      return r.json().catch(function () { return { ok: false, error: String(r.status) }; });
    })
    .then(function (j) {
      if (!j || !j.ok || !j.profile) return { ok: false, error: (j && j.error) || 'server', reason: j && j.reason, field: j && j.field };
      writeCache(j.profile);
      const p = effectiveProfile(cleanProfile(j.profile));
      applyProfile(p);
      announce(p);
      return { ok: true, profile: p, raw: j.profile };
    }, function () { return { ok: false, error: 'network' }; });
}

let inited = false;

/**
 * 全站：页面上有 [data-sgx-profile] 才动——先用本机缓存画，再（已进门时）问接口。没有这类元素的页面什么都不做、不发请求。
 * shell/core.js initCore 调。
 */
export function initProfile() {
  if (inited || typeof document === 'undefined') return;
  inited = true;
  if (!document.querySelector('[data-sgx-profile]')) return;
  window.addEventListener('sgx:session', function (/** @type {any} */ e) {
    const d = e && e.detail;
    if (d && d.live && d.ok) refreshProfile();
  });
  const cached = readCache();
  if (Object.keys(cached).length) applyProfile(effectiveProfile(cached));
  if (doorOpen()) fetchProfile();
}

/**
 * 2c：页面标记就地切成 valid（v6 su 之后顶栏发 window 'sgx:session' { ok: true, live: true }）→ 重新问一次 /api/profile（本页之前没进门、没问过，
 * 或问的是上一个身份的）。页面上没有 [data-sgx-profile] 不动。initProfile 里挂上。
 * @returns {Promise<any>|null}
 */
export function refreshProfile() {
  if (typeof document === 'undefined' || !document.querySelector('[data-sgx-profile]') || !doorOpen()) return null;
  pending = null;
  return fetchProfile();
}

/** 只供测试：清掉记忆的默认值 / 初始化标记 */
export function _resetForTest() {
  defaultsMemo = null;
  inited = false;
  pending = null;
}
