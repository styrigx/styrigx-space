import { resolvePath } from './tree.js';

/** cat daymark/today：异步取今日一句（返回 Promise，带 pending = daymark，视图先打「› fetching daymark…」） */
export default {
  name: 'cat',
  args: ['daymark/today'],
  /** @param {any} x */
  help: function (x) { return [['cat', x.S.dCat]]; },
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    if (!p.args[0]) return { out: [x.k.plain(x.S.usageCat)] };
    const r = resolvePath(x.cwd(), p.args[0]);
    if (!r || r.path !== 'daymark/today') return { out: [x.k.tpl('noFile', p.args[0], 'err')] };
    const href = x.act.daymarkHref();
    /** @type {any} */
    const pr = x.act.today().then(function (/** @type {any} */ q) {
      if (q && q.text) {
        /** @type {any[]} */
        const out = [{ t: 'line', seg: [['q', '“' + q.text + '”']], cls: '' }];
        if (q.by) out.push(x.k.plain(q.by));
        return { out: out };
      }
      return { out: [x.k.tpl('todayNone', href, 'o', href)] };
    }, function () {
      return { out: [x.k.tpl('todayFail', href, 'o', href)] };
    });
    pr.pending = 'daymark';
    return pr;
  },
};
