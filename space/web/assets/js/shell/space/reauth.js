/**
 * @fileoverview `sudo styrigx reauth`：盾牌里的 3 分钟再验证（SPACE-V3 §2.2 C；类比 sudo -v，↔ sudo root reauth）。
 *
 * 只认解锁密码 / 通行密钥（临时钥匙、分享链接、恢复钥匙都不能再验证，Gray C）；进站会话是怎么来的不管（临时钥匙进来的也能 reauth，
 * 只要输得出解锁密码 / 通行密钥）。提示符不变（styrigx@space:~#），头部显示 `reauth · 2:41`。到期、关掉下拉、离开页面即结束。
 * 要 reauth 的：进站凭证层、临时钥匙层、分享链接管理层、所有设备回锁屏（Q3 定稿 08:00 / Gray 08:03）。
 */
import { CMD, mmss } from './commands.js';

/** @param {any} C 盾牌上下文 */
export function mountReauth(C) {
  const t = C.t;
  const api = C.api;
  let tick = 0;

  /**
   * 读 reauth 票 + 进站凭证配置（POST /api/lock-reauth status）。回 'ok' / 'session'（没进站）/ 'fail'
   * @returns {Promise<string>}
   */
  C.loadReauth = function () {
    return api.reauth.status().then(function (/** @type {any} */ res) {
      const j = res.j;
      if (res.s === 401) return 'session';
      if (!j || !j.ok) return 'fail';
      C.cfg = { password: !!j.password, passkey: !!j.passkey };
      C.reauthExp = j.valid && j.ticket === 'lock-reauth' && j.expiresAt > Date.now() ? j.expiresAt : 0;
      return 'ok';
    }, function () { return 'fail'; });
  };

  /**
   * @param {string} only 直达的方式（'' = 列选项）
   * @param {(() => void)|null} then 通过后做的事（点行触发的：进那一层）
   * @param {string} [lead]
   */
  C.cmdReauth = function (only, then, lead) {
    C.verify({
      reauth: true,
      only: only,
      lead: lead || '',
      done: function () {
        C.setMode('busy');
        C.loadReauth().then(function () {
          C.ok('✓ verified', t('reauth.ok'));
          C.toCmd();
          C.startTick();
          C.render();
          if (then) then();
        });
      },
    });
  };
  /** 要 reauth 才能做的事：有效期内直接做，没有就在终端里 sudo styrigx reauth（调用方已回显命令） @param {() => void} run @param {string} [lead] */
  C.withReauth = function (run, lead) {
    if (C.reauthLeft()) { run(); return; }
    C.cmdReauth('', run, lead);
    C.focusIn();
  };

  C.startTick = function () {
    C.stopTick();
    tick = window.setInterval(function () {
      const cd = C.root.querySelector('[data-sh-cd]');
      if (!C.reauthLeft()) {
        C.stopTick();
        C.reauthExp = 0;
        if (cd) { cd.textContent = C.layer === 'home' ? '' : 'locked'; cd.removeAttribute('data-live'); }
        if (C.layer !== 'home') { C.dropSecrets(); C.err(t('reauth.expired'), CMD.reauth); C.layer = 'home'; C.toCmd(); C.render(); }
        return;
      }
      if (cd) { cd.textContent = 'reauth · ' + mmss(C.reauthLeft()); cd.setAttribute('data-live', ''); }
    }, 1000);
  };
  C.stopTick = function () { if (tick) { window.clearInterval(tick); tick = 0; } };
  /** 结束 reauth（关下拉 / 离开页面） */
  C.endReauth = function () {
    if (!C.reauthExp) return;
    C.reauthExp = 0;
    api.reauth.end();
  };
}
