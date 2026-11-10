import { ADMIN_COMMAND } from '../../core/parse.js';
import { fill } from '../../core/out.js';

/**
 * ask <问题>：打开 AI 窗口代发。audience entered：只在进站后的 man 里列。
 * 访客（nobody，AI 上锁）：不开窗口，提示先 sudo styrigx、搜关键词用 find（v5 S4）。
 */
export default {
  name: 'ask',
  takesArgs: true,
  audience: 'entered',
  /** @param {any} x */
  help: function (x) { return [['ask', x.S.dAsk]]; },
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    if (x.visitor()) return { out: [{ t: 'line', seg: fill(x.S.askLocked, { s: ['k', 'sudo ' + ADMIN_COMMAND], f: ['k', 'find'] }), cls: 'o' }] };
    const q = p.rest;
    return { out: [x.k.arrow([['', x.S.asking]])], after: function () { x.act.ask(q); } };
  },
};
