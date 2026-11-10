import { layer, FLOW } from '../keys/gate.js';

/**
 * exit（v5 S5）：退回上一层。
 * - reset 层里：离开 reset（钥匙 / 账号各自的 reset）
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
    if (A && x.who() === 'root') { A.cmdExit(); return FLOW; }
    return { out: [], after: function () { if (x.act.close) x.act.close(); } };
  },
};
