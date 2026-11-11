import { gate, layer, notHere, nth, line, FLOW } from './gate.js';
import { isV6, v6Root } from '../../core/who.js';

/**
 * share（v5 S5，term-design-v5「分享」）：分享链接。只给用钥匙进站的人（styrigx / root）；分享链接进来的不能发、不能管（403 link）。
 * - share：列出还有效的链接（编号 · 名字 · 页面 · 剩余 · 带不带会话；要 reauth）
 * - share add：新建（名字 → 页面 → 有效期 → 会话档；链接 + 复制）
 * - share rm <n> / share rm --all：作废（y/N；要 reauth）
 * 2b（v6 割接后续）：有 v6 新会话时按 v6 身份——/api/share 是 root 档：v6 root 直接做（不跑旧的锁侧复验 sudo -v，
 * v6 的「每次重验」就是 su root）；v6 普通用户不往下走，提示先 su root（服务端也会 403 forbidden）。
 */
export default {
  name: 'share',
  args: ['add', 'rm'],
  audience: /** @type {any} */ (['styrigx', 'root', 'root6']),
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const a = p.args.map(function (s) { return s.toLowerCase(); });
    const w = x.who();
    if (isV6(w) && !v6Root(w)) return { out: [line(x, 'needRoot6', 'su root')] };
    const no = gate(x, 'keys');
    if (no) return no;
    const S = layer(x, 'space');
    if (!S) return notHere(x, 'share' + (a.length ? ' ' + a.join(' ') : ''));
    /* v6 root：不跑旧的锁侧复验 */
    const o = { direct: isV6(w) };
    if (!a.length) { S.shareList(o); return FLOW; }
    if (a[0] === 'add' && a.length === 1) { S.shareAdd(); return FLOW; }
    if (a[0] === 'rm' && a.length === 2 && a[1] === '--all') { S.shareRmAll(o); return FLOW; }
    if (a[0] === 'rm' && a.length === 2 && nth(a[1])) { S.shareRm(nth(a[1]), o); return FLOW; }
    return { out: [x.k.plain(x.S.usageShare)] };
  },
};
