import { gate, layer, notHere, nth, FLOW } from './gate.js';

/**
 * share（v5 S5，term-design-v5「分享」）：分享链接。只给用钥匙进站的人（styrigx / root）；分享链接进来的不能发、不能管（403 link）。
 * - share：列出还有效的链接（编号 · 名字 · 页面 · 剩余 · 带不带会话；要 reauth）
 * - share add：新建（名字 → 页面 → 有效期 → 会话档；链接 + 复制）
 * - share rm <n> / share rm --all：作废（y/N；要 reauth）
 */
export default {
  name: 'share',
  args: ['add', 'rm'],
  audience: /** @type {any} */ (['styrigx', 'root']),
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const a = p.args.map(function (s) { return s.toLowerCase(); });
    const no = gate(x, 'keys');
    if (no) return no;
    const S = layer(x, 'space');
    if (!S) return notHere(x, 'share' + (a.length ? ' ' + a.join(' ') : ''));
    if (!a.length) { S.shareList(); return FLOW; }
    if (a[0] === 'add' && a.length === 1) { S.shareAdd(); return FLOW; }
    if (a[0] === 'rm' && a.length === 2 && a[1] === '--all') { S.shareRmAll(); return FLOW; }
    if (a[0] === 'rm' && a.length === 2 && nth(a[1])) { S.shareRm(nth(a[1])); return FLOW; }
    return { out: [x.k.plain(x.S.usageShare)] };
  },
};
