import { fill } from '../../core/out.js';

/**
 * ask <问题>：打开 AI 窗口代发。只在进站后的 man 里列（audience；v6 只列 root）。
 * 访客（nobody，AI 上锁）：不开窗口，提示先 su、搜关键词用 find（v5 S4；割接起入口是 su，同 AI 窗口的「已上锁，su 登录后可用」，定稿 §七）。
 */
export default {
  name: 'ask',
  takesArgs: true,
  /* #404 未决项第 7 项（Gray 11-11 15:37）：v6 root（root6）能用 Gray AI，进它的 man；普通用户（user）不列（AI 只对 styrigx 和 root 开放，#403） */
  audience: /** @type {any} */ (['link', 'styrigx', 'root', 'root6']),
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    if (x.who() === 'nobody') return { out: [{ t: 'line', seg: fill(x.S.askLocked, { s: ['k', 'su'], f: ['k', 'find'] }), cls: 'o' }] };
    const q = p.rest;
    return { out: [x.k.arrow([['', x.S.asking]])], after: function () { x.act.ask(q); } };
  },
};
