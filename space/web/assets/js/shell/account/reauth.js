/**
 * @fileoverview `sudo root reauth` / root@account 下的 `sudo -v`：3 分钟再验证（passwd、passkey、重新授权应用、退出其他所有设备前用）。
 *
 * 只收 account passkey / account password（恢复密钥不能再验证）。提示符不变（root@account:~#）。
 * 3 分钟到期、关掉终端窗口、离开页面即结束（O12）。也管 reset 票的倒计时（reset.js 用同一个 tick）。
 */
import { CMD } from './commands.js';

/** @param {any} C */
export function mountReauth(C) {
  const t = C.t;
  let tick = 0;

  /** @param {() => void} [then] @param {string} [lead] */
  C.cmdReauth = function (then, lead) {
    if (C.st !== 'in') { C.err(t('session.notSignedIn'), CMD.session); return; }
    C.verify({ reauth: true, lead: lead || t('reauth.lead.keys'), done: function () { C.render(); if (then) then(); } });
  };
  /** 要 reauth 才能做的事：有效期内直接做，没有就在终端里 sudo root reauth（应用重新授权、退出其他所有设备，O8 / G5） @param {() => void} run @param {string} lead */
  C.withReauth = function (run, lead) {
    if (C.reauthLeft()) { run(); return; }
    C.echo(CMD.reauth);
    C.cmdReauth(run, lead);
    C.focusIn();
  };

  C.startTick = function () {
    C.stopTick();
    tick = window.setInterval(function () {
      const cd = C.root.querySelector('[data-at-cd]');
      if (C.inReset) {
        if (!C.resetLeft()) { C.stopTick(); C.endReset(true); return; }
        if (cd) cd.textContent = 'reset · ' + C.mmss(C.resetLeft());
        return;
      }
      if (!C.reauthLeft()) {
        C.stopTick();
        if (cd) cd.textContent = '';
        return;
      }
      if (cd) cd.textContent = 'reauth · ' + C.mmss(C.reauthLeft());
    }, 1000);
  };
  C.stopTick = function () { if (tick) { window.clearInterval(tick); tick = 0; } };
  /** 结束 reauth（关下拉 / 离开页面，O12） */
  C.endReauth = function () {
    if (!C.reauthExp && !C.resetExp) return;
    C.reauthExp = 0;
    if (!C.resetPending) C.resetExp = 0;
    C.api.reauth.end();
  };
}
