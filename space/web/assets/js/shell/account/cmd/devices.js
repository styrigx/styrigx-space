/**
 * @fileoverview 设备（D1–D9）的终端命令（v5 S5：账号窗口的「设备」照旧，这里是命令行版）。
 *
 * - device：列表（[n] 名字 · 在线 / 上次活动 · 浏览器 · 地点 · 登录方式，本机标「此设备」）
 * - device rm <n>：[y/N] 退出那一台（本机用 exit）· device rm --all：退出其他所有设备（要 sudo root reauth，O8）
 */

import { agoText } from '../devices.js';

/** @param {any} C 账号层上下文（./layer.js） */
export function mountDevices(C) {
  const t = C.t;
  const tf = C.tf;
  const esc = C.esc;
  const api = C.api;
  /** 最近一次列出的设备（rm <n> 的编号对着它） @type {any[]} */
  let list = [];

  /** @param {any} d */
  function devSub(d) {
    const parts = [d.current ? t('devices.activeNow') : agoText(t, d.lastSeen)];
    if (d.browser) parts.push(d.browser);
    else if (d.platform && d.name !== d.platform) parts.push(d.platform);
    if (d.country) {
      let place = d.country;
      try { place = new Intl.DisplayNames([C.doc.documentElement.lang || 'en'], { type: 'region' }).of(d.country) || d.country; } catch (e) {}
      parts.push(place);
    }
    if (d.by) parts.push(d.by === 'passkey' ? t('devices.byPasskey') : t('devices.byPassword'));
    return parts.join(' · ');
  }
  /** 取列表（不打印） @param {(ok: boolean) => void} then */
  function load(then) {
    C.setMode('busy');
    api.devices.list().then(function (/** @type {any} */ res) {
      C.toCmd();
      if (res.j && res.j.ok) { list = res.j.devices || []; then(true); return; }
      if (!C.authErr(res)) C.apiErr(res);
      then(false);
    }, function () { C.netErr(); C.toCmd(); then(false); });
  }

  /** device：列出 */
  C.deviceList = function () {
    load(function (ok) {
      if (!ok) return;
      list.forEach(function (/** @type {any} */ d, /** @type {number} */ i) {
        C.out('<span class="sgx-at-p">[' + (i + 1) + ']</span> <span translate="no">' + esc(d.name || t('devices.unknown')) + '</span>' +
          (d.current ? ' <span class="sgx-at-ok">' + esc(t('devices.current')) + '</span>' : '') + ' <span class="sgx-at-dim">· ' + esc(devSub(d)) + '</span>');
      });
      if (list.length < 2) C.note('devices.noOthers');
    });
  };

  /** [y/N] @param {string} ask @param {() => void} yes */
  function yn(ask, yes) {
    C.out(esc(ask) + ' [y/N]');
    C.pick({
      y: function () { C.echoPick('y'); yes(); },
      n: function () { C.echoPick('n'); C.toCmd(); },
    }, 'n', { ps: '[y/N]' });
  }

  /** device rm <n> @param {number} n */
  C.deviceRm = function (n) {
    load(function (ok) {
      if (!ok) return;
      const d = list[n - 1];
      if (!d) { C.err(t('devices.noSuch')); C.note('devices.lsFirst', 'device'); return; }
      if (d.current) { C.note('devices.currentHint', 'exit'); return; }
      yn(tf('devices.rmAsk', { n: d.name || t('devices.unknown') }), function () {
        C.setMode('busy');
        api.devices.revoke(d.deviceId).then(function (/** @type {any} */ res) {
          C.toCmd();
          if (res.j && res.j.ok) { C.out('<span class="sgx-at-ok">✓</span> ' + esc(t('devices.outDone'))); list = []; return; }
          if (!C.authErr(res)) C.apiErr(res);
        }, function () { C.netErr(); C.toCmd(); });
      });
    });
  };

  /** device rm --all：退出其他所有设备（要 reauth） */
  C.deviceRmAll = function () {
    C.withReauth(function () {
      yn(t('devices.revokeAllAsk'), function () {
        C.setMode('busy');
        api.devices.revokeAll().then(function (/** @type {any} */ res) {
          C.toCmd();
          if (res.j && res.j.ok) { C.out('<span class="sgx-at-ok">✓</span> ' + esc(t('devices.revokeAllDone'))); list = []; C.loadStatus(); return; }
          if (!C.authErr(res)) C.apiErr(res);
        }, function () { C.netErr(); C.toCmd(); });
      });
    }, t('reauth.lead.devices'));
  };
}
