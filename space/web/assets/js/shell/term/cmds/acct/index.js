import { gate, layer, notHere, nth, FLOW } from '../keys/gate.js';

/**
 * 账号命令（v5 S5，term-design-v5「账号」；要 sudo root 登录，账号的 reset 层里 passwd / passkey 也能用）：
 * - passwd：改账号密码 · passkey [add | rm <n>]：账号通行密钥（列表 / 添加 / 删除）
 * - device [rm <n> | rm --all]：登录的设备（列表 / 退出某一台 / 退出其他所有设备）· app [rm <n>]：应用授权（列表 / 取消授权）
 * 命令字和流程照账号那一套（shell/account/*），只是搬进同一个终端。
 */

/** 账号层能不能跑：root，或者正在账号 reset 层里（只给 passwd / passkey） @param {any} x @param {boolean} inReset */
function acctGate(x, inReset) {
  const A = layer(x, 'acct');
  if (inReset && A && A.inReset) return null;
  return gate(x, 'root');
}

const ROOT = /** @type {any} */ (['root']);

const passwd = {
  name: 'passwd',
  audience: ROOT,
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    if (p.args.length) return { out: [x.k.plain(x.S.usagePasswd)] };
    const no = acctGate(x, true);
    if (no) return no;
    const A = layer(x, 'acct');
    if (!A) return notHere(x, 'passwd');
    A.cmdPasswd(true);
    return FLOW;
  },
};

const passkey = {
  name: 'passkey',
  args: ['add', 'rm'],
  audience: ROOT,
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const a = p.args.map(function (s) { return s.toLowerCase(); });
    const no = acctGate(x, true);
    if (no) return no;
    const A = layer(x, 'acct');
    if (!A) return notHere(x, 'passkey');
    if (!a.length) { A.passkeyList(); return FLOW; }
    if (a[0] === 'add' && a.length === 1) { A.cmdPasskeyAdd(true); return FLOW; }
    if (a[0] === 'rm' && a.length === 2 && nth(a[1])) { A.passkeyRm(nth(a[1])); return FLOW; }
    return { out: [x.k.plain(x.S.usagePasskey)] };
  },
};

/** device / app：列表 + rm <n>（+ rm --all） @param {string} name @param {string} usage @param {string} list @param {string} rm @param {string} [rmAll] */
function listRm(name, usage, list, rm, rmAll) {
  return {
    name: name,
    args: ['rm'],
    audience: ROOT,
    /** @param {any} p @param {any} x */
    run: function (p, x) {
      const a = p.args.map(function (s) { return s.toLowerCase(); });
      const no = acctGate(x, false);
      if (no) return no;
      const A = layer(x, 'acct');
      if (!A) return notHere(x, name);
      if (!a.length) { A[list](); return FLOW; }
      if (a[0] === 'rm' && a.length === 2 && nth(a[1])) { A[rm](nth(a[1])); return FLOW; }
      if (rmAll && a[0] === 'rm' && a.length === 2 && a[1] === '--all') { A[rmAll](); return FLOW; }
      return { out: [x.k.plain(x.S[usage])] };
    },
  };
}

export const ACCOUNT_CMDS = [passwd, passkey, listRm('device', 'usageDevice', 'deviceList', 'deviceRm', 'deviceRmAll'), listRm('app', 'usageApp', 'appList', 'appRm')];
