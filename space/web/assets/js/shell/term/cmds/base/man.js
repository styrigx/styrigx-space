import { fill } from '../../core/out.js';
import { shellSection } from '../../core/strings.js';
import { ROOT_COMMAND, ADMIN_COMMAND } from '../../core/parse.js';

/**
 * man [命令]：不带参数列出所有手册页（索引），带参数显示那一页；显示完进 pager（提示符 `:`，q / enter 回命令行）。
 * 页数据懒加载（../../man/pages.js，import()，不进首包）。
 */
export default {
  name: 'man',
  /** 补全候选由命令表登记后填（cmds/index.js：全部命令名） */
  args: /** @type {string[]} */ ([]),
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const want = (p.args[0] || '').toLowerCase();
    return import('../../man/pages.js').then(function (m) {
      /** @type {Record<string, {d: string, syn: string[], desc?: string[], auth?: string, notes?: string[], see?: string}>} */
      const P = m.PAGES;
      /* NAME 说明：#sgx-i18n-shell 的 man 节叠在英文底上 */
      const D = shellSection(null, 'man');
      /** @param {string} n */
      const desc = function (n) { return typeof D[n] === 'string' ? D[n] : P[n].d; };
      const names = x.names().filter(function (/** @type {string} */ n) { return Object.prototype.hasOwnProperty.call(P, n); });
      if (!want) {
        return {
          out: [x.k.plain(x.S.manIndex)].concat(names.map(function (/** @type {string} */ n) {
            return { t: 'line', seg: [['k', n], ['', ' — ' + desc(n)]], cls: '' };
          })),
        };
      }
      const name = x.resolve(want);
      if (!name || !Object.prototype.hasOwnProperty.call(P, name)) return { out: [{ t: 'line', seg: fill(x.S.manNone, { x: ['k', p.args[0]] }), cls: 'err' }] };
      const pg = P[name];
      /** @type {any[]} */
      const out = [x.k.plain(name.toUpperCase() + '(1)'), { t: 'line', seg: [['', 'NAME']], cls: '' }, { t: 'line', seg: [['', '    '], ['k', name], ['', ' — ' + desc(name)]], cls: '' }];
      /** @param {string} s */
      const sub = function (s) { return s.split('{root}').join(ROOT_COMMAND).split('{admin}').join(ADMIN_COMMAND); };
      /** @param {string} h @param {string[]|undefined} ls */
      const sec = function (h, ls) {
        if (!ls || !ls.length) return;
        out.push({ t: 'line', seg: [['', h]], cls: '' });
        ls.forEach(function (s) { out.push({ t: 'line', seg: [['', '    ' + sub(s)]], cls: '' }); });
      };
      sec('SYNOPSIS', pg.syn);
      /** @type {any} */
      const g = pg;
      sec('DESCRIPTION', g.desc);
      sec('AUTH', g.auth ? [g.auth] : undefined);
      sec('NOTES', g.notes);
      sec('SEE ALSO', g.see ? [g.see] : undefined);
      out.push(x.k.plain('(END)'));
      return { out: out, pager: true };
    }, function () {
      return { out: [{ t: 'line', seg: fill(x.S.manNone, { x: ['k', want] }), cls: 'err' }] };
    });
  },
};
