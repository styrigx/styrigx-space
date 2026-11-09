/**
 * @fileoverview `sudo root reset`：登不了时用恢复密钥重置（已登录也能用，O18）。
 *
 * 只收恢复密钥（`[sudo] recovery key:`）→ 3 分钟 reset 票，不签账号会话 → 只能重设账号密码、增删账号通行密钥（不能改名，Q1）
 * → 第一次改完就把三选一顶到终端最下面：[1] 登出全部 [2] 登出除本机以外（默认，enter）[3] 不登出 → api.reset.finish(signOut)（PROPOSAL §1.1）。
 * 没选就关掉 = [3]，提示「还没选，其他设备会保持登录」（O20 / Q5）。恢复密钥连错 5 次锁 15 分钟（服务端，照旧）。
 */
import { CMD, PS_RECOVERY_KEY, MAX_TRIES, TRIES_OVER, TRY_AGAIN } from './commands.js';

/** 三选一：键 → signOut */
export const SIGN_OUT_CHOICES = Object.freeze([['1', 'all'], ['2', 'others'], ['3', 'none']]);

/** @param {any} C */
export function mountReset(C) {
  const t = C.t;
  const api = C.api;
  const esc = C.esc;

  C.renderReset = function () {
    C.barHead(C.resetLeft() ? 'reset · ' + C.mmss(C.resetLeft()) : 'reset');
    const has = !!(C.status && C.status.configured.password);
    C.viewEl.innerHTML = '<div class="sgx-pop-list">' + C.grp(t('reset.group'), true) +
      C.row({ k: t('keys.password.title'), sub: 'account password', v: has ? t('keys.password.set') : t('keys.password.unset'), act: 'passwd', chev: true }) +
      C.grp(t('keys.passkey.title'), true) + C.keyRows(false) + '</div>' +
      /* 底部「^C 返回」（Gray 2026-11-09）：同 Ctrl+C / esc——命令行时离开 reset，正在输入 / 选择时先退出那一步；终端文字样式 */
      '<p class="sgx-at-rcc"><button type="button" data-at-cc data-at-reset-cc translate="no" aria-label="' + esc(t('reset.backAria')) + '"><b>^C</b> ' + esc(t('reset.back')) + '</button></p>';
    C.foot('reset.ft');
  };

  C.cmdReset = function () {
    C.tries = 0;
    C.out(esc(t('reset.lead')));
    askRecoveryKey();
  };
  function askRecoveryKey() {
    C.ask('rkey', function (/** @type {string} */ val) {
      C.setMode('busy');
      api.reset.recoveryKey(val).then(function (/** @type {any} */ res) {
        if (res.j && res.j.ok) {
          C.ok('✓ verified', t('reset.ok'));
          C.note('reset.cooldown');
          return C.loadStatus().then(function () {
            C.inReset = true;
            C.resetPending = false;
            C.keyList = [];
            C.toCmd();
            C.render();
            C.startTick();
            C.loadKeys();
          });
        }
        if (res.s === 429) { C.err(t('common.tooMany')); C.toCmd(); return; }
        if (api.isErr(res, api.ERR.config)) { C.err(t('common.errConfig')); C.toCmd(); return; }
        if (res.s === 401 && api.isErr(res, api.ERR.wrong)) {
          C.tries++;
          if (C.tries >= MAX_TRIES) { C.err(TRIES_OVER); C.toCmd(); return; }
          C.err(TRY_AGAIN);
          askRecoveryKey();
          return;
        }
        if (C.authErr(res)) { C.toCmd(); return; }
        C.apiErr(res);
        C.toCmd();
      }, function () { C.netErr(); C.toCmd(); });
    }, { ps: PS_RECOVERY_KEY, pm: api.PM_USER.recoveryKey, hint: t('common.hidden') });
  }

  /** reset 下第一次改完凭证：三选一顶到终端最下面（§1.1、Q5）。只在 reset 里、还没选过时出 */
  C.afterResetChange = function () {
    if (!C.inReset || C.resetPending) return;
    C.resetPending = true;
    C.ok('✓ ' + t('reset.done'));
    C.out(esc(t('reset.ask')));
    C.opts(SIGN_OUT_CHOICES.map(function (c) { return /** @type {[string, string, boolean?]} */ ([c[0], t('reset.signOut.' + c[1]), c[1] === 'others']); }));
    C.out('# ' + esc(t('reset.signOut.default')) + (C.st !== 'in' ? ' · ' + esc(t('reset.signOut.same')) : ''), 'd');
    /** @type {Record<string, () => void>} */ const picks = {};
    SIGN_OUT_CHOICES.forEach(function (c) {
      picks[c[0]] = function () {
        C.echoPick(c[0]);
        C.setMode('busy');
        api.reset.finish(/** @type {any} */ (c[1])).then(function (/** @type {any} */ res) {
          if (!(res.j && res.j.ok)) {
            if (C.authErr(res)) { C.toCmd(); return; }
            C.apiErr(res);
            C.pick(picks, '2');
            return;
          }
          C.resetPending = false;
          C.ok('✓ ' + (c[1] === 'none' ? t('reset.signOut.kept') : C.tf('reset.signOut.done', { n: res.j.signedOut || 0 })));
          C.endReset(false);
        }, function () { C.netErr(); C.pick(picks, '2'); });
      };
    });
    C.pick(picks, '2');
    C.focusIn();
  };

  /** 主动离开 reset（^C / esc / exit，触屏点 ^C）：同关掉下拉，没选登出方式 = [3] 不登出（提示一句）；不登出本机 */
  C.leaveReset = function () {
    if (!C.inReset) return;
    if (C.resetPending) C.out(esc(t('reset.signOut.pending')), 'warn');
    C.refocus = true;
    C.endReset(false);
  };

  /** 离开 reset：票过期 / 选完 / 401 @param {boolean} expired */
  C.endReset = function (expired) {
    C.stopTick();
    if (expired) {
      if (C.resetPending) C.out(esc(t('reset.signOut.pending')), 'warn');
      C.err(t('reset.ended'), CMD.reset);
    }
    C.inReset = false;
    C.resetPending = false;
    C.resetExp = 0;
    C.loadStatus().then(function () {
      if (C.st !== 'in') C.out('# ' + esc(t('reset.signOut.now')).replace('{x}', C.k(CMD.session)), 'd');
      C.layer = 'home';
      C.toCmd();
      C.render();
    });
  };
}
