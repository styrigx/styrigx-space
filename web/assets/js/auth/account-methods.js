/**
 * @fileoverview 账号凭证验证行（账号页登录 + 账号 → 安全与隐私的门共用）。
 *
 * 两个入口：账号通行密钥 / 账号密码，设了哪个显示哪个（visibleKinds）。
 * - 通行密钥：POST /api/account challenge + login-passkey
 * - 账号密码：login-password
 * reauth:true 时服务端在账号会话之外另签 3 分钟 AccountReauthTicket（账号安全子页用）。
 * 三个提交都带 device（lib/device-hints.js：型号 / 平台），服务端记进设置 › 账号 › 设备。
 * root(value)：重置登录（账号）第一步，POST /api/account { action:'root-reset', key }（账号根密钥，不是登录入口）→ AccountResetTicket。
 *
 * 行的渲染在 auth/cred-rows.js（锁屏弹层的重置登录也用它）。
 * 放在 lib/：账号页（apps/account*.js）和锁屏凭证页（apps/security-lock.js）都 import 它。
 */
import { getPasskeyAssertion, assertionOptions, assertionToJSON, isPasskeyCancel } from './passkey-assert.js';
import { renderCredRows, CRED_ICONS } from './cred-rows.js';
import { KEY_ACCOUNT } from '../lib/key-names.js';
import { ACCOUNT_API, postJSON, errText as errTextT } from './account-api.js';
import { deviceHints } from '../lib/device-hints.js';

/**
 * 要显示的入口（固定顺序：通行密钥、密码）。PR3：根凭证不再是登录入口（改走「无法登录？」→ 重置登录）。
 * 设了哪个显示哪个；读不到状态（访客 / 网络失败）时两个都显示，界面与管理员一致，服务端一律拒绝。
 * 都没设 → 空数组（页面只留「无法登录？」）。
 * @param {{password?:boolean, passkey?:boolean}|null} status GET /api/account 的结果；null = 读不到
 * @returns {string[]}
 */
export function visibleKinds(status) {
  if (!status) return ['passkey', 'password'];
  const out = [];
  if (status.passkey) out.push('passkey');
  if (status.password) out.push('password');
  return out;
}

/**
 * 三个入口的提交函数。成功 resolve；失败 reject { message, clear?, cancelled? }。
 * @param {function(string): string} t
 * @param {{reauth?: boolean}} [opts]
 */
export function accountSubmitters(t, opts) {
  const reauth = !!(opts && opts.reauth);
  /** @param {string} [code] @param {number} [status] */
  function errText(code, status) {
    return errTextT(t, code, status);
  }
  /** @param {string} value */
  function password(value) {
    const body = { action: 'login-password', password: value };
    if (reauth) body.reauth = true;
    const dev = deviceHints();
    if (dev) body.device = dev;
    return postJSON(ACCOUNT_API, body).then(function (res) {
      if (res.j && res.j.ok) return;
      throw { message: errText(res.j && res.j.error, res.s), clear: true };
    }, function () {
      throw { message: t('errNetwork') };
    });
  }
  /** 重置登录（账号）第一步：账号根密钥 → AccountResetTicket（3 分钟；不签账号会话，设好新凭证后正常登录；账号拆分 PR3 起在账号 Worker） @param {string} value */
  function root(value) {
    const body = { action: 'root-reset', key: value };
    return postJSON(ACCOUNT_API, body).then(function (res) {
      if (res.j && res.j.ok) return;
      if (res.s === 429) throw { message: t('errLocked') };
      if (res.j && res.j.error === 'config') throw { message: t('errConfig') };
      /* 401（含访客假入口）：统一提示根凭证不正确 */
      throw { message: t('errWrongRoot'), clear: true };
    }, function () {
      throw { message: t('errNetwork') };
    });
  }
  function passkey() {
    if (!window.PublicKeyCredential) return Promise.reject({ message: t('pkNoSupport') });
    return postJSON(ACCOUNT_API, { action: 'login-challenge' }).then(function (res) {
      const j = res.j;
      if (!j || !j.ok || !j.challenge) throw { message: errText(j && j.error, res.s) };
      /* 系统通行密钥窗口（Samsung Pass 等）弹出时，背后的验证弹层先藏起来，结束后恢复——和锁屏一样（2026-10-24）；
         隐藏 / 恢复、30 秒超时都在 getPasskeyAssertion 里 */
      const hideEl = /** @type {HTMLElement|null} */ (document.querySelector('dialog.sgx-verify-dlg[open]'));
      return getPasskeyAssertion(assertionOptions(j), { hideEl: hideEl || undefined }).then(function (cred) {
        return { cred: /** @type {any} */ (cred), cid: j.cid };
      }, function (e) {
        if (isPasskeyCancel(e)) throw { cancelled: true };
        throw { message: t('errVerify') };
      });
    }, function () {
      throw { message: t('errNetwork') };
    }).then(function (r) {
      const cred = r.cred;
      const body = {
        action: 'login-passkey',
        cid: r.cid,
        credential: assertionToJSON(cred),
      };
      if (reauth) body.reauth = true;
      const dev = deviceHints();
      if (dev) body.device = dev;
      return postJSON(ACCOUNT_API, body).then(function (res) {
        if (res.j && res.j.ok) return;
        throw { message: errText(res.j && res.j.error, res.s) };
      }, function () {
        throw { message: t('errNetwork') };
      });
    });
  }
  return { passkey: passkey, password: password, root: root };
}

/**
 * 在容器里渲染账号凭证验证行（auth/cred-rows.js renderCredRows 的账号版）。
 * @param {object} o
 * @param {HTMLElement} o.el
 * @param {function(string): string} o.t
 * @param {boolean} o.en
 * @param {string[]} o.kinds visibleKinds() 的结果
 * @param {{passkey:Function, password:Function, root?:Function}} o.submit accountSubmitters() 的结果（锁屏凭证的门另给 root）
 * @param {Function} o.onSuccess
 * @param {string} [o.pmUser] 密码行的隐藏用户名（默认 AccountKey；锁屏凭证的门传 LockKey）
 * @returns {{collapse: Function}}
 */
export function renderAccountMethods(o) {
  const t = o.t;
  const defs = {
    passkey: { kind: 'passkey', field: 'webauthn', icon: CRED_ICONS.passkey, title: t('mPasskey'), sub: t('mPasskeySub'), submit: o.submit.passkey },
    password: { kind: 'password', field: 'password', icon: CRED_ICONS.password, title: t('mPassword'), sub: t('mPasswordSub'), submit: o.submit.password, pmUser: o.pmUser || KEY_ACCOUNT },
    /* 只给锁屏凭证的门用（security-lock.js 的 kinds 带 root、submit 带 root）；账号页不再有根凭证行 */
    root: o.submit.root ? { kind: 'root', field: 'root', icon: CRED_ICONS.root, title: t('mRoot'), sub: t('mRootSub'), submit: o.submit.root } : null,
  };
  return renderCredRows({
    el: o.el,
    t: t,
    en: o.en,
    defs: o.kinds.map(function (k) { return defs[k]; }).filter(Boolean),
    onSuccess: o.onSuccess,
  });
}
