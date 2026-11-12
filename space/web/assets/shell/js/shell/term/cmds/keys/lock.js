import { gate, layer, notHere, FLOW } from './gate.js';

/**
 * lock（v6，定稿 v5.2 §六：lock 清空整个身份栈并删服务端会话行）：全部退出，回到访客（身份层 shell/identity/layer.js）。
 * 带参数一律用法行（旧的 lock passwd / passkey / --all 删干净，不留「已移除」提示，Gray 2026-11-12 15:59）；访客先提示 su。
 */
export default {
  name: 'lock',
  audience: /** @type {any} */ (['user', 'root6']),
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const a = p.args.map(function (s) { return s.toLowerCase(); });
    const no = gate(x);
    if (no) return no;
    if (a.length) return { out: [x.k.plain(x.S.usageLock)] };
    const I = layer(x, /** @type {any} */ ('ident'));
    if (!I) return notHere(x, 'lock');
    I.cmdLock();
    return FLOW;
  },
};
