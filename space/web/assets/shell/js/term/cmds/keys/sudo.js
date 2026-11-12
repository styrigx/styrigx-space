import { layer, notHere, nth, FLOW } from './gate.js';
import { isV6 } from '../../core/who.js';
import { SUDO_CMDS } from '../../core/ident-args.js';

/**
 * sudo（v6，定稿 v5.2 §六：sudoers 用户每次输自己的凭据，借 root 执行一条，不发票据，不压栈）：
 * sudo useradd | userdel | usermod | passwd <名> | groups [名] | who → 身份层（shell/identity/layer.js）。
 * sudo passkey … → 身份层回 rootCreds（定稿 §十：sudo 不能动 root 的凭据）。
 * sudo device … / sudo sub …（P4-3，定稿 v5.5 §四「后台数据控制……站长用 sudo 提权」）：借 root 跑账号层这一条（sudo app 随 app 命令删除，定稿 v5.3 §十二）。
 *   用法行 / man SYNOPSIS 维持 main 原文。
 * 旧写法 sudo styrigx / sudo root / sudo -v 删干净（定稿 §十三 P4；不留「已移除」提示，Gray 2026-11-12 15:59），落到用法行。
 */
export default {
  name: 'sudo',
  args: [],
  /* man 分段（定稿 v5.5 §四）：站长层；只给 sudoers 组列（root 看全部） */
  audience: /** @type {any} */ (['webmaster', 'root6']),
  group: 'sudoers',
  /** @param {any} p @param {any} x @param {string} [line0] 原样的一行（sub 的来源名大小写敏感） */
  run: function (p, x, line0) {
    const a0 = (p.args[0] || '').toLowerCase();
    if (SUDO_CMDS.indexOf(a0) !== -1 || (a0 === 'passkey' && isV6(x.who()))) {
      const I = layer(x, /** @type {any} */ ('ident'));
      if (!I) return notHere(x, 'sudo ' + p.args.join(' '));
      I.cmdSudo([a0].concat(p.args.slice(1)));
      return FLOW;
    }
    /* P4-3（定稿 v5.5 §四「后台数据控制……一律 root 档，站长用 sudo 提权、不必 su root」）：sudo device … / sudo sub … 借 root 跑这一条——
       身份层先验自己的凭据（[sudo] password for <自己>:），这一条命令里账号接口都改走 POST /api/identity sudo（shell/account/api.js setSudo） */
    if ((a0 === 'device' || a0 === 'sub') && isV6(x.who())) {
      const I = layer(x, /** @type {any} */ ('ident'));
      const A = layer(x, /** @type {any} */ ('acct'));
      if (!I || !A) return notHere(x, 'sudo ' + p.args.join(' '));
      const rest = String(line0 || '').trim().replace(/^sudo\s+/i, '');
      const go = function () {
        if (a0 === 'sub') { A.cmdSub(rest); return; }
        const a = p.args.slice(1).map(function (s) { return s.toLowerCase(); });
        if (!a.length) { A.deviceList(); return; }
        if (a[0] === 'rm' && a.length === 2 && nth(a[1])) { A.deviceRm(nth(a[1])); return; }
        A.deviceRmAll();
      };
      const a = p.args.slice(1).map(function (s) { return s.toLowerCase(); });
      if (a0 === 'device' && a.length && !(a[0] === 'rm' && a.length === 2 && (nth(a[1]) || a[1] === '--all'))) return { out: [x.k.plain(x.S.usageDevice)] };
      I.sudoProof(function (/** @type {any} */ via) { A.sudo(via); go(); });
      return FLOW;
    }
    return { out: [x.k.plain(x.S.usageSudo)] };
  },
};
