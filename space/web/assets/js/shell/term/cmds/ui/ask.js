/** ask <问题>：打开 AI 窗口代发 */
export default {
  name: 'ask',
  takesArgs: true,
  /** @param {any} x */
  help: function (x) { return [['ask', x.S.dAsk]]; },
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const q = p.rest;
    return { out: [x.k.arrow([['', x.S.asking]])], after: function () { x.act.ask(q); } };
  },
};
