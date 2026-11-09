import { resolvePath, listDir } from './tree.js';

/** ls [路径]：列目录（目录带 /）；文件就打它的名字 */
export default {
  name: 'ls',
  args: ['blog', 'curio', 'daymark', 'wild', 'account', 'shield'],
  /** @param {any} x */
  help: function (x) { return [['ls', x.S.dLs]]; },
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const r = p.args.length ? resolvePath(x.cwd(), p.args[0]) : { path: x.cwd(), dir: true };
    if (!r) return { out: [x.k.noDir('ls', p.args[0])] };
    if (!r.dir) return { out: [{ t: 'line', seg: [['', r.path.split('/').pop() || '']], cls: '' }] };
    const kids = listDir(r.path);
    if (!kids.length) return { out: [x.k.plain(x.S.lsEmpty)] };
    return { out: [{ t: 'line', seg: kids.map(function (n, i) { return /** @type {[string, string]} */ ([/\/$/.test(n) ? 'dir' : '', n + (i < kids.length - 1 ? '  ' : '')]); }), cls: '' }] };
  },
};
