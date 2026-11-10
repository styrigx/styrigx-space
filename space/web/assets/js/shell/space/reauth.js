/**
 * @fileoverview `sudo -v`：钥匙层的 3 分钟再验证（SPACE-V3 §2.2 C；类比 sudo -v，↔ 账号 sudo root reauth）。v5 S5 起在终端里原地做。
 *
 * 只认解锁密码 / 通行密钥（分享链接进来的会话不能 reauth：服务端 403 link，v5 S1）。要 reauth 的命令（lock passwd、lock passkey、lock --all、
 * share 列表 / 作废）在票有效期内直接做，没有就先在终端里验证，过了接着做。到期、关掉终端窗口、离开页面即结束。
 */

/** @param {any} C 钥匙层上下文（shell/space/layer.js） */
export function mountReauth(C) {
  const t = C.t;
  const api = C.api;
  /** reauth 票到期（毫秒；0 = 没有） */
  C.reauthExp = 0;

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
  C.reauthLeft = function () { return C.reauthExp > Date.now() ? C.reauthExp - Date.now() : 0; };

  /**
   * sudo -v（或要 reauth 的命令先跑的那一段）：选方式 → 验证 → 票
   * @param {(() => void)|null} [then] 通过后接着做的事
   * @param {string} [lead]
   */
  C.cmdReauth = function (then, lead) {
    C.setMode('busy');
    C.loadReauth().then(function (st) {
      C.toCmd();
      if (st === 'session') { C.authErr({ s: 401, j: { error: 'session' } }); return; }
      C.verify({
        reauth: true,
        only: '',
        lead: lead || t('reauth.lead.cmd'),
        done: function () {
          C.setMode('busy');
          C.loadReauth().then(function () {
            C.ok('✓ verified', t('reauth.ok'));
            C.toCmd();
            if (then) then();
          });
        },
      });
    });
  };
  /** 要 reauth 才能做的事：有效期内直接做，没有就先验证 @param {() => void} run @param {string} [lead] */
  C.withReauth = function (run, lead) {
    if (C.reauthLeft()) { run(); return; }
    /* 本页还没问过票：服务端说票还在（同一会话别处刚验过）就直接做 */
    C.setMode('busy');
    C.loadReauth().then(function (st) {
      C.toCmd();
      if (st === 'ok' && C.reauthLeft()) { run(); return; }
      C.cmdReauth(run, lead);
    });
  };
  /** 结束 reauth（关掉终端窗口 / 离开页面） */
  C.endReauth = function () {
    if (!C.reauthExp) return;
    C.reauthExp = 0;
    api.reauth.end();
  };
  try { window.addEventListener('pagehide', function () { C.endReauth(); }); } catch (e) {}
}
