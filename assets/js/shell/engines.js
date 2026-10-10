/**
 * @fileoverview 搜索引擎共享定义（浏览器页 + 设置页共用）。
 * localStorage key 保持 'sgx-search-engine' 不变；google 为默认，不存值（key 不存在即 google）。
 * 图标引用 layouts/partials/sgx-icon-sprite.html 里的 sgx-ic-eng-* 内联 SVG。
 */
import { get, set } from '../lib/storage.js';
import { on } from '../lib/events.js';

const LS = 'sgx-search-engine';

/**
 * @typedef {Object} Engine
 * @property {string} n 名称
 * @property {string} u URL 模板（含 %s）
 * @property {string} icon sprite 中的图标 id
 */
/** @type {Record<string, Engine>} */
const ENGINES = {
  google: { n: 'Google', u: 'https://www.google.com/search?q=%s', icon: 'sgx-ic-eng-google' },
  bing: { n: 'Bing', u: 'https://www.bing.com/search?q=%s', icon: 'sgx-ic-eng-bing' },
  duckduckgo: { n: 'DuckDuckGo', u: 'https://duckduckgo.com/?q=%s', icon: 'sgx-ic-eng-duckduckgo' },
  yahoo: { n: 'Yahoo', u: 'https://search.yahoo.com/search?p=%s', icon: 'sgx-ic-eng-yahoo' },
  ecosia: { n: 'Ecosia', u: 'https://www.ecosia.org/search?q=%s', icon: 'sgx-ic-eng-ecosia' },
};

const ORDER = ['google', 'bing', 'duckduckgo', 'yahoo', 'ecosia'];

/**
 * @returns {string} 当前引擎 id
 */
export function cur() {
  const e = get(LS);
  return ENGINES[e || ''] ? /** @type {string} */ (e) : 'google';
}

/**
 * @param {string} id
 * @returns {string}
 */
export function engineName(id) {
  const e = ENGINES[id] || ENGINES.google;
  return e.n;
}

/**
 * @param {string} id
 * @param {string|null|undefined} q
 * @returns {string}
 */
export function engineUrl(id, q) {
  const e = ENGINES[id] || ENGINES.google;
  return e.u.replace('%s', encodeURIComponent(q == null ? '' : q));
}

/**
 * @param {string} id
 * @param {number} [size]
 * @returns {string} 内联 SVG 字符串
 */
export function iconUse(id, size) {
  const e = ENGINES[id] || ENGINES.google;
  size = size || 22;
  return (
    '<svg width="' + size + '" height="' + size + '" aria-hidden="true"><use href="#' + e.icon + '"></use></svg>'
  );
}

function notify() {
  try {
    window.dispatchEvent(new Event('sgx-settings-changed'));
  } catch (e) {}
}

/**
 * @param {string} id
 */
export function setCur(id) {
  if (!ENGINES[id]) return;
  set(LS, id === 'google' ? null : id);
  notify();
}

let storageHooked = false;
/**
 * 跨标签页同步：别的标签页改了引擎，本页收到 storage 事件后走同一套通知。
 * 每个页面 bundle 调用一次即可（幂等）。
 */
export function initEngines() {
  if (storageHooked) return;
  storageHooked = true;
  on(window, 'storage', function (/** @type {StorageEvent} */ ev) {
    if (ev && ev.key === LS) notify();
  });
}

export const engines = {
  LS,
  ENGINES,
  ORDER,
  cur,
  name: engineName,
  url: engineUrl,
  iconUse,
  setCur,
  notify,
  init: initEngines,
};
