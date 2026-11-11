import { gate, layer, notHere, FLOW } from './gate.js';

/**
 * lock（v6，定稿 v5.2 §六：lock 清空整个身份栈并删服务端会话行）：全部退出，回到访客（身份层 shell/identity/layer.js）。
 * #404 未决项第 3 项（Gray 11-11 15:37 定稿文案）：已移除的 lock passwd / passkey / --all 印一行「已移除 · v6 做法」
 * （v6 P4 起旧命令本身删了；访客照旧先提示 su）。
 */
export default {
  name: 'lock',
  audience: /** @type {any} */ (['user', 'root6']),
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const a = p.args.map(function (s) { return s.toLowerCase(); });
    const no = gate(x);
    if (no) return no;
    if (a.length) {
      const gone = a[0] === 'passwd' ? 'goneLockPasswd' : a[0] === 'passkey' ? 'goneLockPasskey' : a[0] === '--all' ? 'goneLockAll' : '';
      if (gone) return { out: [x.k.plain(x.S[gone], 'err')] };
      return { out: [x.k.plain(x.S.usageLock)] };
    }
    const I = layer(x, /** @type {any} */ ('ident'));
    if (!I) return notHere(x, 'lock');
    I.cmdLock();
    return FLOW;
  },
};
