/**
 * @fileoverview 命令引擎（终端统一 T3，设计稿 v1.5 §2.1）：解析 → 查表 → 执行；查不到就给最近的真命令（打错提示）。
 * 不认识具体命令：命令对象在注册表里，宿主给 x（文案、动作、cwd 等）。
 */
import { parse } from './parse.js';
import { suggest } from './suggest.js';

/**
 * @param {{
 *   registry: ReturnType<typeof import('./registry.js').createRegistry>,
 *   x: any,
 *   suggestions: string[],
 *   notFound: (p: {cmd: string, args: string[], rest: string}, sg: string) => any,
 *   empty: () => any,
 * }} o
 */
export function createEngine(o) {
  return {
    /** @param {string} line */
    exec: function (line) {
      const p = parse(line);
      if (!p) return o.empty();
      const c = o.registry.get(p.cmd);
      if (c) return c.run(p, o.x, line);
      return o.notFound(p, suggest(line, o.suggestions));
    },
  };
}
