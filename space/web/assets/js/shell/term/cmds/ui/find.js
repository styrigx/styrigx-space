import { fill } from '../../core/out.js';

/**
 * find <词>：关键词搜索四个站的公开页面（v5 S4；GET /api/find，不走模型、谁都能用）。
 * 异步（返回 Promise，pending = 搜的词，视图先打「› fetching …」）；每条结果一行：标题 · 站 · 路径（链接）。
 * 只在访客（nobody）的 man 里列（进站后搜索走 ask；find 照常能用，只是不列）。
 */
export default {
  name: 'find',
  takesArgs: true,
  audience: /** @type {any} */ (['nobody']),
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const q = p.rest;
    if (!q) return { out: [x.k.plain(x.S.usageFind)] };
    /** @type {any} */
    const pr = x.act.find(q).then(function (/** @type {any} */ r) {
      if (r && r.limited) return { out: [x.k.plain(x.S.findLimited, 'err')] };
      if (!r || r.degraded) return { out: [x.k.plain(x.S.findDown, 'err')] };
      const list = Array.isArray(r.results) ? r.results : [];
      if (!list.length) return { out: [{ t: 'line', seg: fill(x.S.findNone, { x: ['k', q] }), cls: 'o' }] };
      return {
        out: list.map(function (/** @type {any} */ it) {
          return { t: 'line', seg: [['k', String(it.title || '')], ['', '  ' + String(it.site || '') + '  '], ['a', pathOf(String(it.url || '')), String(it.url || '')]], cls: '' };
        }),
      };
    }, function () {
      return { out: [x.k.plain(x.S.findDown, 'err')] };
    });
    pr.pending = q;
    return pr;
  },
};

/** 结果地址 → 显示用的站内路径（https://styrigx.com/blog/x/ → /blog/x/；不是绝对地址原样） @param {string} u */
export function pathOf(u) {
  const m = /^https?:\/\/[^/]+(\/[^?]*)?(?:\?[^#]*)?(#.*)?$/i.exec(u);
  return m ? (m[1] || '/') + (m[2] || '') : u;
}
