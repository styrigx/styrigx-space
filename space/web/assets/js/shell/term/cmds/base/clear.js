/** clear / cls：清屏 */
export default {
  name: 'clear',
  aliases: ['cls'],
  /** @param {any} x */
  help: function (x) { return [['clear', x.S.dClear]]; },
  run: function () { return { out: [], clear: true }; },
};
