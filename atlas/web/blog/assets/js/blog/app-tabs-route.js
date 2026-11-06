// 列表页页签的 hash 协议（纯函数，app-tabs.ts 和 tests/app-tabs.test.mjs 共用）。
// 首页 = 无 hash；#posts；#topics；专题筛选 #topics/<tag|category|series>/<slug>。

/** @typedef {'home' | 'posts' | 'topics'} Tab */
/** @typedef {'tag' | 'category' | 'series'} FilterKind */
/** @typedef {{ tab: Tab, filter?: { kind: FilterKind, slug: string } }} Route */

/** @type {readonly Tab[]} */
export const TABS = ['home', 'posts', 'topics'];

/**
 * 解析 hash。认不出的 hash（文章锚点等）返回 null，调用方保持原状。
 * @param {string} hash
 * @returns {Route | null}
 */
export function parseHash(hash) {
  let h = (hash || '').replace(/^#/, '');
  try {
    h = decodeURIComponent(h);
  } catch {
    return null;
  }
  if (!h) return { tab: 'home' };
  const [tab, kind, ...rest] = h.split('/');
  if (!TABS.includes(/** @type {Tab} */ (tab))) return null;
  const slug = rest.join('/');
  if (tab === 'topics' && (kind === 'tag' || kind === 'category' || kind === 'series') && slug) {
    return { tab: 'topics', filter: { kind, slug } };
  }
  return { tab: /** @type {Tab} */ (tab) };
}

/**
 * @param {Route} route
 * @returns {string}
 */
export function routeHash(route) {
  if (route.tab === 'home') return '';
  if (route.tab === 'topics' && route.filter) {
    return `#topics/${route.filter.kind}/${encodeURIComponent(route.filter.slug)}`;
  }
  return `#${route.tab}`;
}
