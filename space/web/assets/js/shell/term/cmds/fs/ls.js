import { resolvePath, listDir } from './tree.js';

/** ls ~/proxy：来源（名称、机场域名或「文件」、节点数、状态），读不到（没登录）就提示 sub @param {any} x */
function lsProxy(x) {
  if (!x.act.proxyList) return { out: [x.k.plain(x.S.lsEmpty)] };
  return x.act.proxyList().then(function (/** @type {any[]|null} */ ls) {
    if (!ls) return { out: [{ t: 'line', seg: [['', '# '], ['k', 'sub'], ['', ' · ~/account']], cls: '' }] };
    if (!ls.length) return { out: [x.k.plain(x.S.lsEmpty)] };
    return {
      out: ls.map(function (s) {
        const st = !s.enabled ? 'off' : s.error ? s.error : 'on';
        return { t: 'line', seg: [['k', s.name], ['', '  ' + (s.type === 'airport' ? s.host : 'file') + '  ' + s.nodes + '  ' + st]], cls: '' };
      }),
    };
  });
}

/** ls [路径]：列目录（目录带 /）；文件就打它的名字 */
export default {
  name: 'ls',
  args: ['blog', 'curio', 'daymark', 'wild', 'account', 'shield', 'proxy'],
  /** @param {any} x */
  help: function (x) { return [['ls', x.S.dLs]]; },
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const r = p.args.length ? resolvePath(x.cwd(), p.args[0]) : { path: x.cwd(), dir: true };
    if (!r) return { out: [x.k.noDir('ls', p.args[0])] };
    if (!r.dir) return { out: [{ t: 'line', seg: [['', r.path.split('/').pop() || '']], cls: '' }] };
    if (r.path === 'proxy') return lsProxy(x);
    const kids = listDir(r.path);
    if (!kids.length) return { out: [x.k.plain(x.S.lsEmpty)] };
    return { out: [{ t: 'line', seg: kids.map(function (n, i) { return /** @type {[string, string]} */ ([/\/$/.test(n) ? 'dir' : '', n + (i < kids.length - 1 ? '  ' : '')]); }), cls: '' }] };
  },
};
