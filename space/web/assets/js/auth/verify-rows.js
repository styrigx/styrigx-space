/**
 * @fileoverview 凭证验证行（锁屏凭证页的门 apps/security-lock.js、锁屏复验弹层 auth/lock-reauth.js 在用）。
 *
 * 2026-11-08 账号 UI 改版：账号整页删了，账号的登录 / 再验证在顶栏账号终端里（shell/account/session.js、reauth.js，后端调用在 shell/account/api.js），
 * 原来这里的 accountSubmitters 一起删了。只剩渲染：visibleKinds（设了哪个显示哪个）+ renderVerifyRows（submit 由调用方给）。
 * 2026-11-08 按 NAMING-V2 §2.8 中性化改名：原 auth/account-methods.js renderAccountMethods → 本文件 renderVerifyRows（C11）。
 *
 * 行的渲染在 auth/cred-rows.js（锁屏弹层的重置登录也用它）。
 */
import { renderCredRows, CRED_ICONS } from './cred-rows.js';
import { KEY_LOCK, KEY_SPACE } from '../lib/key-names.js';

/**
 * 要显示的入口（固定顺序：通行密钥、密码）。恢复密钥 / 进站凭证都不是这里的入口。
 * 设了哪个显示哪个；读不到状态（网络失败）时两个都显示，界面一致，服务端照常校验。
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
 * 在容器里渲染凭证验证行（auth/cred-rows.js renderCredRows 的封装；锁屏凭证的门 / 锁屏复验在用）。
 * @param {object} o
 * @param {HTMLElement} o.el
 * @param {function(string): string} o.t
 * @param {boolean} o.en
 * @param {string[]} o.kinds visibleKinds() 的结果
 * @param {{passkey:Function, password:Function, space?:Function}} o.submit 提交函数（锁屏凭证的门另给 space）
 * @param {Function} o.onSuccess
 * @param {string} [o.pmUser] 密码行的隐藏用户名（默认 LockKey：现在只有锁屏在用；账号终端有自己的隐藏用户名）
 * @returns {{collapse: Function}}
 */
export function renderVerifyRows(o) {
  const t = o.t;
  const defs = {
    passkey: { kind: 'passkey', field: 'webauthn', icon: CRED_ICONS.passkey, title: t('mPasskey'), sub: t('mPasskeySub'), submit: o.submit.passkey },
    password: { kind: 'password', field: 'password', icon: CRED_ICONS.password, title: t('mPassword'), sub: t('mPasswordSub'), submit: o.submit.password, pmUser: o.pmUser || KEY_LOCK },
    /* 只给锁屏凭证的门用（security-lock.js 的 kinds 带 space、submit 带 space）：进站凭证行；账号页没有这一行 */
    space: o.submit.space ? { kind: 'space', field: 'key', icon: CRED_ICONS.key, title: t('mSpace'), sub: t('mSpaceSub'), submit: o.submit.space, pmUser: KEY_SPACE } : null,
  };
  return renderCredRows({
    el: o.el,
    t: t,
    en: o.en,
    defs: o.kinds.map(function (k) { return defs[k]; }).filter(Boolean),
    onSuccess: o.onSuccess,
  });
}
