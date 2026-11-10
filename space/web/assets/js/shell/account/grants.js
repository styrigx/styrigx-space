/**
 * @fileoverview 应用授权（G1–G7）+ 奇趣 / 日刻的授权同意（A17，O6）的终端命令（v5 S5：原账号下拉「应用授权」层的开关没有了）。
 *
 * - app：列表（[n] 名字 · scope · 授权时间和设备 / 已取消授权；敏感操作另要验证的标出来）
 * - app rm <n>：[y/N] 取消授权（不用验证）。重新授权在奇趣 / 日刻的授权同意里（sudo root 之后 [y] 允许 [n] 拒绝，要 reauth）
 * 设置同步（prefs）的授权留着（O9）。
 */
import { mmdd } from './keys.js';

/** 应用 → 显示顺序（同 workers/account/src/core/scopes.js） */
export const APP_IDS = Object.freeze(['curio', 'daymark', 'prefs', 'wellbeing', 'avatar', 'profile']);

/** @param {any} C 账号层上下文（shell/account/window.js） */
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

  /** @returns {Promise<any[]|null>} */
  C.loadGrants = function () {
    return api.grants.list().then(function (/** @type {any} */ res) {
      if (res.j && res.j.ok) { C.grants = res.j.grants || []; C.paintGrantCount(); return C.grants; }
      C.authErr(res);
      return null;
    }, function () { return null; });
  };

  /** 取列表（命令用：等待 + 出错提示） @param {(ok: boolean) => void} then */
  function load(then) {
    C.setMode('busy');
    C.loadGrants().then(function (gs) { C.toCmd(); if (!gs) { C.err(t('common.errServer')); then(false); return; } then(true); });
  }

  /** app：列出 */
  C.appList = function () {
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
    });
  };

  /** app rm <n>：取消授权 @param {number} n */
  C.appRm = function (n) {
    load(function (ok) {
      if (!ok) return;
      const g = (C.grants || [])[n - 1];
      if (!g) { C.err(t('grants.noSuch')); C.note('grants.lsFirst', 'app'); return; }
      const name = appName(g.app);
      if (!g.granted) { C.note('grants.alreadyOff'); return; }
      C.out(esc(tf('grants.rmAsk', { v: name })) + ' [y/N]');
      C.pick({
        y: function () {
          C.echoPick('y');
          C.setMode('busy');
          api.grants.revoke(g.app).then(function (/** @type {any} */ res) {
            C.toCmd();
            if (res.j && res.j.ok) { C.grants = res.j.grants || C.grants; C.paintGrantCount(); C.out('<span class="sgx-at-ok">✓</span> ' + esc(tf('grants.revoked', { v: name }))); return; }
            if (!C.authErr(res)) C.apiErr(res);
          }, function () { C.netErr(); C.toCmd(); });
        },
        n: function () { C.echoPick('n'); C.toCmd(); },
      }, 'n', { ps: '[y/N]' });
    });
  };

  /* ----- 授权同意（奇趣 / 日刻，O6） ----- */
  C.askConsent = function () {
    const app = C.consent ? C.consent.app : '';
    const finish = function () { C.consent = null; C.loginChanged = true; C.toCmd(); C.finished(); };
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
        y: function () {
          C.echoPick('y');
          const add = function () {
            C.setMode('busy');
            api.grants.add(app).then(function (/** @type {any} */ res) {
              if (res.j && res.j.ok) { C.ok('✓ ' + tf('grants.regranted', { v: name })); finish(); return; }
              if (C.api.isErr(res, api.ERR.reauth)) { C.reauthExp = 0; C.withReauth(add, t('reauth.lead.grants')); return; }
              C.apiErr(res);
              finish();
            }, function () { C.netErr(); C.toCmd(); });
          };
          add();
        },
        n: function () { C.echoPick('n'); finish(); },
      });
      C.focusIn();
    });
  };
}
