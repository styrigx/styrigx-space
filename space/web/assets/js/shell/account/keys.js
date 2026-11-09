/**
 * @fileoverview 账号安全（管理账号钥匙：account password、account passkey）。进来先 `sudo root reauth`（S1），顶部 `reauth · 02:41`（S2）。
 *
 * - 账号密码：`passwd` → New / Retype（不回显、可粘贴，最短 8 位，S4）
 * - 账号通行密钥：列表（名字、保存在哪、创建日期、上次使用，S6）；`passkey add` → 系统窗口 → 终端里命名（默认设备名，可 skip，S7）；
 *   点名字改名（S8，reset 里不能改名）；删除两步（data-armed），提示去 Samsung Pass 手动删（S9）
 * sudo root reset 里用同一套行（reset.js 的 renderReset 调 keyRows(false)），写操作走 api.reset.*，改完触发三选一。
 * 只管账号钥匙；锁屏钥匙、临时钥匙在盾牌（S12）。
 */
import { registerPasskey, genPkPrefillName, cleanPasskeyName } from '../../auth/passkey-register.js';
import { CMD, normCmd } from './commands.js';
import { signalPasskeyName } from './passkey-signal.js';

/** MM-DD @param {number} ts */
export function mmdd(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = function (/** @type {number} */ n) { return (n < 10 ? '0' : '') + n; };
  return p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** @param {any} C */
export function mountKeys(C) {
  const t = C.t;
  const tf = C.tf;
  const esc = C.esc;
  const api = C.api;
  /** 通行密钥列表 @type {any[]} */
  C.keyList = [];
  /** 写操作：reset 里走 reset 票，账号安全走 reauth 票 */
  const ops = function () { return C.inReset ? api.reset : api.keys; };
  /** 没有能用的票（reset 里看 reset 票，账号安全看 reauth 票） */
  const needReauth = function () { return !C.inReset && !C.reauthLeft(); };

  /** @param {string} id */
  function provLabel(id) { return id && /^[a-z0-9-]+$/.test(id) ? t('keys.passkey.provider.' + id.replace(/-/g, '_')) : ''; }
  /** @param {any} key */
  function keyName(key) { return key.name || provLabel(key.provider) || t('keys.passkey.unnamed'); }

  /** 通行密钥那几行 + 「添加」 @param {boolean} canRename */
  C.keyRows = function (canRename) {
    let h = '';
    if (!C.keyList.length) h += C.noteP(t('keys.passkey.none'));
    C.keyList.forEach(function (/** @type {any} */ key) {
      const a = C.armed === 'pk:' + key.credId;
      const nm = keyName(key);
      const sub = [provLabel(key.provider), tf('keys.passkey.created', { d: mmdd(key.createdAt) }), key.lastUsedAt ? tf('keys.passkey.lastUsed', { d: mmdd(key.lastUsedAt) }) : t('keys.passkey.neverUsed')].filter(Boolean).join(' · ');
      const kHtml = canRename
        ? '<button type="button" class="sgx-at-nm" data-at-act="rename:' + esc(key.credId) + '" translate="no" data-sgx-personal>' + esc(nm) + '</button>'
        : '<span translate="no" data-sgx-personal>' + esc(nm) + '</span>';
      h += C.row({ k: nm, kHtml: kHtml, sub: sub, vHtml: '<button type="button" class="sgx-at-acc sgx-at-del" data-at-act="pk:' + esc(key.credId) + '">' + esc(a ? t('keys.passkey.deleteAsk') : t('keys.passkey.delete')) + '</button>', armed: a });
    });
    h += C.row({ k: t('keys.passkey.add'), v: 'passkey add', act: 'passkey-add', cls: 'sgx-pop-row--acc' });
    return h;
  };

  C.renderKeys = function () {
    if (!C.reauthLeft()) {
      C.subHead(t('keys.title'), 'locked');
      C.viewEl.innerHTML = '';
      C.foot('reauth.ft');
      return;
    }
    C.subHead(t('keys.title'), 'reauth · ' + C.mmss(C.reauthLeft()), true);
    const has = !!(C.status && C.status.configured.password);
    C.viewEl.innerHTML = '<div class="sgx-pop-list">' + C.grp(t('keys.password.title')) +
      C.row({ k: 'account password', v: has ? t('keys.password.set') : t('keys.password.unset'), act: 'passwd', chev: true }) + C.noteP(t('keys.password.note')) +
      C.grp(t('keys.passkey.title'), true) + C.keyRows(true) + '</div>';
    C.foot('keys.ft');
  };
  /** 进账号安全：reauth 有效期内直接列，没有就在终端里 sudo root reauth */
  C.enterKeys = function () {
    if (C.reauthLeft()) { C.loadKeys(); C.startTick(); return; }
    C.echo(CMD.reauth);
    C.cmdReauth(function () { C.loadKeys(); });
  };
  C.loadKeys = function () {
    return ops().passkeyList().then(function (/** @type {any} */ res) {
      if (res.j && res.j.ok) {
        C.keyList = res.j.keys || [];
        signalPasskeyName(res.j);
        C.render();
        return;
      }
      C.authErr(res);
    }, function () { C.netErr(); });
  };

  /** passwd：New / Retype（不回显）@param {boolean} [typed] 命令是敲进来的（已回显） */
  C.cmdPasswd = function (typed) {
    if (needReauth()) { C.withReauth(function () { C.layer = 'keys'; C.render(); C.cmdPasswd(); }, t('reauth.lead.keys')); return; }
    if (!typed) C.echo('passwd');
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
            C.render();
            C.afterResetChange();
            return;
          }
          if (C.authErr(res)) { C.toCmd(); return; }
          C.apiErr(res);
          C.toCmd();
        }, function () { C.netErr(); C.toCmd(); });
      }, Object.assign({ ps: t('keys.password.retype') }, pm));
    }, Object.assign({ ps: t('keys.password.new') }, pm));
  };

  /** passkey add：系统窗口 → 注册 → 命名（reset 里不命名，Q1）@param {boolean} [typed] */
  C.cmdPasskeyAdd = function (typed) {
    if (needReauth()) { C.withReauth(function () { C.layer = 'keys'; C.render(); C.cmdPasskeyAdd(); }, t('reauth.lead.keys')); return; }
    if (!typed) C.echo('passkey add');
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
        /* ^C 时注册请求已经发出去了：钥匙已存上，只刷新列表，不再接着问名字 */
        if (stopped) { C.loadKeys(); return; }
        C.ok('✓ ' + t('keys.passkey.registered'));
        if (C.status) C.status.configured.passkey = true;
        C.loadKeys();
        if (C.inReset) { C.toCmd(); C.afterResetChange(); return; }
        askName(credId, prefill, false);
      },
      prefill: function () { return genPkPrefillName(''); },
      errText: function (/** @type {string} */ c, /** @type {number} */ s) { return api.errText(C.errT, c, s); },
      toast: function (/** @type {string} */ m) { if (!stopped) C.err(m); },
      msg: { cancelled: t('common.cancelled'), already: t('keys.passkey.already'), noSupport: t('common.pkNoSupport'), failed: t('keys.passkey.failed'), network: t('common.errNetwork') },
    }).then(function () { if (!done && !stopped && C.mode === 'busy') C.toCmd(); });
  };
  /** 终端里 `为这把通行密钥命名 [现名]:` @param {string} credId @param {string} cur @param {boolean} fill 输入行先填上现名 */
  function askName(credId, cur, fill) {
    C.out(esc(t('keys.passkey.nameAsk')) + ' [' + esc(cur) + ']:');
    C.ask('pkname', function (/** @type {string} */ v) {
      const name = cleanPasskeyName(v);
      if (!name || name === cur || normCmd(v) === 'skip') { C.toCmd(); return; }
      rename(credId, name);
    }, { ps: '>', hint: t('keys.passkey.nameHint') });
    if (fill) C.input.value = cur;
  }
  /** @param {string} credId @param {string} name */
  function rename(credId, name) {
    C.setMode('busy');
    api.keys.passkeyRename(credId, name).then(function (/** @type {any} */ res) {
      if (res.j && res.j.ok) { C.ok('✓ ' + t('keys.passkey.renamed')); C.toCmd(); C.loadKeys(); return; }
      if (C.authErr(res)) { C.toCmd(); return; }
      if (C.api.isErr(res, api.ERR.params)) C.err(t('keys.passkey.nameEmpty'));
      else C.apiErr(res);
      C.toCmd();
    }, function () { C.netErr(); C.toCmd(); });
  }
  /** @param {string} id 两步删除 */
  function del(id) {
    const a = 'pk:' + id;
    if (C.armed !== a) { C.armed = a; C.render(); return; }
    C.armed = '';
    if (needReauth()) { C.render(); return; }
    ops().passkeyDelete(id).then(function (/** @type {any} */ res) {
      if (res.j && res.j.ok) {
        C.out('<span class="sgx-at-ok">✓</span> ' + esc(t('keys.passkey.deleted')));
        C.keyList = C.keyList.filter(function (/** @type {any} */ x) { return x.credId !== id; });
        if (!C.keyList.length && C.status) C.status.configured.passkey = false;
        C.render();
        C.afterResetChange();
        return;
      }
      if (C.authErr(res)) return;
      C.apiErr(res);
      C.render();
    }, function () { C.netErr(); });
  }

  /** @param {string} a @returns {boolean} */
  C.actKeys = function (a) {
    if (a === 'passwd') { C.cmdPasswd(); return true; }
    if (a === 'passkey-add') { C.cmdPasskeyAdd(); return true; }
    if (a.indexOf('rename:') === 0) {
      if (C.inReset) return true;
      const key = C.keyList.find(function (/** @type {any} */ x) { return x.credId === a.slice(7); });
      if (key) askName(key.credId, keyName(key), true);
      return true;
    }
    if (a.indexOf('pk:') === 0) { del(a.slice(3)); return true; }
    return false;
  };
}
