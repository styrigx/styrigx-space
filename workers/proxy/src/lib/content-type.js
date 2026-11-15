/**
 * 按后缀给 Content-Type（上游给的不用：GitHub raw 一律 text/plain，jsDelivr 也不可靠）。
 */
const TYPES = {
  mrs: 'application/octet-stream',
  yaml: 'text/yaml; charset=utf-8',
  list: 'text/plain; charset=utf-8',
};

/** @param {string} pathname */
export function contentType(pathname) {
  return TYPES[pathname.slice(pathname.lastIndexOf('.') + 1)] || 'application/octet-stream';
}
