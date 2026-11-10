import { layer, notHere, FLOW } from '../keys/gate.js';
import { parseUseradd, parseUsermod } from '../../core/ident-args.js';

/**
 * v6 身份命令（P2b，定稿 v4 §六 / §八）：whoami · su · groups · who · useradd · userdel · usermod。
 * 流程在身份层（shell/identity/layer.js，终端里的 x.v.ident）；这里只查参数。真正的权限判断在服务端（permits）。
 * man 索引只给 v6 身份列（user = v6 普通用户，root6 = v6 root；core/who.js kindOf），没有 v6 会话时四种旧身份的 man 不变（分步割接）。
 * sudo / exit / lock / passwd 沿用原命令名：有 v6 会话或 v6 写法时转到这里（keys/sudo.js、base/exit.js、keys/lock.js、acct/index.js）。
 */

const V6 = /** @type {any} */ (['user', 'root6']);
const V6_ROOT = /** @type {any} */ (['root6']);

/** 身份层（终端窗口里才有；AI 窗口里的 $ 命令没有） @param {any} x @param {string} line */
function ident(x, line) {
  const I = layer(x, /** @type {any} */ ('ident'));
  return I ? { I: I, no: null } : { I: null, no: notHere(x, line) };
}

/** @param {any} x @param {string} key */
function usage(x, key) { return { out: [x.k.plain(x.S[key])] }; }

const whoami = {
  name: 'whoami',
  audience: V6,
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const r = ident(x, 'whoami');
    if (!r.I) return r.no;
    r.I.cmdWhoami();
    return FLOW;
  },
};

const su = {
  name: 'su',
  args: ['root'],
  takesArgs: true,
  audience: /** @type {any} */ (['user']),
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    if (p.args.length !== 1) return usage(x, 'usageSu');
    const r = ident(x, 'su ' + p.args[0]);
    if (!r.I) return r.no;
    r.I.cmdSu(p.args[0].toLowerCase());
    return FLOW;
  },
};

const groups = {
  name: 'groups',
  takesArgs: true,
  audience: V6,
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    if (p.args.length > 1) return usage(x, 'usageGroups');
    const r = ident(x, 'groups');
    if (!r.I) return r.no;
    r.I.cmdGroups(p.args[0] || '');
    return FLOW;
  },
};

const who = {
  name: 'who',
  audience: V6,
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    if (p.args.length) return usage(x, 'usageWho');
    const r = ident(x, 'who');
    if (!r.I) return r.no;
    r.I.cmdWho();
    return FLOW;
  },
};

const useradd = {
  name: 'useradd',
  takesArgs: true,
  audience: V6_ROOT,
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const u = parseUseradd(p.args);
    if (!u) return usage(x, 'usageUseradd');
    const r = ident(x, 'useradd');
    if (!r.I) return r.no;
    r.I.cmdAdmin(Object.assign({ action: 'useradd' }, u), 'useradd ' + p.args.join(' '));
    return FLOW;
  },
};

const userdel = {
  name: 'userdel',
  takesArgs: true,
  audience: V6_ROOT,
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    if (p.args.length !== 1) return usage(x, 'usageUserdel');
    const r = ident(x, 'userdel');
    if (!r.I) return r.no;
    r.I.cmdAdmin({ action: 'userdel', name: p.args[0] }, 'userdel ' + p.args[0]);
    return FLOW;
  },
};

const usermod = {
  name: 'usermod',
  args: ['-aG', '-rG'],
  audience: V6_ROOT,
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const m = parseUsermod(p.args);
    if (!m) return usage(x, 'usageUsermod');
    const r = ident(x, 'usermod');
    if (!r.I) return r.no;
    r.I.cmdAdmin(Object.assign({ action: 'usermod' }, m), 'usermod ' + p.args.join(' '));
    return FLOW;
  },
};

export const IDENT_CMDS = [whoami, su, groups, who, useradd, userdel, usermod];
