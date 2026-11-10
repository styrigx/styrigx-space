/**
 * @fileoverview 命令注册表（终端统一 T3；v5 S5 起只有一张表）：命令对象按登记顺序排（= man 索引顺序 = 补全顺序），别名指向同一个对象。
 * 命令对象：{ name, aliases?, args?, takesArgs?, audience?, run(p, x, line) }。
 * audience：man 索引给哪些身份列（core/who.js listedFor，唯一判断点）；缺省所有人。只管列不列，不管能不能跑。
 */
import { listedFor } from './who.js';

/**
 * @typedef {Object} Cmd
 * @property {string} name
 * @property {string[]} [aliases]
 * @property {string[]} [args] 第二个词的补全候选
 * @property {boolean} [takesArgs] 没有候选也带参数（补全命令名后加空格）
 * @property {import('./who.js').Who[]} [audience] man 索引只给这些身份列（缺省都列）
 * @property {(p: {cmd: string, args: string[], rest: string}, x: any, line: string) => any} run
 */

export { listedFor };

/** @param {Cmd[]} cmds */
export function createRegistry(cmds) {
  /** @type {Record<string, Cmd>} */
  const by = Object.create(null);
  cmds.forEach(function (c) {
    by[c.name] = c;
    (c.aliases || []).forEach(function (a) { by[a] = c; });
  });
  return {
    /** 名字或别名 → 命令（没有 → null） @param {string} n */
    get: function (n) { return by[n] || null; },
    list: function () { return cmds.slice(); },
    names: function () { return cmds.map(function (c) { return c.name; }); },
    /** 这个身份在 man 索引里列出的命令名 @param {import('./who.js').Who} w */
    listed: function (w) { return cmds.filter(function (c) { return listedFor(c, w); }).map(function (c) { return c.name; }); },
  };
}
