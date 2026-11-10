/**
 * @fileoverview 应用授权（G1–G7）的终端命令（v5 S5；账号窗口的「应用授权」（搜索 / 标签 / 开关）和奇趣 / 日刻的授权同意照旧在窗口里，../grants.js）。
 *
 * - app：列表（[n] 名字 · scope · 授权时间和设备 / 已取消授权；敏感操作另要验证的标出来）
 * - app rm <n>：[y/N] 取消授权（不用验证）。重新授权在账号窗口的开关或奇趣 / 日刻的授权同意里（要 reauth）
 * 设置同步（prefs）的授权留着（O9）。
 */
import { mmdd } from '../keys.js';

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
}
