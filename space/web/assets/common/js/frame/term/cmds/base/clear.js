/** clear / cls：清屏 */
export default {
  name: 'clear',
  aliases: ['cls'],
  run: function () { return { out: [], clear: true }; },
};
