/**
 * @fileoverview 命令注册表（终端统一 T3，设计稿 v1.5 §2.1 / §3）：命令对象按登记顺序排（= help 顺序 = 补全顺序），别名指向同一个对象。
 * 命令对象：{ name, aliases?, tty?, args?, takesArgs?, help?, run(p, x) }。tty 缺省 'full'（tty2–5）；tty1 白名单写 ['tty1', 'full']（T4 起用）。
 */

/**
 * @typedef {Object} Cmd
 * @property {string} name
 * @property {string[]} [aliases]
 * @property {string|string[]} [tty]
 * @property {string[]} [args] 第二个词的补全候选
 * @property {boolean} [takesArgs] 没有候选也带参数（补全命令名后加空格）
 * @property {(x: any) => Array<[string, string]>} [help] help 里的行 [命令, 说明]
 * @property {(p: {cmd: string, args: string[], rest: string}, x: any, line: string) => any} run
 */

/** @param {Cmd} c @param {string} [tty] */
function onTty(c, tty) {
  if (!tty) return true;
  const t = c.tty || 'full';
  const arr = Array.isArray(t) ? t : [t];
  return arr.indexOf(tty) !== -1 || (tty !== 'tty1' && arr.indexOf('full') !== -1);
}

/** @param {Cmd[]} cmds */
export function createRegistry(cmds) {
  /** @type {Record<string, Cmd>} */
  const by = Object.create(null);
  cmds.forEach(function (c) {
    by[c.name] = c;
    (c.aliases || []).forEach(function (a) { by[a] = c; });
  });
  /** @param {string} [tty] */
  const list = function (tty) { return cmds.filter(function (c) { return onTty(c, tty); }); };
  return {
    /** 名字或别名 → 命令（不在这个 tty → null） @param {string} n @param {string} [tty] */
    get: function (n, tty) { const c = by[n]; return c && onTty(c, tty) ? c : null; },
    list: list,
    /** @param {string} [tty] */
    names: function (tty) { return list(tty).map(function (c) { return c.name; }); },
  };
}
