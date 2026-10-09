/**
 * @fileoverview 2.4.0-G：功能开关统一配置（运行时）。
 * - 定义来自页面内 #sgx-features JSON（Hugo 由 data/features.yaml 生成），默认值与 yaml 一致。
 * - key 沿用现有 localStorage key，老用户设置不丢；key 不存在即默认值。
 * - set(id, v) 写值（等于默认值时删 key）；on(id, fn) 订阅变更。
 * - storage 事件做跨标签页同步；同时派发 sgx-settings-changed 做旧代码兼容。
 * - 用户数据类 key 不走这里，只走 storage.js。
 */
import { get as sget, set as sset } from './storage.js';

/**
 * @typedef {{id:string,key:string|null,type:string,default:any,storage?:{on:string|null,off:string|null}}} FeatureDef
 */

/** @type {Map<string, FeatureDef>} */
const byId = new Map();
/** @type {Map<string, FeatureDef>} */
const byKey = new Map();
/** @type {Map<string, Set<(v:any)=>void>>} */
const listeners = new Map();

(function loadDefs() {
  let list = [];
  try {
    const el = document.getElementById('sgx-features');
    if (el) list = JSON.parse(el.textContent || '[]');
  } catch (e) {}
  for (const d of list) {
    byId.set(d.id, d);
    if (d.key) byKey.set(d.key, d);
  }
})();

/**
 * 读原始存储值（key 不存在返回 null）。
 * @param {FeatureDef} def
 * @returns {string|null}
 */
function rawOf(def) {
  if (!def.key) return null;
  return sget(def.key, null);
}

/**
 * 取功能当前值（key 不存在即默认值）。
 * @param {string} id
 * @returns {any}
 */
export function get(id) {
  const def = byId.get(id);
  if (!def) return undefined;
  const raw = rawOf(def);
  if (def.type === 'bool') {
    const defOn = !!def.default;
    if (raw === null) return defOn;
    const st = def.storage || { on: '1', off: null };
    if (st.on !== null && raw === st.on) return true;
    if (st.off !== null && raw === st.off) return false;
    return defOn;
  }
  if (def.type === 'json') {
    if (raw === null) return def.default;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return def.default;
    }
  }
  // enum / string：存的就是值本身
  return raw === null ? def.default : raw;
}

/**
 * 写功能值；等于默认值时删 key（与旧代码语义一致）。
 * @param {string} id
 * @param {any} v
 */
export function set(id, v) {
  const def = byId.get(id);
  if (!def || !def.key) return;
  const dflt = def.default;
  /** @type {string|null|undefined} */
  let raw;
  if (def.type === 'bool') {
    const wantOn = !!v;
    if (wantOn === !!dflt) raw = null;
    else {
      const st = def.storage || { on: '1', off: null };
      raw = wantOn ? st.on : st.off;
    }
  } else if (def.type === 'json') {
    const s = JSON.stringify(v === undefined ? dflt : v);
    raw = s === JSON.stringify(dflt) ? null : s;
  } else {
    raw = v === undefined || v === null || String(v) === String(dflt) ? null : String(v);
  }
  sset(def.key, raw === undefined ? null : raw);
  emit(id);
}

/**
 * 订阅功能变更；返回取消订阅函数。
 * @param {string} id
 * @param {(v:any)=>void} fn
 * @returns {()=>void}
 */
export function on(id, fn) {
  if (!listeners.has(id)) listeners.set(id, new Set());
  const s = listeners.get(id);
  s.add(fn);
  return function () {
    s.delete(fn);
  };
}

/**
 * 触发订阅者 + 旧事件兼容。
 * @param {string} id
 */
function emit(id) {
  const v = get(id);
  const s = listeners.get(id);
  if (s) s.forEach(function (fn) { try { fn(v); } catch (e) {} });
  try {
    window.dispatchEvent(new Event('sgx-settings-changed'));
  } catch (e) {}
}

/* 跨标签页同步：别的标签页改了同一个 key，本页订阅者即时收到 */
try {
  window.addEventListener('storage', function (e) {
    if (!e.key) return;
    const def = byKey.get(e.key);
    if (def) emit(def.id);
  });
} catch (e) {}

/**
 * 取全部定义（调试/设置页用）。
 * @returns {FeatureDef[]}
 */
export function defs() {
  return Array.from(byId.values());
}
