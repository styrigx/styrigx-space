/**
 * @fileoverview 账号钥匙（account password、account passkey）的终端命令（账号命令体系 v3；v5 S5 起在同一个终端里：原账号下拉「账号安全」层的行没有了）。
 *
 * - passwd：New / Retype（不回显、可粘贴，最短 8 位，S4）
 * - passkey：列表（[n] 名字 · 保存在哪 · 创建日期 · 上次使用，S6）· passkey add：系统窗口 → 终端里命名（默认设备名，可 skip，S7）· passkey rm <n>：[y/N]（S9 提示去 Samsung Pass 手动删）
 * 账号安全要 sudo root reauth（S1，终端里原地验证）；sudo root reset 里同一套命令走 reset 票（不能命名，Q1），改完触发三选一。
 */
import { registerPasskey, genPkPrefillName, cleanPasskeyName } from '../../auth/passkey-register.js';
import { normCmd } from './commands.js';
import { signalPasskeyName } from './passkey-signal.js';

/** MM-DD @param {number} ts */
export function mmdd(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = function (/** @type {number} */ n) { return (n < 10 ? '0' : '') + n; };
  return p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** @param {any} C 账号层上下文（shell/account/window.js） */
export function mountKeys(C) {
  const t = C.t;
  const tf = C.tf;
  const esc = C.esc;
  const api = C.api;
  /** 最近一次列出的通行密钥（rm <n> 的编号对着它） @type {any[]} */
  C.keyList = [];
  /** 写操作：reset 里走 reset 票，账号安全走 reauth 票 */
  const ops = function () { return C.inReset ? api.reset : api.keys; };
  /** reset 里不用 reauth；其余要 sudo root reauth（有效期内直接做） @param {() => void} run */
  const guard = function (run) { if (C.inReset || C.reauthLeft()) run(); else C.withReauth(run, t('reauth.lead.keys')); };

  /** @param {string} id */
  function provLabel(id) { return id && /^[a-z0-9-]+$/.test(id) ? t('keys.passkey.provider.' + id.replace(/-/g, '_')) : ''; }
  /** @param {any} key */
  function keyName(key) { return key.name || provLabel(key.provider) || t('keys.passkey.unnamed'); }

  /** 取列表（不打印） @param {(ok: boolean) => void} [then] */
  C.loadKeys = function (then) {
    C.setMode('busy');
    return ops().passkeyList().then(function (/** @type {any} */ res) {
      C.toCmd();
      if (res.j && res.j.ok) {
        C.keyList = res.j.keys || [];
        signalPasskeyName(res.j);
        if (then) then(true);
        return;
      }
      if (!C.authErr(res)) C.apiErr(res);
      if (then) then(false);
    }, function () { C.netErr(); C.toCmd(); if (then) then(false); });
  };

  /** passkey：列出 */
  C.passkeyList = function () {
    guard(function () {
      C.loadKeys(function (ok) {
        if (!ok) return;
        if (!C.keyList.length) { C.note('keys.passkey.none'); return; }
        C.keyList.forEach(function (/** @type {any} */ key, /** @type {number} */ i) {
          const sub = [provLabel(key.provider), tf('keys.passkey.created', { d: mmdd(key.createdAt) }), key.lastUsedAt ? tf('keys.passkey.lastUsed', { d: mmdd(key.lastUsedAt) }) : t('keys.passkey.neverUsed')].filter(Boolean).join(' · ');
          C.out('<span class="sgx-at-p">[' + (i + 1) + ']</span> <span translate="no" data-sgx-personal>' + esc(keyName(key)) + '</span> <span class="sgx-at-dim">· ' + esc(sub) + '</span>');
        });
      });
    });
  };

  /** passwd：New / Retype（不回显） @param {boolean} [typed] 命令是敲进来的（已回显） */
  C.cmdPasswd = function (typed) {
    if (!typed) C.echo('passwd');
    guard(function () {
      const pm = { pm: api.PM_USER.password, hint: t('common.hidden') };
      C.ask('newpw', function (/** @type {string} */ v1) {
        if (v1.length < 8) { C.err(t('keys.password.short')); C.toCmd(); return; }
        C.ask('newpw2', function (/** @type {string} */ v2) {
          if (v2 !== v1) { C.err(t('keys.password.mismatch')); C.toCmd(); return; }
          C.setMode('busy');
          ops().passwordSet(v2).then(function (/** @type {any} */ res) {
            if (res.j && res.j.ok) {
              C.out('<span class="sgx-at-ok">' + esc(t('keys.password.updated')) + '</span>');
              if (C.status) C.status.configured.password = true;
              C.toCmd();
              C.afterResetChange();
              return;
            }
            if (C.authErr(res)) { C.toCmd(); return; }
            C.apiErr(res);
            C.toCmd();
          }, function () { C.netErr(); C.toCmd(); });
        }, Object.assign({ ps: t('keys.password.retype') }, pm));
      }, Object.assign({ ps: t('keys.password.new') }, pm));
    });
  };

  /** passkey add：系统窗口 → 注册 → 命名（reset 里不命名，Q1） @param {boolean} [typed] */
  C.cmdPasskeyAdd = function (typed) {
    if (!typed) C.echo('passkey add');
    guard(function () {
      C.setMode('busy', { cc: true });
      const toRes = function (/** @type {any} */ r) { return { status: r.s, json: r.j }; };
      const x = ops();
      let done = false;
      /* 等系统窗口时可 ^C / esc / 点 ^C（2026-11-09）：收起系统窗口（AbortController），之后回来的结果不再提示、不再提交注册 */
      let stopped = false;
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      C.busyCancel = function () { stopped = true; try { if (ac) ac.abort(); } catch (e) {} };
      registerPasskey({
        stale: function () { return stopped; },
        signal: ac ? ac.signal : undefined,
        challenge: function () { return x.passkeyAddChallenge().then(toRes); },
        register: function (/** @type {any} */ body) { return x.passkeyAdd(body).then(toRes); },
        onAuthError: function (/** @type {any} */ res) { return C.authErr({ s: res.status, j: res.json }); },
        onRegistered: function (/** @type {string} */ credId, /** @type {string} */ prefill) {
          done = true;
          C.busyCancel = null;
          C.keyList = [];
          /* ^C 时注册请求已经发出去了：钥匙已存上，不再接着问名字 */
          if (stopped) return;
          C.ok('✓ ' + t('keys.passkey.registered'));
          if (C.status) C.status.configured.passkey = true;
          if (C.inReset) { C.toCmd(); C.afterResetChange(); return; }
          askName(credId, prefill);
        },
        prefill: function () { return genPkPrefillName(''); },
        errText: function (/** @type {string} */ c, /** @type {number} */ s) { return api.errText(C.errT, c, s); },
        toast: function (/** @type {string} */ m) { if (!stopped) C.err(m); },
        msg: { cancelled: t('common.cancelled'), already: t('keys.passkey.already'), noSupport: t('common.pkNoSupport'), failed: t('keys.passkey.failed'), network: t('common.errNetwork') },
      }).then(function () { if (!done && !stopped && C.mode === 'busy') C.toCmd(); });
    });
  };
  /** 终端里 `为这把通行密钥命名 [默认名]:` @param {string} credId @param {string} cur */
  function askName(credId, cur) {
    C.out(esc(t('keys.passkey.nameAsk')) + ' [' + esc(cur) + ']:');
    C.ask('pkname', function (/** @type {string} */ v) {
      const name = cleanPasskeyName(v);
      if (!name || name === cur || normCmd(v) === 'skip') { C.toCmd(); return; }
      C.setMode('busy');
      api.keys.passkeyRename(credId, name).then(function (/** @type {any} */ res) {
        if (res.j && res.j.ok) { C.ok('✓ ' + t('keys.passkey.renamed')); C.toCmd(); return; }
        if (C.authErr(res)) { C.toCmd(); return; }
        if (C.api.isErr(res, api.ERR.params)) C.err(t('keys.passkey.nameEmpty'));
        else C.apiErr(res);
        C.toCmd();
      }, function () { C.netErr(); C.toCmd(); });
    }, { ps: '>', hint: t('keys.passkey.nameHint') });
  }

  /** passkey rm <n>：编号对着现在的列表（先取一次），[y/N] @param {number} n */
  C.passkeyRm = function (n) {
    guard(function () {
      C.loadKeys(function (ok) {
        if (!ok) return;
        const key = C.keyList[n - 1];
        if (!key) { C.err(t('keys.passkey.noSuch')); C.note('keys.passkey.lsFirst', 'passkey'); return; }
        C.out(esc(tf('keys.passkey.rmAsk', { n: keyName(key) })) + ' [y/N]');
        C.pick({
          y: function () {
            C.echoPick('y');
            C.setMode('busy');
            ops().passkeyDelete(key.credId).then(function (/** @type {any} */ res) {
              if (res.j && res.j.ok) {
                C.out('<span class="sgx-at-ok">✓</span> ' + esc(t('keys.passkey.deleted')));
                C.keyList = [];
                C.toCmd();
                C.afterResetChange();
                return;
              }
              if (C.authErr(res)) { C.toCmd(); return; }
              C.apiErr(res);
              C.toCmd();
            }, function () { C.netErr(); C.toCmd(); });
          },
          n: function () { C.echoPick('n'); C.toCmd(); },
        }, 'n', { ps: '[y/N]' });
      });
    });
  };
}
