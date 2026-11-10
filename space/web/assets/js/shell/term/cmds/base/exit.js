import { layer, FLOW } from '../keys/gate.js';

/**
 * exit（v5 S5）：退回上一层。
 * - reset 层里：离开 reset（钥匙 / 账号各自的 reset）
 * - v6 新会话（P2b）：弹一层（root → 普通用户 → 访客），身份层 shell/identity/layer.js
 * - root@account：退出账号登录，回 styrigx@space（账号那一套 exit，原样）
 * - 其余：关掉终端窗口
 */
export default {
  name: 'exit',
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const S = layer(x, 'space');
    const A = layer(x, 'acct');
    if (S && S.inReset) { S.leaveReset(); return FLOW; }
    if (A && A.inReset) { A.leaveReset(); return FLOW; }
    const I = layer(x, /** @type {any} */ ('ident'));
    if (I && I.cmdExit()) return FLOW;
    if (A && x.who() === 'root') { A.cmdExit(); return FLOW; }
    return { out: [], after: function () { if (x.act.close) x.act.close(); } };
  },
};
