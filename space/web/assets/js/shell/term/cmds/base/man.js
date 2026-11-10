import { fill } from '../../core/out.js';
import { shellSection } from '../../core/strings.js';
import { ROOT_COMMAND, ADMIN_COMMAND } from '../../core/parse.js';

/**
 * man [命令]：不带参数是索引（这个身份能用的命令），带参数是那一页。结果交给终端窗口的全屏阅读页（S9，less 式：q / esc / ‹ 返回 退出，
 * 回到原来的命令行，滚动区不动）——不再打进滚动区。没有这一页才在滚动区打一行红字。
 * 页数据懒加载（../../man/pages.js，import()，不进首包）。文案：NAME 说明 = #sgx-i18n-shell 的 man 节，DESCRIPTION / AUTH / NOTES = manBody 节，缺了用 pages.js 的英文底。
 */
export default {
  name: 'man',
  /** 补全候选由命令表登记后填（cmds/index.js：全部命令名） */
  args: /** @type {string[]} */ ([]),
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const want = (p.args[0] || '').toLowerCase();
    return import('../../man/pages.js').then(function (m) {
      /** @type {Record<string, {d: string, syn: string[], desc?: string[], auth?: string, notes?: string[]}>} */
      const P = m.PAGES;
      const D = shellSection(null, 'man');
      const B = shellSection(null, 'manBody');
      /** @param {string} n */
      const desc = function (n) { return typeof D[n] === 'string' ? D[n] : P[n].d; };
      const names = x.names().filter(function (/** @type {string} */ n) { return Object.prototype.hasOwnProperty.call(P, n); });
      if (!want) {
        return {
          out: [x.k.plain(x.S.manIndex)].concat(names.map(function (/** @type {string} */ n) {
            return { t: 'line', seg: [['k', n], ['', ' — ' + desc(n)]], cls: '' };
          })),
          pager: 'MAN(1)',
        };
      }
      const name = x.resolve(want);
      if (!name || !Object.prototype.hasOwnProperty.call(P, name)) return { out: [{ t: 'line', seg: fill(x.S.manNone, { x: ['k', p.args[0]] }), cls: 'err' }] };
      const pg = P[name];
      /** 这一页的译文（行数对不上就整节用英文底，免得中英混排错行） @type {any} */
      const tr = B[name] && typeof B[name] === 'object' ? B[name] : {};
      /** @param {string} k @returns {string[]|undefined} */
      const body = function (k) {
        /** @type {any} */
        const en = /** @type {any} */ (pg)[k];
        if (!en) return undefined;
        const ens = Array.isArray(en) ? en : [en];
        const t = tr[k];
        const ts = Array.isArray(t) ? t : typeof t === 'string' ? [t] : null;
        return ts && ts.length === ens.length ? ts : ens;
      };
      /** @type {any[]} */
      const out = [{ t: 'line', seg: [['', 'NAME']], cls: 'h' }, { t: 'line', seg: [['', '    '], ['k', name], ['', ' — ' + desc(name)]], cls: '' }];
      /** @param {string} s */
      const sub = function (s) { return s.split('{root}').join(ROOT_COMMAND).split('{admin}').join(ADMIN_COMMAND); };
      /** @param {string} h @param {string[]|undefined} ls */
      const sec = function (h, ls) {
        if (!ls || !ls.length) return;
        out.push({ t: 'line', seg: [['', '']], cls: '' });
        out.push({ t: 'line', seg: [['', h]], cls: 'h' });
        ls.forEach(function (s) { out.push({ t: 'line', seg: [['', '    ' + sub(s)]], cls: '' }); });
      };
      sec('SYNOPSIS', pg.syn);
      sec('DESCRIPTION', body('desc'));
      sec('AUTH', body('auth'));
      sec('NOTES', body('notes'));
      return { out: out, pager: name.toUpperCase() + '(1)' };
    }, function () {
      return { out: [{ t: 'line', seg: fill(x.S.manNone, { x: ['k', want] }), cls: 'err' }] };
    });
  },
};
