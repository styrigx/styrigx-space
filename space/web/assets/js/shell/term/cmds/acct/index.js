import { gate, layer, notHere, nth, v6RootGate, FLOW } from '../keys/gate.js';

/**
 * 账号命令（v5 S5，term-design-v5「账号」；要 sudo root 登录，账号的 reset 层里 passwd / passkey 也能用）：
 * - passwd：改账号密码 · passkey [add | rm <n>]：账号通行密钥（列表 / 添加 / 删除）
 * - device [rm <n> | rm --all]：登录的设备（列表 / 退出某一台 / 退出其他所有设备）
 * - app [allow <n> | deny <n>]：应用授权（列表 / 重新授权（要 reauth）/ 取消授权）
 * - profile [set name | nick | sign | email <值> | avatar]：个人资料（S9，账号卡片只展示）
 * 流程在账号层（shell/account/cmd/*）；这里只把门（root）、查参数。
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
  audience: /** @type {any} */ (['root', 'user', 'root6']),
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    /* v6（P2b）：有 v6 新会话时 passwd = 改自己的密码（先输当前密码）、passwd <名> = root 发一次性密码（身份层） */
    const I = layer(x, /** @type {any} */ ('ident'));
    if (I && I.hasSession() && p.args.length <= 1) { I.cmdPasswd(p.args[0] || ''); return FLOW; }
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

/** 账号层命令的共同开头：root 才能跑、要在终端窗口里 @param {any} x @param {string} name @returns {{ A: any, no: any }} */
function acct(x, name) {
  const no = acctGate(x, false);
  if (no) return { A: null, no: no };
  const A = layer(x, 'acct');
  return A ? { A: A, no: null } : { A: null, no: notHere(x, name) };
}

const device = {
  name: 'device',
  args: ['rm'],
  audience: ROOT,
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const a = p.args.map(function (s) { return s.toLowerCase(); });
    const r = acct(x, 'device');
    if (r.no) return r.no;
    if (!a.length) { r.A.deviceList(); return FLOW; }
    if (a[0] === 'rm' && a.length === 2 && nth(a[1])) { r.A.deviceRm(nth(a[1])); return FLOW; }
    if (a[0] === 'rm' && a.length === 2 && a[1] === '--all') { r.A.deviceRmAll(); return FLOW; }
    return { out: [x.k.plain(x.S.usageDevice)] };
  },
};

/**
 * app：割接（v6-commands「授权与订阅（root，或 sudo）」；路由表 POST /api/account/grants = root 档，#401 接了 v6）：
 * 有 v6 会话时同 sub——v6 root 直接做（allow 不跑旧的 sudo root reauth），v6 普通用户提示先 su root，访客先 su <用户>；没有 v6 会话旧路径原样（P4 删）。
 */
const app = {
  name: 'app',
  args: ['allow', 'deny'],
  audience: /** @type {any} */ (['root', 'root6']),
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const a = p.args.map(function (s) { return s.toLowerCase(); });
    const v6 = v6RootGate(x);
    if (v6 && 'out' in v6) return v6;
    const r = v6 ? { A: layer(x, 'acct'), no: null } : acct(x, 'app');
    if (r.no) return r.no;
    if (!r.A) return notHere(x, 'app');
    const o = { direct: !!v6 };
    if (!a.length) { r.A.appList(o); return FLOW; }
    if (a[0] === 'allow' && a.length === 2 && nth(a[1])) { r.A.appAllow(nth(a[1]), o); return FLOW; }
    if (a[0] === 'deny' && a.length === 2 && nth(a[1])) { r.A.appDeny(nth(a[1]), o); return FLOW; }
    return { out: [x.k.plain(x.S.usageApp)] };
  },
};

/** profile set 的字段名（= shell/account/cmd/profile.js PROFILE_KEYS 的键） */
const PROFILE_SET = ['name', 'nick', 'sign', 'email'];

const profile = {
  name: 'profile',
  args: ['set', 'avatar'],
  subArgs: function (/** @type {string} */ a) { return a === 'set' ? PROFILE_SET.slice() : []; },
  audience: ROOT,
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const a0 = (p.args[0] || '').toLowerCase();
    const a1 = (p.args[1] || '').toLowerCase();
    const r = acct(x, 'profile');
    if (r.no) return r.no;
    if (!p.args.length) { r.A.profileShow(); return FLOW; }
    if (a0 === 'avatar' && p.args.length === 1) { r.A.profileAvatar(); return FLOW; }
    /* 值原样（大小写、中间的空格；邮箱可以为空以外的任何写法，检查在账号层） */
    if (a0 === 'set' && PROFILE_SET.indexOf(a1) >= 0 && p.args.length >= 3) {
      r.A.profileSet(a1, p.rest.replace(/^\S+\s+\S+\s+/, ''));
      return FLOW;
    }
    return { out: [x.k.plain(x.S.usageProfile)] };
  },
};

export const ACCOUNT_CMDS = [passwd, passkey, device, app, profile];
