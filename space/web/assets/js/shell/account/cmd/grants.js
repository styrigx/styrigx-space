/**
 * @fileoverview 应用授权（G1–G7）+ 奇趣 / 日刻的授权同意（A17，O6）的终端命令（S9：账号卡片只展示，授权都在终端里）。
 *
 * - app：列表（[n] 名字 · scope · 授权时间和设备 / 已取消授权；敏感操作另要验证的标出来）
 * - app allow <n>：重新授权 · app deny <n>：[y/N] 取消授权（只禁改，不禁看）
 * v6（路由表 POST /api/account/grants = root 档）：只有 v6 root 能跑（终端 cmds/acct 把门），不再跑旧的 sudo root reauth。
 * v6 P4 起奇趣 / 日刻的旧授权同意入口（sudo root &app=…，C.consent）随旧账号会话删除。
 */
import { mmdd } from './keys.js';

/** @param {any} C 账号层上下文（./layer.js） */
export function mountGrants(C) {
  const t = C.t;
  const tf = C.tf;
  const esc = C.esc;
  const api = C.api;
  /** @type {any[]|null} */
  C.grants = null;

  /** @param {string} app */
  const appName = function (app) { return t('grants.app.' + app) || app; };
  /** @param {any} g */
  const sensText = function (g) { return g.sensitive && g.sensitive.length && t('grants.sens.' + g.app) ? tf('grants.sensitive', { v: t('grants.sens.' + g.app) }) : ''; };

  /**
   * @param {{direct?: boolean}} [o] 割接：v6 root（终端 cmds/acct app 判过）；服务端 401 / 403 forbidden 按 v6 提示（C.authErrFor），已提示过回 false
   * @returns {Promise<any[]|null|false>}
   */
  C.loadGrants = function (o) {
    return api.grants.list().then(function (/** @type {any} */ res) {
      if (res.j && res.j.ok) { C.grants = res.j.grants || []; return C.grants; }
      const told = C.authErrFor(o, res);
      return told ? false : null;
    }, function () { return null; });
  };

  /** 取列表（命令用：等待 + 出错提示） @param {(ok: boolean) => void} then @param {{direct?: boolean}} [o] */
  function load(then, o) {
    C.setMode('busy');
    C.loadGrants(o).then(function (gs) {
      C.toCmd();
      if (gs === false) { then(false); return; }
      if (!gs) { C.err(t('common.errServer')); then(false); return; }
      then(true);
    });
  }

  /** app：列出 @param {{direct?: boolean}} [o] */
  C.appList = function (o) {
    load(function (ok) {
      if (!ok) return;
      const all = C.grants || [];
      if (!all.length) { C.note('grants.none'); return; }
      all.forEach(function (/** @type {any} */ g, /** @type {number} */ i) {
        const dev = g.device ? (g.device.gone ? t('grants.deviceGone') : g.device.name || t('devices.unknown')) : '';
        const when = g.granted ? tf('grants.at', { d: mmdd(g.grantedAt) }) + (dev ? ' · ' + dev : '') : t('grants.offAt');
        const sens = sensText(g);
        C.out('<span class="sgx-at-p">[' + (i + 1) + ']</span> ' + (g.granted ? '' : '<span class="sgx-at-dim">') + esc(appName(g.app) || g.name) + (g.granted ? '' : '</span>') +
          ' <span class="sgx-at-dim">· <span translate="no">' + esc((g.scopes || []).join(' ')) + '</span> · ' + esc(when) + '</span>' + (sens ? ' <span class="sgx-at-y">' + esc(sens) + '</span>' : ''));
      });
    }, o);
  };

  /** 第 n 个应用（没有 → 报错、提示先列出来） @param {number} n @param {(g: any, name: string) => void} then @param {{direct?: boolean}} [o] */
  function nthApp(n, then, o) {
    load(function (ok) {
      if (!ok) return;
      const g = (C.grants || [])[n - 1];
      if (!g) { C.err(t('grants.noSuch')); C.note('grants.lsFirst', 'app'); return; }
      then(g, appName(g.app));
    }, o);
  }

  /** app deny <n>：取消授权（[y/N]，不用验证） @param {number} n @param {{direct?: boolean}} [o] */
  C.appDeny = function (n, o) {
    nthApp(n, function (g, name) {
      if (!g.granted) { C.note('grants.alreadyOff'); return; }
      C.out(esc(tf('grants.rmAsk', { v: name })) + ' [y/N]');
      C.pick({
        y: function () {
          C.echoPick('y');
          C.setMode('busy');
          api.grants.revoke(g.app).then(function (/** @type {any} */ res) {
            C.toCmd();
            if (res.j && res.j.ok) { C.grants = res.j.grants || C.grants; C.out('<span class="sgx-at-ok">✓</span> ' + esc(tf('grants.revoked', { v: name }))); return; }
            if (!C.authErrFor(o, res)) C.apiErr(res);
          }, function () { C.netErr(); C.toCmd(); });
        },
        n: function () { C.echoPick('n'); C.toCmd(); },
      }, 'n', { ps: '[y/N]' });
    }, o);
  };

  /**
   * 重新授权（v6 root 直接做），服务端 401 / 403 按 v6 提示。
   * @param {string} app @param {(ok: boolean) => void} done @param {{direct?: boolean}} [o]
   */
  function allow(app, done, o) {
    const name = appName(app);
    const add = function () {
      C.setMode('busy');
      api.grants.add(app).then(function (/** @type {any} */ res) {
        C.toCmd();
        if (res.j && res.j.ok) { C.grants = res.j.grants || C.grants; C.out('<span class="sgx-at-ok">✓</span> ' + esc(tf('grants.regranted', { v: name }))); done(true); return; }
        if (!C.authErrFor(o, res)) C.apiErr(res);
        done(false);
      }, function () { C.netErr(); C.toCmd(); done(false); });
    };
    add();
  }

  /** app allow <n>：重新授权（v6 root 直接做） @param {number} n @param {{direct?: boolean}} [o] */
  C.appAllow = function (n, o) {
    nthApp(n, function (g) {
      if (g.granted) { C.note('grants.alreadyOn'); return; }
      allow(g.app, function () {}, o);
    }, o);
  };
}
