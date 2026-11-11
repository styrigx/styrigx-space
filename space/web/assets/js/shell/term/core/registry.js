/**
 * @fileoverview 命令注册表（终端统一 T3；v5 S5 起只有一张表）：命令对象按登记顺序排（= man 索引顺序 = 补全顺序），别名指向同一个对象。
 * 命令对象：{ name, aliases?, args?, takesArgs?, audience?, run(p, x, line) }。
 * audience：man 索引给哪些身份列（core/who.js listedFor，唯一判断点）；缺省所有人。只管列不列，不管能不能跑。
 */
import { listedFor, tierOf } from './who.js';

/**
 * @typedef {Object} Cmd
 * @property {string} name
 * @property {string[]} [aliases]
 * @property {string[]} [args] 第二个词的补全候选
 * @property {(arg: string) => string[]} [subArgs] 第二个词 → 第三个词的补全候选（sub token → reset、profile set → name …，S9）
 * @property {boolean} [takesArgs] 没有候选也带参数（补全命令名后加空格）
 * @property {import('./who.js').Who[]} [audience] man 索引的层（取最低的那一层；缺省访客层；空数组不进索引）
 * @property {string} [group] 只给这个组的成员列（root 不看组）
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
    /** 这个身份在 man 索引里列出的命令名（登记顺序） @param {import('./who.js').Who} w @param {any} [u] whoami 的 user */
    listed: function (w, u) { return cmds.filter(function (c) { return listedFor(c, w, u); }).map(function (c) { return c.name; }); },
    /**
     * man 索引的分段（定稿 v5.5 §四：root → 站长 → 普通用户 → 访客，自上而下；各人只看到自己这一层及以下）：
     * 每段 = 这一层的命令名（登记顺序），高的层在前；空段不出。
     * @param {import('./who.js').Who} w @param {any} [u]
     * @returns {string[][]}
     */
    sections: function (w, u) {
      /** @type {string[][]} */
      const by = [[], [], [], []];
      cmds.forEach(function (c) { if (listedFor(c, w, u)) by[tierOf(c)].push(c.name); });
      return by.reverse().filter(function (s) { return s.length > 0; });
    },
  };
}
