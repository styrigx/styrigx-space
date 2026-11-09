/**
 * @fileoverview 个人资料（2026-11-07 Gray 定）：姓名、昵称、签名、对外联系邮箱的定义、校验和 KV 读写。
 * GET / PUT /api/profile（src/api/profile.js）共用。头像不在这里（图片在 avatar:*，见 lib/avatar.js），GET 只顺带回头像版本号。
 *
 * - 存储：KV_PROFILE（styrigx-account KV，和头像同库）一个键 `profile`，值是 JSON
 *   `{"v":1,"name","nickname","motto","email","updatedAt"}`；只存改过的字段，没存的字段 = 用默认值。
 * - 默认值不在 Worker 里：在主站 space/web/data/profile.yaml（构建期画首帧）。接口对没存的字段回 null，
 *   前端回退构建期默认值；KV 读不到 / JSON 坏了也一律当「全没存」（不报错，页面照样显示默认值）。
 * - 字段表 PROFILE_FIELDS 是唯一一份定义（以后加字段在这里加一行 + 前端 lib/profile.js 同名一行，单测核对两边一致）。
 *
 * 叶子模块：不 import 任何东西。
 */

/** KV 键 */
export const PROFILE_KEY = 'profile';
/** 存储格式版本 */
export const PROFILE_V = 1;
/** PUT 请求体上限（字节） */
export const PROFILE_BODY_MAX = 4096;

/** 邮箱：local@domain.tld，不含空白和尖括号；只做格式检查，不验证能不能收信 */
export const EMAIL_RE = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\.]{2,}$/;
/** 控制字符（含换行、制表符）和 Unicode 行 / 段分隔符：单行字段一律不收 */
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * 字段表（顺序 = 资料页行顺序里除头像外的顺序）。
 * - id：字段名（接口 / KV / 前端同名）
 * - max：最大长度（按 Unicode 码点数）；null = 不限长度（签名，Gray 2026-11-09 18:11「自己的网站肯定要随性一点」；仍受 PUT 请求体 4 KB 上限）
 * - required：true = 不能为空串（清空请传 null，回到默认值）
 * - kind：'text' 单行文字；'email' 邮箱格式
 * @type {ReadonlyArray<Readonly<{id:string, max:number|null, required:boolean, kind:'text'|'email'}>>}
 */
export const PROFILE_FIELDS = Object.freeze([
  Object.freeze({ id: 'name', max: 40, required: true, kind: 'text' }),
  Object.freeze({ id: 'nickname', max: 32, required: true, kind: 'text' }),
  Object.freeze({ id: 'motto', max: null, required: false, kind: 'text' }),
  Object.freeze({ id: 'email', max: 254, required: true, kind: 'email' }),
]);

/** 字段名列表 */
export const PROFILE_FIELD_IDS = Object.freeze(PROFILE_FIELDS.map((f) => f.id));

/** @param {string} s 码点数 */
function len(s) {
  return Array.from(s).length;
}

/**
 * 校验一个字段的新值。null = 清掉（回默认值）。字符串先去首尾空白；邮箱再转小写域名部分不动（原样存）。
 * @param {string} id
 * @param {any} value
 * @returns {{ok:true, value:string|null}|{ok:false, error:string}}
 *   error：'field'（不认识的字段）、'type'（不是字符串 / null）、'empty'、'too-long'、'format'（含控制字符 / 邮箱格式不对）
 */
export function checkField(id, value) {
  const f = PROFILE_FIELDS.find((x) => x.id === id);
  if (!f) return { ok: false, error: 'field' };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: 'type' };
  const v = value.trim();
  if (CTRL_RE.test(v)) return { ok: false, error: 'format' };
  if (!v) return f.required ? { ok: false, error: 'empty' } : { ok: true, value: '' };
  if (f.max !== null && len(v) > f.max) return { ok: false, error: 'too-long' };
  if (f.kind === 'email' && !EMAIL_RE.test(v)) return { ok: false, error: 'format' };
  return { ok: true, value: v };
}

/**
 * 把 KV 里存的对象收成「只含认识的、合法的字段」：不合法的字段丢掉（当没存，回默认值）。
 * @param {any} raw
 * @returns {Record<string, string>}
 */
export function cleanStored(raw) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const id of PROFILE_FIELD_IDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, id)) continue;
    const c = checkField(id, raw[id]);
    if (c.ok && c.value !== null) out[id] = c.value;
  }
  return out;
}

/**
 * 接口回给前端的形状：每个字段都有，没存的是 null（前端回退默认值）。
 * @param {Record<string, string>} stored cleanStored 的结果
 * @returns {Record<string, string|null>}
 */
export function publicView(stored) {
  /** @type {Record<string, string|null>} */
  const out = {};
  for (const id of PROFILE_FIELD_IDS) out[id] = Object.prototype.hasOwnProperty.call(stored, id) ? stored[id] : null;
  return out;
}

/**
 * 个人资料存在 KV_PROFILE（和头像同一个命名空间）。没绑 → null。
 * @param {any} env
 */
export function profileKv(env) {
  return (env && env.KV_PROFILE) || null;
}

/**
 * 读存储（读不到 / 坏 JSON → {}，不抛）。
 * @param {any} kv
 * @param {{cacheTtl?: number}} [opts]
 * @returns {Promise<{stored: Record<string,string>, updatedAt: number}>}
 */
export async function readStored(kv, opts) {
  if (!kv) return { stored: {}, updatedAt: 0 };
  try {
    const txt = await kv.get(PROFILE_KEY, opts && opts.cacheTtl ? { cacheTtl: opts.cacheTtl } : undefined);
    if (!txt) return { stored: {}, updatedAt: 0 };
    const raw = JSON.parse(typeof txt === 'string' ? txt : String(txt));
    return { stored: cleanStored(raw), updatedAt: raw && Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : 0 };
  } catch (e) {
    return { stored: {}, updatedAt: 0 };
  }
}

/**
 * 写存储：只写有值的字段；全都清掉 → 删除这个键。
 * @param {any} kv
 * @param {Record<string,string>} stored
 * @param {number} now
 */
export async function writeStored(kv, stored, now) {
  const keys = PROFILE_FIELD_IDS.filter((id) => Object.prototype.hasOwnProperty.call(stored, id));
  if (!keys.length) {
    await kv.delete(PROFILE_KEY);
    return;
  }
  /** @type {Record<string, any>} */
  const rec = { v: PROFILE_V };
  for (const id of keys) rec[id] = stored[id];
  rec.updatedAt = now;
  await kv.put(PROFILE_KEY, JSON.stringify(rec));
}
