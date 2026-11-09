import { DIRS, normDir } from './tree.js';
import { fill } from '../../core/out.js';

/** cd：改 cwd；主页上滚到那一节，其他页跳到那个站（T6 改成不跳页） */
export default {
  name: 'cd',
  args: DIRS.concat(['~', '..']),
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const d = normDir(x.cwd(), p.args[0]);
    if (d === null) return { out: [x.k.noDir('cd', p.args[0])] };
    const r = x.act.cd(d);
    x.setCwd(d);
    if (r && r.kind === 'scroll') return { out: r.label ? [x.k.arrow(fill(x.S.scrolled, { x: ['', r.label] }))] : [] };
    if (r && r.kind === 'nav') return { out: [x.k.arrow(fill(x.S.opening, { x: ['k', r.href] }))], after: r.go };
    return { out: [] };
  },
};
