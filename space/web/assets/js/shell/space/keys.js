/**
 * @fileoverview 盾牌 → 进站凭证（解锁密码 + 进站通行密钥；代码词 keys，Q14）。进来先 `sudo styrigx reauth`，头部 `reauth · 2:41`。
 *
 * - 解锁密码：`passwd` → new / retype（不回显，≥ 8 位）；删除两步（最后一个进站凭证不能删：403 last-key）
 * - 通行密钥：列表（名字 · 提供方 · 创建 · 上次使用）；`passkey add` 先问名字（回车用设备名，Q9）再调起系统窗口；
 *   点名字改名（终端里）；删除两步
 * - 所有设备回锁屏（Q5，要 reauth；本机也回锁屏）：两步
 * 改进站凭证照旧推纪元：其他设备回锁屏、本机不掉线（服务端，同账号 keys）。写操作走 api.keys.*（reauth 票）。
 */
import { registerPasskey, genPkPrefillName, cleanPasskeyName } from '../../auth/passkey-register.js';
import { normCmd, mmdd, passkeyName } from './commands.js';

/** @param {any} C 盾牌上下文 */
export function mountKeys(C) {
  const t = C.t;
  const tf = C.tf;
  const esc = C.esc;
  const api = C.api;
  /** @type {any[]} */ C.keyList = [];
  C.editing = '';

  /** @param {string} id */
  function provLabel(id) { return id && /^[a-z0-9-]+$/.test(id) ? t('keys.provider.' + id.replace(/-/g, '_')) : ''; }

  C.renderKeys = function () {
    C.subHead(t('keys.title'));
    if (!C.reauthLeft()) { C.viewEl.innerHTML = ''; C.foot('reauth.ft'); return; }
    const has = !!(C.cfg && C.cfg.password);
    let h = '<div class="sgx-pop-list">' + C.grp(t('keys.password.title'));
    h += C.row({ k: t('keys.password.title'), sub: 'passwd', v: has ? t('keys.password.set') : t('keys.password.unset'), act: 'passwd', chev: true });
    if (has) {
      const a = C.armed === 'pw-rm';
      h += C.row({ k: t('keys.password.remove'), vHtml: '<span class="sgx-at-acc">' + esc(a ? t('keys.deleteAsk') : t('keys.delete')) + '</span>', act: 'pw-rm', armed: a });
    }
    h += C.noteP(t('keys.password.note'));
    h += C.grp(t('keys.passkeyTitle'), true);
    if (!C.keyList.length) h += C.noteP(t('keys.none'));
    C.keyList.forEach(function (/** @type {any} */ key) {
      const a = C.armed === 'pk:' + key.credId;
      const nm = passkeyName(key, t);
      const sub = [provLabel(key.provider), tf('keys.created', { d: mmdd(key.createdAt) }), key.lastUsedAt ? tf('keys.lastUsed', { d: mmdd(key.lastUsedAt) }) : t('keys.neverUsed')].filter(Boolean).join(' · ');
      const kHtml = '<button type="button" class="sgx-at-nm" data-sh-act="rename:' + esc(key.credId) + '" translate="no" data-sgx-personal>' + esc(nm) + '</button>';
      h += C.row({ k: nm, kHtml: kHtml, sub: sub, vHtml: '<button type="button" class="sgx-at-acc sgx-at-del" data-sh-act="pk:' + esc(key.credId) + '">' + esc(a ? t('keys.deleteAsk') : t('keys.delete')) + '</button>', armed: a });
    });
    h += C.row({ k: t('keys.add'), v: 'passkey add', act: 'passkey-add', cls: 'sgx-pop-row--acc' });
    h += '</div><div class="sgx-pop-list sgx-pop-list--line">';
    const aa = C.armed === 'lock-all';
    h += C.row({ k: t('keys.lockAll'), sub: t('keys.lockAllSub'), v: aa ? t('keys.lockAllAsk') : 'lock --all', act: 'lock-all', cls: 'sgx-pop-row--acc', armed: aa });
    h += '</div>';
    C.viewEl.innerHTML = h;
    C.foot('keys.ft');
  };
  C.enterKeys = function () { C.loadKeys(); C.startTick(); };
  C.loadKeys = function () {
    return api.keys.passkeyList().then(function (/** @type {any} */ res) {
      if (res.j && res.j.ok) {
        C.keyList = res.j.keys || [];
        if (C.cfg) C.cfg.passkey = C.keyList.length > 0;
        if (C.layer === 'keys') C.render();
        return;
      }
      if (!C.authErr(res)) C.err(api.errText(t, res.j && res.j.error, res.s));
    }, function () { C.err(t('common.errNetwork')); });
  };

  /** passwd：new / retype（不回显） @param {boolean} [typed] 命令是敲进来的（已回显） */
  C.cmdPasswd = function (typed) {
    if (!typed) C.echo('passwd');
    const pm = { pm: api.PM_USER.password, hint: t('common.hidden') };
    C.ask('newpw', function (/** @type {string} */ v1) {
      if (v1.length < 8) { C.err(t('keys.password.short')); C.toCmd(); return; }
      C.ask('newpw2', function (/** @type {string} */ v2) {
        if (v2 !== v1) { C.err(t('keys.password.mismatch')); C.toCmd(); return; }
        C.setMode('busy');
        api.keys.passwordSet(v2).then(function (/** @type {any} */ res) {
          if (res.j && res.j.ok) {
            C.ok(t('keys.password.updated'));
            C.note(t('keys.othersLocked'));
            if (C.cfg) C.cfg.password = true;
            C.toCmd();
            C.render();
            return;
          }
          if (C.authErr(res)) { C.toCmd(); return; }
          C.err(api.errText(t, res.j && res.j.error, res.s));
          C.toCmd();
        }, function () { C.err(t('common.errNetwork')); C.toCmd(); });
      }, Object.assign({ ps: t('keys.password.retype') }, pm));
    }, Object.assign({ ps: t('keys.password.new') }, pm));
  };

  /** passkey add：先问名字（Q9）→ 系统窗口 → 注册 @param {boolean} [typed] */
  C.cmdPasskeyAdd = function (typed) {
    if (!typed) C.echo('passkey add');
    if (!(/** @type {any} */ (window)).PublicKeyCredential) { C.err(t('common.pkNoSupport')); return; }
    const dflt = genPkPrefillName('');
    C.out(esc(t('keys.nameAsk')) + (dflt ? ' [' + esc(dflt) + ']' : '') + ':');
    C.ask('pkname', function (/** @type {string} */ v) {
      const name = cleanPasskeyName(v) || dflt;
      C.setMode('busy');
      C.out('› ' + esc(t('session.passkeyWait')), 'd');
      const toRes = function (/** @type {any} */ r) { return { status: r.s, json: r.j }; };
      let done = false;
      registerPasskey({
        challenge: function () { return api.keys.passkeyAddChallenge().then(toRes); },
        register: function (/** @type {any} */ body) { return api.keys.passkeyAdd(body).then(toRes); },
        onAuthError: function (/** @type {any} */ res) { return C.authErr({ s: res.status, j: res.json }); },
        onRegistered: function () { done = true; C.ok('✓ ' + t('keys.registered')); if (C.cfg) C.cfg.passkey = true; C.toCmd(); C.loadKeys(); },
        prefill: function () { return name; },
        errText: function (/** @type {string} */ c, /** @type {number} */ s) { return api.errText(t, c, s); },
        toast: function (/** @type {string} */ m) { C.err(m); },
        msg: { cancelled: t('common.cancelled'), already: t('keys.already'), noSupport: t('common.pkNoSupport'), failed: t('keys.failed'), network: t('common.errNetwork') },
      }).then(function () { if (!done && C.mode === 'busy') C.toCmd(); });
    }, { ps: '>', hint: t('keys.nameHint') });
  };
  /** 改名：终端里 `为这把通行密钥命名 [现名]:`，输入行先填现名 @param {any} key */
  function askRename(key) {
    const cur = passkeyName(key, t);
    C.out(esc(t('keys.renameAsk')) + ' [' + esc(cur) + ']:');
    C.ask('pkname', function (/** @type {string} */ v) {
      const name = cleanPasskeyName(v);
      if (!name || name === cur || normCmd(v) === 'skip') { C.toCmd(); return; }
      C.setMode('busy');
      api.keys.passkeyRename(key.credId, name).then(function (/** @type {any} */ res) {
        if (res.j && res.j.ok) { C.ok('✓ ' + t('keys.renamed')); C.toCmd(); C.loadKeys(); return; }
        if (C.authErr(res)) { C.toCmd(); return; }
        C.err(api.errText(t, res.j && res.j.error, res.s));
        C.toCmd();
      }, function () { C.err(t('common.errNetwork')); C.toCmd(); });
    }, { ps: '>', hint: t('keys.nameHint') });
    C.input.value = cur;
  }
  /** 两步：第一下 armed，第二下做 @param {string} a @returns {boolean} 已 armed（该做了） */
  function arm(a) {
    if (C.armed !== a) { C.armed = a; C.render(); return false; }
    C.armed = '';
    return true;
  }
  /** @param {string} id */
  function delKey(id) {
    if (!arm('pk:' + id)) return;
    api.keys.passkeyDelete(id).then(function (/** @type {any} */ res) {
      if (res.j && res.j.ok) {
        C.ok('✓ ' + t('keys.deleted'));
        C.note(t('keys.othersLocked'));
        C.keyList = C.keyList.filter(function (/** @type {any} */ x) { return x.credId !== id; });
        if (!C.keyList.length && C.cfg) C.cfg.passkey = false;
        C.render();
        return;
      }
      if (C.authErr(res)) return;
      C.err(api.isErr(res, api.ERR.lastKey) ? t('keys.lastKey') : api.errText(t, res.j && res.j.error, res.s));
      C.render();
    }, function () { C.err(t('common.errNetwork')); });
  }
  function removePassword() {
    if (!arm('pw-rm')) return;
    api.keys.passwordRemove().then(function (/** @type {any} */ res) {
      if (res.j && res.j.ok) { C.ok('✓ ' + t('keys.password.removed')); C.note(t('keys.othersLocked')); if (C.cfg) C.cfg.password = false; C.render(); return; }
      if (C.authErr(res)) return;
      C.err(api.isErr(res, api.ERR.lastKey) ? t('keys.lastKey') : api.errText(t, res.j && res.j.error, res.s));
      C.render();
    }, function () { C.err(t('common.errNetwork')); });
  }
  /** 所有设备回锁屏（本机也回） */
  function lockAll() {
    if (!arm('lock-all')) return;
    C.echo('lock --all');
    C.setMode('busy');
    api.session.endAll().then(function (/** @type {any} */ res) {
      if (res.j && res.j.ok) { C.o.ms.close(function () { C.o.replace('/?entry=1'); }); return; }
      C.toCmd();
      if (C.authErr(res)) return;
      C.err(api.errText(t, res.j && res.j.error, res.s));
      C.render();
    }, function () { C.err(t('common.errNetwork')); C.toCmd(); });
  }

  /** @param {string} a @returns {boolean} */
  C.actKeys = function (a) {
    if (C.layer !== 'keys') return false;
    if (a === 'passwd') { C.cmdPasswd(); return true; }
    if (a === 'passkey-add') { C.cmdPasskeyAdd(); return true; }
    if (a === 'pw-rm') { removePassword(); return true; }
    if (a === 'lock-all') { lockAll(); return true; }
    if (a.indexOf('rename:') === 0) {
      const key = C.keyList.find(function (/** @type {any} */ x) { return x.credId === a.slice(7); });
      if (key) askRename(key);
      return true;
    }
    if (a.indexOf('pk:') === 0) { delKey(a.slice(3)); return true; }
    return false;
  };
}
