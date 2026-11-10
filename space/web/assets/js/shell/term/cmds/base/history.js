/** history：这个会话的命令历史（全站一份，sessionStorage；编号从 1 起） */
export default {
  name: 'history',
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const h = x.history();
    if (!h.length) return { out: [] };
    const w = String(h.length).length;
    return {
      out: h.map(function (/** @type {string} */ s, /** @type {number} */ i) {
        const n = String(i + 1);
        return { t: 'line', seg: [['', ' '.repeat(w - n.length) + n + '  '], ['k', s]], cls: '' };
      }),
    };
  },
};
