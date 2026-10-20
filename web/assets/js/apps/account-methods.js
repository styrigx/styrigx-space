/**
 * @fileoverview 账号凭证验证行（账号页登录 + 账号 → 安全与隐私的门共用）。
 *
 * 两个入口：账号通行密钥 / 账号密码，设了哪个显示哪个（visibleKinds）。
 * - 通行密钥：POST /api/account challenge + login-passkey
 * - 账号密码：login-password
 * door:true 时服务端在账号会话之外另签 3 分钟账号门票（安全与隐私子页用）。
 * root(value)：重置登录（账号）第一步，POST /api/root-auth { purpose:'account' }（不是登录入口）。
 *
 * 行的渲染在 lib/cred-rows.js（锁屏弹层的重置登录也用它）。
 */
import { b64urlToBuf, bufToB64url } from '../lib/b64.js';
import { renderCredRows, CRED_ICONS } from '../lib/cred-rows.js';
import { ACCOUNT_API, postJSON, errText as errTextT } from './account-common.js';

/**
 * 要显示的入口（固定顺序：通行密钥、密码）。PR3：根凭证不再是登录入口（改走「无法登录？」→ 重置登录）。
 * 设了哪个显示哪个；读不到状态（访客 / 网络失败）时两个都显示，界面与站长一致，服务端一律拒绝。
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
 * @param {{door?: boolean}} [opts]
 */
export function accountSubmitters(t, opts) {
  const door = !!(opts && opts.door);
  /** @param {string} [code] @param {number} [status] */
  function errText(code, status) {
    return errTextT(t, code, status);
  }
  /** @param {string} value */
  function password(value) {
    const body = { action: 'login-password', password: value };
    if (door) body.door = true;
    return postJSON(ACCOUNT_API, body).then(function (res) {
      if (res.j && res.j.ok) return;
      throw { message: errText(res.j && res.j.error, res.s), clear: true };
    }, function () {
      throw { message: t('errNetwork') };
    });
  }
  /** 重置登录（账号）第一步：根凭证 → 账号会话 + 账号门票（服务端总是两张一起签） @param {string} value */
  function root(value) {
    const body = { key: value, purpose: 'account' };
    return postJSON('/api/root-auth', body).then(function (res) {
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
    return postJSON(ACCOUNT_API, { action: 'challenge' }).then(function (res) {
      const j = res.j;
      if (!j || !j.ok || !j.challenge) throw { message: errText(j && j.error, res.s) };
      const allow = (j.allowCredentials || []).map(function (c) {
        return { type: 'public-key', id: b64urlToBuf(c.id) };
      });
      return navigator.credentials.get({
        publicKey: {
          challenge: b64urlToBuf(j.challenge),
          rpId: j.rpId,
          allowCredentials: allow.length ? allow : undefined,
          userVerification: 'required',
        },
      }).then(function (cred) {
        return { cred: /** @type {any} */ (cred), cid: j.cid };
      }, function (e) {
        if (e && e.name === 'NotAllowedError') throw { cancelled: true };
        throw { message: t('errVerify') };
      });
    }, function () {
      throw { message: t('errNetwork') };
    }).then(function (r) {
      const cred = r.cred;
      const body = {
        action: 'login-passkey',
        cid: r.cid,
        credential: {
          id: cred.id,
          rawId: bufToB64url(cred.rawId),
          type: cred.type,
          response: {
            authenticatorData: bufToB64url(cred.response.authenticatorData),
            clientDataJSON: bufToB64url(cred.response.clientDataJSON),
            signature: bufToB64url(cred.response.signature),
            userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : null,
          },
        },
      };
      if (door) body.door = true;
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
 * 在容器里渲染账号凭证验证行（lib/cred-rows.js renderCredRows 的账号版）。
 * @param {object} o
 * @param {HTMLElement} o.el
 * @param {function(string): string} o.t
 * @param {boolean} o.en
 * @param {string[]} o.kinds visibleKinds() 的结果
 * @param {{passkey:Function, password:Function, root?:Function}} o.submit accountSubmitters() 的结果（锁屏凭证的门另给 root）
 * @param {Function} o.onSuccess
 * @returns {{collapse: Function}}
 */
export function renderAccountMethods(o) {
  const t = o.t;
  const defs = {
    passkey: { kind: 'passkey', field: 'webauthn', icon: CRED_ICONS.passkey, title: t('mPasskey'), sub: t('mPasskeySub'), submit: o.submit.passkey },
    password: { kind: 'password', field: 'password', icon: CRED_ICONS.password, title: t('mPassword'), sub: t('mPasswordSub'), submit: o.submit.password },
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
