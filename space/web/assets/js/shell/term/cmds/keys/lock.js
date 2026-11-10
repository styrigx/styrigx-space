import { gate, layer, notHere, nth, FLOW } from './gate.js';

/**
 * lock（v5 S5）：钥匙层。
 * - lock：立即上锁（只锁本机，不验证）→ 页面重新取一次，回到访客
 * - lock passwd：设 / 改解锁密码（要 reauth，终端里原地验证）
 * - lock passkey [add | rm <n>]：列出 / 添加 / 删除进站通行密钥（要 reauth）
 * - lock --all：所有设备回访客（要 reauth；原盾牌「所有设备回锁屏」）
 * 分享链接进来的会话：lock 可以，其余不行（403 link）。和账号的 passwd / passkey 分开（Gray 15:30）。
 * v6（P2b）：有 v6 新会话时，lock = 清空整个身份栈、回访客（身份层）；旧进站会话还在的话提示符回到旧身份，再 lock 一次照旧。
 */
export default {
  name: 'lock',
  args: ['passwd', 'passkey', '--all'],
  audience: /** @type {any} */ (['link', 'styrigx', 'root', 'user', 'root6']),
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const a = p.args.map(function (s) { return s.toLowerCase(); });
    const usage = { out: [x.k.plain(x.S.usageLock)] };
    const I = layer(x, /** @type {any} */ ('ident'));
    if (!a.length && I && I.hasSession()) { I.cmdLock(); return FLOW; }
    const no = gate(x, a.length ? 'keys' : 'entered');
    if (no) return no;
    const S = layer(x, 'space');
    if (!S) return notHere(x, p.cmd + (a.length ? ' ' + a.join(' ') : ''));
    if (!a.length) { S.lockNow(); return FLOW; }
    if (a[0] === '--all' && a.length === 1) { S.lockAll(); return FLOW; }
    if (a[0] === 'passwd' && a.length === 1) { S.cmdPasswd(); return FLOW; }
    if (a[0] === 'passkey') {
      if (a.length === 1) { S.passkeyList(); return FLOW; }
      if (a[1] === 'add' && a.length === 2) { S.passkeyAdd(); return FLOW; }
      if (a[1] === 'rm' && a.length === 3 && nth(a[2])) { S.passkeyRm(nth(a[2])); return FLOW; }
    }
    return usage;
  },
};
