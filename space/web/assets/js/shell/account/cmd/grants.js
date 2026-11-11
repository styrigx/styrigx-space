/**
 * @fileoverview 应用授权（G1–G7）+ 奇趣 / 日刻的授权同意（A17，O6）的终端命令（S9：账号卡片只展示，授权都在终端里）。
 *
 * - app：列表（[n] 名字 · scope · 授权时间和设备 / 已取消授权；敏感操作另要验证的标出来）
 * - app allow <n>：重新授权（要 sudo root reauth，有效期内不再问）· app deny <n>：[y/N] 取消授权（不用验证；只禁改，不禁看）
 * - 授权同意（奇趣 / 日刻的 sudo root 入口，C.consent）：登录后判授权，已授权直接回原页；没授权 → `[y] 允许 [n] 拒绝`（拒绝不写记录），选完收起终端、重新载入
 * 设置同步（prefs）的授权留着（O9）。
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
      return o && o.direct && told ? false : null;
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
   * 重新授权：first = 先 sudo root reauth（app allow，同原来窗口的开关）；否则直接试（授权同意，同原来），服务端要 reauth 再验证后重做
   * 割接：o.direct（v6 root）→ 不跑旧的 reauth（C.gated），服务端 401 / 403 按 v6 提示。
   * @param {string} app @param {boolean} first @param {(ok: boolean) => void} done @param {{direct?: boolean}} [o]
   */
  function allow(app, first, done, o) {
    const name = appName(app);
    const add = function () {
      C.setMode('busy');
      api.grants.add(app).then(function (/** @type {any} */ res) {
        C.toCmd();
        if (res.j && res.j.ok) { C.grants = res.j.grants || C.grants; C.out('<span class="sgx-at-ok">✓</span> ' + esc(tf('grants.regranted', { v: name }))); done(true); return; }
        if (!(o && o.direct) && api.isErr(res, api.ERR.reauth)) { C.reauthExp = 0; C.withReauth(add, t('reauth.lead.grants')); return; }
        if (!C.authErrFor(o, res)) C.apiErr(res);
        done(false);
      }, function () { C.netErr(); C.toCmd(); done(false); });
    };
    if (first) C.gated(o, add, t('reauth.lead.grants'));
    else add();
  }

  /** app allow <n>：重新授权（旧会话要 reauth；v6 root 直接做） @param {number} n @param {{direct?: boolean}} [o] */
  C.appAllow = function (n, o) {
    nthApp(n, function (g) {
      if (g.granted) { C.note('grants.alreadyOn'); return; }
      allow(g.app, true, function () {}, o);
    }, o);
  };

  /* ----- 授权同意（奇趣 / 日刻，O6）：选完（或本来就授权了）收起终端，重新载入回到原页 ----- */
  C.askConsent = function () {
    const app = C.consent ? C.consent.app : '';
    const finish = function () { C.consent = null; C.loginChanged = true; C.finished(); };
    (C.grants ? Promise.resolve(C.grants) : C.loadGrants()).then(function (/** @type {any} */ gs) {
      const g = (gs || []).find(function (/** @type {any} */ x) { return x.app === app; });
      if (!g || g.granted) { finish(); return; }
      const name = appName(app);
      C.out('<span class="sgx-at-w">' + esc(tf('grants.consent.ask', { v: name })) + '</span>');
      C.out(esc(tf('grants.consent.sub', { v: name })));
      C.out('<span class="sgx-at-dim">·</span> ' + esc(t('grants.desc.' + app)));
      const sens = sensText(g);
      if (sens) C.out('<span class="sgx-at-dim">·</span> <span class="sgx-at-y">' + esc(sens) + '</span>');
      C.opts([['y', t('grants.consent.allow')], ['n', t('grants.consent.deny')]]);
      C.out('# ' + esc(tf('grants.consent.hint', { v: name })), 'd');
      C.pick({
        y: function () { C.echoPick('y'); allow(app, false, function () { finish(); }); },
        n: function () { C.echoPick('n'); C.toCmd(); finish(); },
      });
      C.focusIn();
    });
  };
}
