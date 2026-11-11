/**
 * @fileoverview 设备（D1–D9）的终端命令（v5 S5；S9 起账号卡片只展示、只有这一处）。
 *
 * v6（路由表 POST /api/account/devices = user 档，Gray 2026-11-11 定：「设备」= 自己的 v6 会话，uid 只取服务端会话）：
 * - device：列表（[n] 身份路径 · 开始时间，本会话标「此设备」；行的写法同身份层 who）
 * - device rm <n>：[y/N] 退出那一个会话（本会话用 exit）· device rm --all：退出自己的其他所有会话（v6 不要复验）
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

/**
 * 会话开始时间（同身份层 who 的写法：YYYY-MM-DD HH:MM，UTC）。
 * @param {number} ts
 */
export function sinceText(ts) {
  try { return new Date(ts).toISOString().slice(0, 16).replace('T', ' '); } catch (e) { return ''; }
}

/** @param {any} C 账号层上下文（./layer.js） */
export function mountDevices(C) {
  const t = C.t;
  const tf = C.tf;
  const esc = C.esc;
  const api = C.api;
  /** 最近一次列出的会话（rm <n> 的编号对着它；服务端编号 n） @type {any[]} */
  let list = [];

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

  /** device：列出自己的会话（[n] 身份路径 · 开始时间，本会话标「此设备」；同 who 的一行） */
  C.deviceList = function () {
    load(function (ok) {
      if (!ok) return;
      list.forEach(function (/** @type {any} */ d, /** @type {number} */ i) {
        C.out('<span class="sgx-at-p">[' + (i + 1) + ']</span> <span translate="no">' + esc(d.path || '') + '</span>' +
          (d.current ? ' <span class="sgx-at-ok">' + esc(t('devices.current')) + '</span>' : '') + ' <span class="sgx-at-dim">· ' + esc(sinceText(d.since)) + '</span>');
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
      yn(tf('devices.rmAsk', { n: d.path || '' }), function () {
        C.setMode('busy');
        api.devices.revoke(d.n || n).then(function (/** @type {any} */ res) {
          C.toCmd();
          if (res.j && res.j.ok) { C.out('<span class="sgx-at-ok">✓</span> ' + esc(t('devices.outDone'))); list = []; return; }
          if (!C.authErr(res)) C.apiErr(res);
        }, function () { C.netErr(); C.toCmd(); });
      });
    });
  };

  /** device rm --all：退出自己的其他所有会话（v6 不要复验，同 lock-all-devices 定稿 user 档） */
  C.deviceRmAll = function () {
    yn(t('devices.revokeAllAsk'), function () {
      C.setMode('busy');
      api.devices.revokeAll().then(function (/** @type {any} */ res) {
        C.toCmd();
        if (res.j && res.j.ok) { C.out('<span class="sgx-at-ok">✓</span> ' + esc(t('devices.revokeAllDone'))); list = []; return; }
        if (!C.authErr(res)) C.apiErr(res);
      }, function () { C.netErr(); C.toCmd(); });
    });
  };
}
