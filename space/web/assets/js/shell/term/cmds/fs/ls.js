import { DIRS, normDir } from './tree.js';

/** ls：~ 下列四个站的目录，daymark 下列 today */
export default {
  name: 'ls',
  args: DIRS.slice(),
  /** @param {any} x */
  help: function (x) { return [['ls', x.S.dLs]]; },
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const d = p.args.length ? normDir(x.cwd(), p.args[0]) : x.cwd();
    if (d === null) return { out: [x.k.noDir('ls', p.args[0])] };
    if (d === '~') return { out: [{ t: 'line', seg: DIRS.map(function (n, i) { return /** @type {[string, string]} */ (['dir', n + '/' + (i < DIRS.length - 1 ? '  ' : '')]); }), cls: '' }] };
    if (d === 'daymark') return { out: [{ t: 'line', seg: [['', 'today']], cls: '' }] };
    return { out: [x.k.plain(x.S.lsEmpty)] };
  },
};
