/** help / ?：cd 一行 + 其余命令各一行（顺序 = 注册表顺序） */
export default {
  name: 'help',
  aliases: ['?'],
  /** @param {any} p @param {any} x */
  run: function (p, x) { return { out: [x.help()] }; },
};
