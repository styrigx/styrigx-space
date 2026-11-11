import { resolvePath } from './tree.js';
import { fill } from '../../core/out.js';

/** cd：只改 cwd 和提示符，不滚动、不跳页、不开下拉（Gray 2026-11-10 02:11；终端统一 T6b）。要去那儿用 open。 */
export default {
  name: 'cd',
  args: ['blog', 'curio', 'daymark', 'account', 'proxy', '~', '..'],
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const r = resolvePath(x.cwd(), p.args[0]);
    if (!r) return { out: [x.k.noDir('cd', p.args[0])] };
    if (!r.dir) return { out: [{ t: 'line', seg: fill(x.S.notDir, { c: ['', 'cd'], x: ['k', p.args[0]] }), cls: 'err' }] };
    x.setCwd(r.path);
    return { out: [] };
  },
};
