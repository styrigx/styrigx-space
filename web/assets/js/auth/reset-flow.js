/**
 * @fileoverview 「重置登录」界面（PR3）：账号页「无法登录？」→ /account/reset/，
 * 锁屏弹层里的「无法登录？」→ 弹层原地切到同一个界面。两处只是提交函数不同。
 *
 * 流程（服务端决定下一步）：
 * 1. 根密钥（全站唯一的根密钥输入框 createRootField；锁屏重置交锁屏根密钥，账号重置交账号根密钥）→ submitRoot(key)
 *    - resolve {}（或 { done:true }）→ 完成 → onDone()
 *    - resolve { needLock: { passkey, password } } → 第 2 步（只有锁屏重置会出现：恢复开关无效时，账号拆分 PR3）
 *    - reject { message, clear? } → 行内报错
 * 2. 锁屏凭证（与锁屏解锁同一类凭证，验证行 auth/cred-rows.js：锁屏通行密钥 / 解锁密码，按服务端给的配置显示）
 *    → lock.passkey() / lock.password(value)（调用方把第 1 步的根密钥一起提交）→ onDone()
 *
 * 根密钥只存在闭包里，完成 / 卸载即清空，不挂 window、不留在 DOM。
 * 文案自带中英（锁屏在每个页面都可能出现，不依赖账号页的 i18n 表）。
 * 本文件在 lib/ 层：不 import shell/ 或 apps/。
 */
import { onEnter, focusNoScroll } from './auth-flow.js';
import { bindSubmitButton } from '../lib/dialog-behavior.js';
import { renderCredRows, createRootField, CRED_ICONS } from './cred-rows.js';
import { KEY_LOCK } from '../lib/key-names.js';

const TXT = {
  title: { zh: '重置登录', en: 'Reset sign-in' },
  step1: { zh: '先用根凭证验证身份', en: 'First, verify with your root credential' },
  rootPh: { zh: '根凭证', en: 'Root credential' },
  next: { zh: '下一步', en: 'Continue' },
  enterRoot: { zh: '请输入根凭证', en: 'Enter root credential' },
  step2: { zh: '再验证一次锁屏凭证', en: 'Now verify your lock credential' },
  noLock: { zh: '锁屏还没有设置凭证，无法用锁屏凭证验证。', en: 'No lock credential is set, so it can’t be used to verify.' },
  recover: { zh: '锁屏凭证也无法使用？可在站点后台开启一次性恢复，24 小时内有效', en: 'Lock credential unavailable too? Enable one-time recovery in the site admin, valid for 24 hours.' },
  mPasskey: { zh: '锁屏通行密钥', en: 'Lock passkey' },
  mPasskeySub: { zh: '使用指纹或设备锁屏', en: 'Use fingerprint or device screen lock' },
  mPassword: { zh: '解锁密码', en: 'Unlock password' },
  mPasswordSub: { zh: '输入解锁密码', en: 'Enter unlock password' },
  verifyBtn: { zh: '验证', en: 'Verify' },
  enterCred: { zh: '请输入凭证', en: 'Enter credential' },
  passkeyBusy: { zh: '正在唤起通行密钥…', en: 'Opening passkey…' },
  errVerify: { zh: '验证失败，请重试', en: 'Verification failed, please retry' },
  sessionLost: { zh: '会话过期，请重新开始', en: 'Session expired, restart' },
};

/** @param {boolean} en */
export function resetT(en) {
  return function (/** @type {string} */ k) {
    const v = TXT[k];
    return v ? (en ? v.en : v.zh) : k;
  };
}

/**
 * 在容器里挂载重置登录界面。
 * @param {object} o
 * @param {HTMLElement} o.el 容器
 * @param {boolean} o.en
 * @param {(key: string) => Promise<{needLock?: {passkey?: boolean, password?: boolean}}|void>} o.submitRoot
 * @param {(rootKey: string) => {passkey: () => Promise<any>, password: (v: string) => Promise<any>}} [o.lock] 第 2 步提交（锁屏凭证）
 * @param {() => void} o.onDone
 * @param {(step: 'root'|'lock') => void} [o.onStep]
 * @param {boolean} [o.autofocus] 默认 true
 * @returns {{destroy: () => void}}
 */
export function mountResetFlow(o) {
  const t = resetT(o.en);
  const el = o.el;
  let rootKey = '';
  let alive = true;

  function step1() {
    el.textContent = '';
    if (o.onStep) o.onStep('root');
    const wrap = document.createElement('div');
    wrap.className = 'sgx-reset';
    wrap.dataset.step = 'root';
    const lead = document.createElement('p');
    lead.className = 'sgx-reset-lead';
    lead.textContent = t('step1');
    const rf = createRootField({ id: 'sgx-reset-root', placeholder: t('rootPh'), en: o.en });
    const err = document.createElement('p');
    err.className = 'sgx-credential-err';
    err.id = 'sgx-reset-err';
    err.hidden = true;
    const go = document.createElement('button');
    go.type = 'button';
    go.id = 'sgx-reset-go';
    go.className = 'sgx-credential-btn sgx-credential-btn-primary sgx-reset-next';
    go.textContent = t('next');
    wrap.appendChild(lead);
    wrap.appendChild(rf.field);
    wrap.appendChild(err);
    wrap.appendChild(go);
    el.appendChild(wrap);
    let busy = false;
    const submit = function () {
      if (busy || !alive) return;
      const v = rf.input.value;
      err.hidden = true;
      if (!v) {
        err.textContent = t('enterRoot');
        err.hidden = false;
        return;
      }
      busy = true;
      go.disabled = true;
      o.submitRoot(v).then(function (r) {
        if (!alive) return;
        if (r && r.needLock) {
          rootKey = v;
          rf.input.value = '';
          step2(r.needLock);
          return;
        }
        rootKey = '';
        rf.input.value = '';
        o.onDone();
      }, function (e) {
        if (!alive) return;
        err.textContent = (e && e.message) || t('errVerify');
        err.hidden = false;
        if (e && e.clear) rf.input.value = '';
      }).then(function () {
        busy = false;
        go.disabled = false;
      });
    };
    bindSubmitButton(go, submit);
    onEnter(rf.input, submit);
    if (o.autofocus !== false) focusNoScroll(rf.input);
    return rf.input;
  }

  /** @param {{passkey?: boolean, password?: boolean}} need */
  function step2(need) {
    el.textContent = '';
    if (o.onStep) o.onStep('lock');
    const wrap = document.createElement('div');
    wrap.className = 'sgx-reset';
    wrap.dataset.step = 'lock';
    const lead = document.createElement('p');
    lead.className = 'sgx-reset-lead';
    lead.textContent = t('step2');
    wrap.appendChild(lead);
    const rows = document.createElement('div');
    rows.className = 'sgx-credential-methods sgx-reset-opts';
    wrap.appendChild(rows);
    const hint = document.createElement('p');
    hint.className = 'sgx-reset-recover-hint';
    hint.textContent = t('recover');
    el.appendChild(wrap);
    const sub = o.lock ? o.lock(rootKey) : null;
    const guard = function (fn) {
      return function (/** @type {any} */ v) {
        if (!rootKey) return Promise.reject({ message: t('sessionLost') });
        return fn(v);
      };
    };
    const defs = [];
    if (sub && need.passkey) defs.push({ kind: 'passkey', field: 'webauthn', icon: CRED_ICONS.passkey, title: t('mPasskey'), sub: t('mPasskeySub'), submit: guard(sub.passkey) });
    if (sub && need.password) defs.push({ kind: 'password', field: 'password', icon: CRED_ICONS.password, title: t('mPassword'), sub: t('mPasswordSub'), submit: guard(sub.password), pmUser: KEY_LOCK });
    if (!defs.length) {
      const none = document.createElement('p');
      none.className = 'sgx-reset-none';
      none.textContent = t('noLock');
      rows.appendChild(none);
    } else {
      renderCredRows({
        el: rows,
        t: t,
        en: o.en,
        defs: defs,
        onSuccess: function () {
          if (!alive) return;
          rootKey = '';
          o.onDone();
        },
      });
    }
    wrap.appendChild(hint);
  }

  const first = step1();
  return {
    destroy: function () {
      alive = false;
      rootKey = '';
      try { if (first) first.value = ''; } catch (e) {}
      el.textContent = '';
    },
  };
}

/** 供 HTML 属性用（外部有时要拿标题） */
export function resetTitle(en) {
  return en ? TXT.title.en : TXT.title.zh;
}
