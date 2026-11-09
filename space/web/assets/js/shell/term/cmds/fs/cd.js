import { DIRS, resolvePath } from './tree.js';
import { fill } from '../../core/out.js';

/** cd：改 cwd 和提示符。四个站的目录：主页上滚到那一节，其他页跳到那个站（照旧）；account / shield 只改 cwd，不开下拉（要开用 open） */
export default {
  name: 'cd',
  args: DIRS.concat(['account', 'shield', '~', '..']),
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const r = resolvePath(x.cwd(), p.args[0]);
    if (!r) return { out: [x.k.noDir('cd', p.args[0])] };
    if (!r.dir) return { out: [{ t: 'line', seg: fill(x.S.notDir, { c: ['', 'cd'], x: ['k', p.args[0]] }), cls: 'err' }] };
    const d = r.path;
    const site = d === '~' || DIRS.indexOf(d) >= 0;
    const res = site ? x.act.cd(d) : null;
    x.setCwd(d);
    if (res && res.kind === 'scroll') return { out: res.label ? [x.k.arrow(fill(x.S.scrolled, { x: ['', res.label] }))] : [] };
    if (res && res.kind === 'nav') return { out: [x.k.arrow(fill(x.S.opening, { x: ['k', res.href] }))], after: res.go };
    return { out: [] };
  },
};
