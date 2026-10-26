/**
 * @fileoverview localStorage 统一封装（带异常保护）。
 * 所有 key 保持原样（sgx-*），旧数据读写不受影响。
 */

/**
 * 读字符串值。
 * @param {string} k
 * @param {string|null} [dflt]
 * @returns {string|null}
 */
export function get(k, dflt) {
  try {
    const v = localStorage.getItem(k);
    return v === null ? (dflt === undefined ? null : dflt) : v;
  } catch (e) {
    return dflt === undefined ? null : dflt;
  }
}

/**
 * 写字符串值；v 为 null/undefined 时删除该 key（兼容旧 __sgxSet 语义）。
 * @param {string} k
 * @param {string|null|undefined} v
 */
export function set(k, v) {
  try {
    if (v === null || v === undefined) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch (e) {}
}

/**
 * 删除 key。
 * @param {string} k
 */
export function remove(k) {
  try {
    localStorage.removeItem(k);
  } catch (e) {}
}

/**
 * 读 JSON 值。
 * @template T
 * @param {string} k
 * @param {T} dflt
 * @returns {T}
 */
export function getJSON(k, dflt) {
  try {
    const v = localStorage.getItem(k);
    if (v === null || v === undefined) return dflt;
    return JSON.parse(v);
  } catch (e) {
    return dflt;
  }
}

/**
 * 写 JSON 值。
 * @param {string} k
 * @param {any} v
 */
export function setJSON(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch (e) {}
}
