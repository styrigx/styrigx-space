/**
 * @fileoverview 主站的锁侧复验弹层（P2-3，方案 3.3 / 3.7）：临时钥匙、分享短链的新建 / 作废前要锁侧复验（sgx-lock-reauth，3 分钟）。
 *
 * withLockReauth(run)：先照常请求；服务端回 401 reauth（没有有效复验票；临时钥匙 / 短链进门的会话本身不算复验）时，
 * 弹验证底部弹层（auth/auth-sheet.js createVerifyDialog），里面是和锁屏凭证页门口同一套验证行（auth/account-methods.js）：
 * 设了哪个锁屏凭证显示哪个（锁屏通行密钥 / 解锁密码），进站凭证一直在作兜底。通过后自动重试一次刚才的请求。
 * 取消 → 返回原来的 401 reauth 结果（调用方照常提示），页面状态不动。
 *
 * 子站没有这一层（子站只有共享外壳）：子站分享按钮用 shell/share-button.js 里的最小复验步骤（只含锁屏通行密钥 / 解锁密码）。
 * 状态：lib/lock-state.js 的 lockState.lockReauth（{valid, exp}）随 /api/lock-reauth status 和每次复验更新，只作展示。
 */
import { lockState } from '../lib/lock-state.js';
import { KEY_LOCK } from '../lib/key-names.js';
import { createVerifyDialog } from './auth-sheet.js';
import { renderAccountMethods } from './account-methods.js';
import { getPasskeyAssertion, assertionOptions, assertionToJSON, isPasskeyCancel } from './passkey-assert.js';
import { lockReauthFetch } from './auth-flow.js';
import { i18nTable } from '../lib/i18n.js';
/** 界面文案：页面字符串表 #sgx-i18n-core（语言包化 2026-11-07；当前语言已叠在英文上，缺键回退英文） */
const ct = i18nTable('core');

/** 锁屏侧文案（和锁屏凭证页门口一致；账号页的 i18n 里同名键是账号侧说法，所以这里自带） */
/** 锁屏侧文案在字符串表 js.core.lr*（和锁屏凭证页门口一致；账号页同名键是账号侧说法，所以单独一组；语言包化 2026-11-07） */
const STR = new Proxy(/** @type {Record<string,string>} */ ({}), { get: function (_o, k) { return typeof k === 'string' ? ct('lr' + k.charAt(0).toUpperCase() + k.slice(1)) : undefined; } });

/** @param {string} url @param {any} body */
function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  }).then(function (r) {
    return r.json().then(function (j) { return { s: r.status, j: j }; }, function () { return { s: r.status, j: null }; });
  });
}

/** 是不是「没有有效锁侧复验」 @param {{s:number, j:any}} res */
export function needsLockReauth(res) {
  return !!res && res.s === 401 && !!res.j && res.j.error === 'reauth';
}

/**
 * 读 /api/lock-reauth status：{ok, valid, expiresAt, password, passkey}；顺手更新 lockState.lockReauth。
 * @returns {Promise<{ok:boolean, valid?:boolean, expiresAt?:number, password?:boolean, passkey?:boolean, error?:string}>}
 */
export function lockReauthStatus() {
  return lockReauthFetch('status', { credentials: 'same-origin' })
    .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
    .then(function (j) {
      const ok = !!(j && j.ok);
      lockState.lockReauth = { valid: ok && !!j.valid, exp: ok && j.valid ? Number(j.expiresAt) || 0 : 0 };
      return j || { ok: false };
    }, function () { return { ok: false, error: 'network' }; });
}

/**
 * 弹锁侧复验层，通过 resolve(true)，取消 / 关掉 resolve(false)。
 * @param {{en?: boolean}} [opts]
 * @returns {Promise<boolean>}
 */
export function openLockReauth(opts) {
  const en = opts && typeof opts.en === 'boolean' ? opts.en : document.documentElement.lang === 'en';
  const T = STR;
  /** @param {string} k */
  const t = function (k) { return /** @type {any} */ (T)[k] || k; };
  return lockReauthStatus().then(function (st) {
    return new Promise(function (resolve) {
      let settled = false;
      /** @param {boolean} v */
      const done = function (v) { if (!settled) { settled = true; resolve(v); } };
      const dlg = createVerifyDialog({ en: en, reasonTag: 'lock-reauth', errId: 'sgx-lr-err', onClose: function () { done(false); } });
      dlg.setTitle(t('title'));
      dlg.setBody('<div class="sgx-credential-methods" id="sgx-lr-methods"></div>');
      if (!st || !st.ok) {
        dlg.open();
        dlg.showError(st && st.error === 'session' ? t('errSession') : t('errNetwork'));
        return;
      }
      const kinds = [];
      if (st.passkey) kinds.push('passkey');
      if (st.password) kinds.push('password');
      kinds.push('space');
      const el = /** @type {HTMLElement} */ (document.getElementById('sgx-lr-methods'));
      renderAccountMethods({
        el: el,
        t: t,
        en: en,
        kinds: kinds,
        pmUser: KEY_LOCK,
        submit: {
          /** @param {string} value */
          password: function (value) {
            return post('/api/lock-password', { action: 'verify', password: value, reauth: true }).then(function (res) {
              if (res.j && res.j.ok) return;
              if (res.s === 429 || (res.j && res.j.error === 'cooldown')) throw { message: t('errLocked') };
              if (res.j && res.j.error === 'wrong') throw { message: t('errWrongPw'), clear: true };
              throw { message: res.s === 401 ? t('errSession') : t('errVerify') };
            }, function () { throw { message: t('errNetwork') }; });
          },
          /** @param {string} value */
          space: function (value) {
            return post('/api/space-auth', { key: value, purpose: 'lock-reauth' }).then(function (res) {
              if (res.j && res.j.ok) return;
              if (res.s === 429) throw { message: t('errLocked') };
              if (res.j && res.j.error === 'config') throw { message: t('errConfig') };
              if (res.j && res.j.error === 'session') throw { message: t('errSession') };
              throw { message: t('errWrongSpace'), clear: true };
            }, function () { throw { message: t('errNetwork') }; });
          },
          passkey: function () {
            if (!window.PublicKeyCredential) return Promise.reject({ message: t('pkNoSupport') });
            return post('/api/lock-passkey', { action: 'challenge', type: 'auth' }).then(function (res) {
              const j = res.j;
              if (!j || !j.ok || !j.challenge) throw { message: t('errVerify') };
              return getPasskeyAssertion(assertionOptions(j), { hideEl: dlg.el || undefined }).then(function (cred) {
                return post('/api/lock-passkey', { action: 'auth', reauth: true, cid: j.cid, credential: assertionToJSON(cred) });
              }, function (e) {
                if (isPasskeyCancel(e)) throw { cancelled: true };
                throw { message: t('errVerify') };
              });
            }, function (e) {
              throw e && (e.cancelled || e.message) ? e : { message: t('errNetwork') };
            }).then(function (res) {
              if (res.j && res.j.ok) return;
              throw { message: res.s === 401 ? t('errSession') : t('errVerify') };
            });
          },
        },
        onSuccess: function () {
          lockState.lockReauth = { valid: true, exp: Date.now() + 180000 };
          done(true);
          dlg.close('verified');
        },
      });
      dlg.open();
    });
  });
}

/**
 * 跑一次请求；回 401 reauth 时弹锁侧复验，通过后再跑一次（只重试一次）。
 * @template {{s:number, j:any}} R
 * @param {() => Promise<R>} run
 * @param {{en?: boolean}} [opts]
 * @returns {Promise<R>}
 */
export function withLockReauth(run, opts) {
  return run().then(function (res) {
    if (!needsLockReauth(res)) return res;
    return openLockReauth(opts).then(function (ok) { return ok ? run() : res; });
  });
}
