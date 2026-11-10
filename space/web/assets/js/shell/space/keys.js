/**
 * @fileoverview 解锁凭据（进站凭证：解锁密码 + 进站通行密钥）的终端命令（v5 S5：原盾牌「进站凭证」层搬进终端，命令挂在 lock 下面，和账号的 passwd / passkey 分开）。
 *
 * - lock passwd：new / retype（不回显，≥ 8 位）
 * - lock passkey：列表（编号 · 名字 · 提供方 · 创建 · 上次使用）· lock passkey add：先问名字（回车 = 设备名，Q9）再调起系统窗口 · lock passkey rm <n>：[y/N]
 * - lock --all：所有设备回访客（本机也是；[y/N]）
 * 都要 reauth（终端里原地验证）。改进站凭证照旧推纪元：其他设备掉回访客、本机不掉线（服务端）。写操作走 api.keys.*（reauth 票）。
 */
import { registerPasskey, genPkPrefillName, cleanPasskeyName } from '../../auth/passkey-register.js';
import { mmdd, passkeyName } from './commands.js';

/** @param {any} C 钥匙层上下文（shell/space/layer.js） */
export function mountKeys(C) {
  const t = C.t;
  const tf = C.tf;
  const esc = C.esc;
  const api = C.api;
  /** 最近一次列出的通行密钥（rm <n> 的编号对着它） @type {any[]} */
  let keyList = [];

  /** @param {string} id */
  function provLabel(id) { return id && /^[a-z0-9-]+$/.test(id) ? t('keys.provider.' + id.replace(/-/g, '_')) : ''; }
  /** 服务端回答不好：认得的码（没会话 / 票过期 / 链接会话）交给 authErr，其余红字 @param {any} res */
  function fail(res) {
    if (C.authErr(res)) return;
    C.err(api.isErr(res, api.ERR.lastKey) ? t('keys.lastKey') : api.errText(t, res.j && res.j.error, res.s));
  }
  const netErr = function () { C.err(t('common.errNetwork')); C.toCmd(); };

  /** lock passwd */
  C.cmdPasswd = function () {
    C.withReauth(function () {
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
              return;
            }
            fail(res);
            C.toCmd();
          }, netErr);
        }, Object.assign({ ps: t('keys.password.retype') }, pm));
      }, Object.assign({ ps: t('keys.password.new') }, pm));
    }, t('reauth.lead.keys'));
  };

  /** 取列表（不打印） @param {(ok: boolean) => void} then */
  function load(then) {
    C.setMode('busy');
    api.keys.passkeyList().then(function (/** @type {any} */ res) {
      C.toCmd();
      if (res.j && res.j.ok) {
        keyList = res.j.keys || [];
        if (C.cfg) C.cfg.passkey = keyList.length > 0;
        then(true);
        return;
      }
      fail(res);
      then(false);
    }, function () { netErr(); then(false); });
  }
  /** lock passkey：列出 */
  C.passkeyList = function () {
    C.withReauth(function () {
      load(function (ok) {
        if (!ok) return;
        if (!keyList.length) { C.note(t('keys.none')); return; }
        keyList.forEach(function (/** @type {any} */ key, /** @type {number} */ i) {
          const sub = [provLabel(key.provider), tf('keys.created', { d: mmdd(key.createdAt) }), key.lastUsedAt ? tf('keys.lastUsed', { d: mmdd(key.lastUsedAt) }) : t('keys.neverUsed')].filter(Boolean).join(' · ');
          C.out('<span class="sgx-at-p">[' + (i + 1) + ']</span> <span translate="no" data-sgx-personal>' + esc(passkeyName(key, t)) + '</span> <span class="sgx-at-dim">· ' + esc(sub) + '</span>');
        });
      });
    }, t('reauth.lead.keys'));
  };

  /** lock passkey add：先问名字（Q9）→ 系统窗口 → 注册 */
  C.passkeyAdd = function () {
    if (!(/** @type {any} */ (window)).PublicKeyCredential) { C.err(t('common.pkNoSupport')); return; }
    C.withReauth(function () {
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
          onRegistered: function () { done = true; C.ok('✓ ' + t('keys.registered')); if (C.cfg) C.cfg.passkey = true; keyList = []; C.toCmd(); },
          prefill: function () { return name; },
          errText: function (/** @type {string} */ c, /** @type {number} */ s) { return api.errText(t, c, s); },
          toast: function (/** @type {string} */ m) { C.err(m); },
          msg: { cancelled: t('common.cancelled'), already: t('keys.already'), noSupport: t('common.pkNoSupport'), failed: t('keys.failed'), network: t('common.errNetwork') },
        }).then(function () { if (!done && C.mode === 'busy') C.toCmd(); });
      }, { ps: '>', hint: t('keys.nameHint') });
    }, t('reauth.lead.keys'));
  };

  /** [y/N]（回车 = N） @param {string} ask @param {() => void} yes */
  function yn(ask, yes) {
    C.out(esc(ask) + ' [y/N]');
    C.pick({
      y: function () { C.echoPick('y'); yes(); },
      n: function () { C.echoPick('n'); C.toCmd(); },
    }, 'n', { ps: '[y/N]' });
  }

  /** lock passkey rm <n>：编号对着现在的列表（先取一次），[y/N] @param {number} n */
  C.passkeyRm = function (n) {
    C.withReauth(function () {
      load(function (ok) {
        if (!ok) return;
        const key = keyList[n - 1];
        if (!key) { C.err(t('keys.noSuch')); C.note(t('keys.lsFirst'), 'lock passkey'); return; }
        yn(tf('keys.rmAsk', { n: passkeyName(key, t) }), function () {
          C.setMode('busy');
          api.keys.passkeyDelete(key.credId).then(function (/** @type {any} */ res) {
            if (res.j && res.j.ok) {
              C.ok('✓ ' + t('keys.deleted'));
              C.note(t('keys.othersLocked'));
              keyList = [];
              C.toCmd();
              return;
            }
            fail(res);
            C.toCmd();
          }, netErr);
        });
      });
    }, t('reauth.lead.keys'));
  };

  /** lock --all：所有设备回访客（本机也是）→ 页面重新取一次 */
  C.lockAll = function () {
    C.withReauth(function () {
      yn(t('keys.lockAllAsk'), function () {
        C.setMode('busy');
        api.session.endAll().then(function (/** @type {any} */ res) {
          if (res.j && res.j.ok) { C.ok('✓ ' + t('keys.lockAllDone')); C.relocked(); return; }
          fail(res);
          C.toCmd();
        }, netErr);
      });
    }, t('reauth.lead.keys'));
  };
}
