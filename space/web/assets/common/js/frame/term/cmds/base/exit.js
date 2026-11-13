import { layer, FLOW } from '../keys/gate.js';

/**
 * exit（v6，定稿 v5.2 §六）：有 v6 会话 → 弹一层（root → 普通用户 → 访客；救援直接回访客），身份层 identity/layer.js；
 * 没有登录 → 关掉终端窗口。v6 P4 起旧的 reset 层、root@account 退出随旧会话删除。
 */
export default {
  name: 'exit',
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const I = layer(x, /** @type {any} */ ('ident'));
    if (I && I.cmdExit()) return FLOW;
    return { out: [], after: function () { if (x.act.close) x.act.close(); } };
  },
};
