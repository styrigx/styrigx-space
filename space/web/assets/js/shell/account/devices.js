/**
 * @fileoverview 设备（D1–D9）：此设备（名字、在线 · 浏览器 · 地点、登录方式、退出账号）、其他设备（上次活动、单独退出两步）、
 * 退出其他所有设备（要 sudo root reauth，O8）。
 */

/**
 * 「上次活动」相对时间。
 * @param {(k: string) => string} t @param {number} ts @param {number} [now]
 */
export function agoText(t, ts, now) {
  const diff = Math.max(0, (now || Date.now()) - (ts || 0));
  const min = Math.floor(diff / 60000);
  if (min < 2) return t('devices.justNow');
  if (min < 60) return t('devices.minAgo').replace('{n}', String(min));
  const h = Math.floor(min / 60);
  if (h < 24) return t('devices.hourAgo').replace('{n}', String(h));
  return t('devices.dayAgo').replace('{n}', String(Math.floor(h / 24)));
}

/** @param {any} C */
export function mountDevices(C) {
  const t = C.t;
  const esc = C.esc;
  const api = C.api;
  /** @type {any[]|null} */
  C.devices = null;

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
    return parts.join(' · ');
  }
  C.renderDevices = function () {
    const list = C.devices || [];
    C.subHead(t('devices.title'), C.devices ? C.tf('devices.nSessions', { n: list.length }) : '');
    const me = list.find(function (/** @type {any} */ d) { return d.current; });
    const others = list.filter(function (/** @type {any} */ d) { return !d.current; });
    const by = (me && me.by) || (C.status && C.status.session && C.status.session.by) || '';
    let h = C.grp(t('devices.this'));
    if (me) h += C.row({ k: me.name || t('devices.unknown'), sub: devSub(me), vHtml: '<span class="sgx-at-acc">' + esc(t('devices.current')) + '</span>' });
    h += C.row({ k: t('devices.by'), v: by === 'passkey' ? t('devices.byPasskey') : by ? t('devices.byPassword') : '' }) +
      C.row({ k: t('devices.signOut'), v: 'exit', act: 'exit', cls: 'sgx-pop-row--acc' }) + C.noteP(t('devices.keepNote'));
    h += C.grp(t('devices.others'), true);
    if (C.devices && !others.length) h += C.noteP(t('devices.noOthers'));
    others.forEach(function (/** @type {any} */ d) {
      const a = C.armed === 'dev:' + d.deviceId;
      h += C.row({ k: d.name || t('devices.unknown'), sub: devSub(d), vHtml: '<span class="sgx-at-acc">' + esc(a ? t('devices.outAsk') : t('devices.out')) + '</span>', act: 'dev:' + d.deviceId, armed: a });
    });
    if (others.length) h += C.row({ k: t('devices.revokeAll'), v: C.reauthLeft() ? '' : t('reauth.need'), act: 'revoke-all', cls: 'sgx-pop-row--acc', armed: C.armed === 'revoke-all' });
    C.viewEl.innerHTML = '<div class="sgx-pop-list">' + h + '</div>';
    C.foot('devices.ft');
  };
  C.loadDevices = function () {
    return api.devices.list().then(function (/** @type {any} */ res) {
      if (res.j && res.j.ok) { C.devices = res.j.devices || []; if (C.layer === 'devices') C.renderDevices(); return; }
      if (C.authErr(res)) return;
      C.apiErr(res);
    }, function () { C.netErr(); });
  };

  /** @param {string} a @returns {boolean} */
  C.actDevices = function (a) {
    if (a.indexOf('dev:') === 0) {
      const id = a.slice(4);
      if (C.armed !== a) { C.armed = a; C.renderDevices(); return true; }
      C.armed = '';
      api.devices.revoke(id).then(function (/** @type {any} */ res) {
        if (res.j && res.j.ok) { C.out('<span class="sgx-at-ok">✓</span> ' + esc(t('devices.outDone'))); C.devices = (C.devices || []).filter(function (/** @type {any} */ d) { return d.deviceId !== id; }); C.renderDevices(); return; }
        if (C.authErr(res)) return;
        C.apiErr(res);
        C.renderDevices();
      }, function () { C.netErr(); });
      return true;
    }
    if (a === 'revoke-all') {
      if (C.armed !== a) { C.armed = a; C.renderDevices(); return true; }
      C.armed = '';
      C.withReauth(function () {
        api.devices.revokeAll().then(function (/** @type {any} */ res) {
          if (res.j && res.j.ok) { C.out('<span class="sgx-at-ok">✓</span> ' + esc(t('devices.revokeAllDone'))); C.loadStatus().then(C.loadDevices); return; }
          if (C.authErr(res)) return;
          C.apiErr(res);
        }, function () { C.netErr(); });
      }, t('reauth.lead.devices'));
      return true;
    }
    return false;
  };
}
