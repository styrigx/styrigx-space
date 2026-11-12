import { cwdPath } from '../../core/who.js';

/** pwd：当前目录 */
export default {
  name: 'pwd',
  /** @param {any} p @param {any} x */
  run: function (p, x) { return { out: [{ t: 'line', seg: [['', cwdPath(x.cwd())]], cls: '' }] }; },
};
