/**
 * @fileoverview `sudo root`：登录会话（未登录提示符 login@account:~$）+ `exit` 退出登录（O17）。
 *
 * 只收 [1] passkey（account passkey）[2] password（account password），不收恢复密钥（三钥匙三入口，Gray 17:42）。
 * 只列已设置的（同锁屏 L8：读不到状态两个都列）；一种都没设 → 提示 sudo root reset（A12 / A13）。
 * 输错 `Sorry, try again.`，3 次结束这一轮（O19）；服务端冷却 → `sudo: too many attempts · try again in 15 min`。
 * 选方式 → 验证这一段（verify）也给 reauth.js 用。
 */
import { set as sset } from '../../lib/storage.js';
import { fetchProfile } from '../../lib/profile.js';
import { CMD, PS_PASSWORD, MAX_TRIES, TRIES_OVER, TRY_AGAIN } from './commands.js';

/** 云同步的「登录了账号」标记（= lib/cloud-sync.js AUTH_KEY）和上次拉取时刻 */
const SYNC_AUTH_KEY = 'sgx-sync-auth';
const SYNC_PULL_KEY = 'sgx-sync-pull';

/**
 * 可用的验证方式（固定顺序：通行密钥、密码）。读不到状态 → 两个都给。
 * @param {any} status api.status() 的结果
 * @returns {string[]}
 */
export function verifyKinds(status) {
  if (!status) return ['passkey', 'password'];
  const ks = [];
  if (status.configured.passkey) ks.push('passkey');
  if (status.configured.password) ks.push('password');
  return ks;
}

/** @param {any} C */
export function mountSession(C) {
  const t = C.t;
  const api = C.api;
  const esc = C.esc;

  C.renderGuest = function () {
    C.barHead(C.consent ? C.consent.app : 'login');
    C.viewEl.innerHTML = '';
    C.foot(C.consent ? '' : 'session.ft');
  };

  /**
   * 选方式 → 验证。
   * v.reauth：这是 sudo root reauth（已登录，再验证）；否则是 sudo root 登录（v.withReauth：登录时顺手拿 reauth 票，授权同意用）。
   * @param {{reauth?: boolean, withReauth?: boolean, lead: string, done: () => void}} v
   */
  C.verify = function (v) {
    C.tries = 0;
    C.out(esc(v.lead));
    if (C.status && C.status.signing === false) { C.err(t('session.noSigning')); C.toCmd(); return; }
    const ks = verifyKinds(C.status);
    if (!ks.length) { C.note('session.noMethod', CMD.reset); C.toCmd(); return; }
    const list = /** @type {Array<[string, string, boolean?]>} */ ([]);
    /** @type {Record<string, () => void>} */ const p = {};
    ks.forEach(function (kk, i) {
      const key = String(i + 1);
      list.push([key, kk]);
      p[key] = function () { C.echoPick(key); if (kk === 'passkey') viaPasskey(v); else askPw(v); };
      p[kk] = p[key];
    });
    C.opts(list);
    C.note('session.keyMap');
    C.note(v.reauth ? 'reauth.cantVerify' : 'session.cantSignIn', CMD.reset);
    C.pick(p);
  };
  /** @param {{reauth?: boolean, withReauth?: boolean, done: () => void}} v */
  function askPw(v) {
    C.ask('pw', function (/** @type {string} */ val) {
      C.setMode('busy');
      const call = v.reauth ? api.reauth.password(val) : api.session.password(val, v.withReauth);
      call.then(function (/** @type {any} */ res) {
        if (res.j && res.j.ok) { verified(v, 'password'); return; }
        if (res.s === 429 || api.isErr(res, api.ERR.cooldown)) { C.err(t('common.tooMany')); C.toCmd(); return; }
        if (api.isErr(res, api.ERR.wrong)) {
          C.tries++;
          if (C.tries >= MAX_TRIES) { C.err(TRIES_OVER); C.toCmd(); return; }
          C.err(TRY_AGAIN);
          askPw(v);
          return;
        }
        if (C.authErr(res)) { C.toCmd(); return; }
        C.apiErr(res);
        C.toCmd();
      }, function () { C.netErr(); C.toCmd(); });
    }, { ps: PS_PASSWORD, pm: api.PM_USER.password, hint: t('common.hidden') });
  }
  /** @param {{reauth?: boolean, withReauth?: boolean, done: () => void}} v */
  function viaPasskey(v) {
    if (!(/** @type {any} */ (window)).PublicKeyCredential) { C.err(t('common.pkNoSupport')); C.toCmd(); return; }
    C.setMode('busy');
    C.out(esc(t('session.passkeyWait')), 'd');
    const call = v.reauth ? api.reauth.passkey(C.errT) : api.session.passkey(C.errT, v.withReauth);
    call.then(function () { verified(v, 'passkey'); }, function (/** @type {any} */ e) {
      C.out(esc(e && e.cancelled ? t('common.cancelled') : (e && e.message) || t('common.errVerify')), e && e.cancelled ? 'd' : 'er');
      C.toCmd();
    });
  }
  /** @param {{reauth?: boolean, done: () => void}} v @param {string} by */
  function verified(v, by) {
    const was = C.st;
    C.loadStatus().then(function () {
      if (v.reauth && was === 'in') {
        C.ok('✓ verified', t('reauth.ok'));
      } else {
        C.out('<span class="sgx-at-ok">✓</span> ' + esc(C.tf('session.signedInAs', { n: C.who().name || 'Sloan Gray', by: by === 'passkey' ? t('session.byPasskey') : t('session.byPassword') })));
        afterLogin();
      }
      C.toCmd();
      if (C.reauthLeft()) C.startTick();
      v.done();
    });
  }
  function afterLogin() {
    C.loginChanged = true;
    /* 云同步（lib/cloud-sync.js，主站 core 每页跑）：清掉「没登录账号」标记和上次拉取时刻，关下拉重新载入后立刻拉一次（同原账号页登录后 force 同步）。
       这里不 import cloud-sync：奇趣 / 日刻也挂这个终端，不把主站同步模块带进子站包 */
    try { sset(SYNC_AUTH_KEY, 'in'); localStorage.removeItem(SYNC_PULL_KEY); } catch (e) {}
    try { fetchProfile(); } catch (e) {}
    C.grants = null;
    C.devices = null;
    C.loadGrants();
  }

  C.cmdSession = function () {
    if (C.st === 'in') { C.out(esc(t('session.already')).replace('{x}', C.k(CMD.reauth)), 'warn'); return; }
    C.verify({ withReauth: !!C.consent, lead: t('session.lead'), done: function () { if (C.consent) return C.askConsent(); C.layer = 'home'; C.render(); } });
  };

  C.cmdExit = function () {
    if (C.st !== 'in') { C.o.ms.close(); return; }
    C.setMode('busy');
    api.session.end().then(function (/** @type {any} */ res) {
      if (!(res.s >= 200 && res.s < 300)) throw new Error('http');
      try { localStorage.removeItem(SYNC_PULL_KEY); } catch (e) {}
      C.reauthExp = 0;
      C.grants = null;
      C.devices = null;
      C.setSt('guest');
      C.layer = 'home';
      C.toCmd();
      C.o.ms.close(function () { C.reload(); });
    }).catch(function () { C.err(t('common.signOutFail')); C.toCmd(); });
  };
}
