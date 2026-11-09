/** lock：立即锁屏（先打印再动） */
export default {
  name: 'lock',
  /** @param {any} x */
  help: function (x) { return [['lock', x.S.dLock]]; },
  /** @param {any} p @param {any} x */
  run: function (p, x) { return { out: [x.k.arrow([['', x.S.locking]])], after: function () { x.act.lock(); } }; },
};
