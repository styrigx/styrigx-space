/**
 * @fileoverview 「重置登录」界面（PR3）：账号页「无法登录？」→ /settings/account/reset/，
 * 锁屏弹层里的「无法登录？」→ 弹层原地切到同一个界面。两处只是提交函数不同。
 *
 * 流程（服务端决定下一步）：
 * 1. 根凭证（全站唯一的根凭证输入框 createRootField）→ submitRoot(key)
 *    - resolve {}（或 { done:true }）→ 完成 → onDone()
 *    - resolve { needOwner: { passkey, password } } → 第 2 步
 *    - reject { message, clear? } → 行内报错
 * 2. 账号凭证（与账号登录同一套验证行 lib/cred-rows.js：账号通行密钥 / 账号密码，按服务端给的配置显示）
 *    → owner.passkey() / owner.password(value)（调用方把第 1 步的根凭证一起提交）→ onDone()
 *
 * 根凭证只存在闭包里，完成 / 卸载即清空，不挂 window、不留在 DOM。
 * 文案自带中英（锁屏在每个页面都可能出现，不依赖账号页的 i18n 表）。
 * 本文件在 lib/ 层：不 import shell/ 或 apps/。
 */
import { onEnter, focusNoScroll } from './auth-flow.js';
import { bindSubmitButton } from './dialog-behavior.js';
import { renderCredRows, createRootField, CRED_ICONS } from './cred-rows.js';

const TXT = {
  title: { zh: '重置登录', en: 'Reset sign-in' },
  step1: { zh: '先用根凭证验证身份', en: 'First, verify with your root credential' },
  rootPh: { zh: '根凭证', en: 'Root credential' },
  next: { zh: '下一步', en: 'Continue' },
  enterRoot: { zh: '请输入根凭证', en: 'Enter root credential' },
  step2: { zh: '再验证一次账号凭证', en: 'Now verify your account credential' },
  noOwner: { zh: '账号还没有设置登录方式，无法用账号凭证验证。', en: 'No account credential is set, so it can’t be used to verify.' },
  recover: { zh: '账号凭证也无法使用？可在站点后台开启一次性恢复，24 小时内有效', en: 'Account credential unavailable too? Enable one-time recovery in the site admin, valid for 24 hours.' },
  mPasskey: { zh: '账号通行密钥', en: 'Account passkey' },
  mPasskeySub: { zh: '使用指纹或设备锁屏', en: 'Use fingerprint or device screen lock' },
  mPassword: { zh: '账号密码', en: 'Account password' },
  mPasswordSub: { zh: '输入账号密码', en: 'Enter account password' },
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
 * @param {(key: string) => Promise<{needOwner?: {passkey?: boolean, password?: boolean}}|void>} o.submitRoot
 * @param {(rootKey: string) => {passkey: () => Promise<any>, password: (v: string) => Promise<any>}} [o.owner] 第 2 步提交
 * @param {() => void} o.onDone
 * @param {(step: 'root'|'owner') => void} [o.onStep]
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
    err.className = 'sgx-door-err';
    err.id = 'sgx-reset-err';
    err.hidden = true;
    const go = document.createElement('button');
    go.type = 'button';
    go.id = 'sgx-reset-go';
    go.className = 'sgx-door-btn sgx-door-btn-primary sgx-reset-next';
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
        if (r && r.needOwner) {
          rootKey = v;
          rf.input.value = '';
          step2(r.needOwner);
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
    if (o.onStep) o.onStep('owner');
    const wrap = document.createElement('div');
    wrap.className = 'sgx-reset';
    wrap.dataset.step = 'owner';
    const lead = document.createElement('p');
    lead.className = 'sgx-reset-lead';
    lead.textContent = t('step2');
    wrap.appendChild(lead);
    const rows = document.createElement('div');
    rows.className = 'sgx-door-methods sgx-reset-opts';
    wrap.appendChild(rows);
    const hint = document.createElement('p');
    hint.className = 'sgx-reset-recover-hint';
    hint.textContent = t('recover');
    el.appendChild(wrap);
    const sub = o.owner ? o.owner(rootKey) : null;
    const guard = function (fn) {
      return function (/** @type {any} */ v) {
        if (!rootKey) return Promise.reject({ message: t('sessionLost') });
        return fn(v);
      };
    };
    const defs = [];
    if (sub && need.passkey) defs.push({ kind: 'passkey', field: 'webauthn', icon: CRED_ICONS.passkey, title: t('mPasskey'), sub: t('mPasskeySub'), submit: guard(sub.passkey) });
    if (sub && need.password) defs.push({ kind: 'password', field: 'password', icon: CRED_ICONS.password, title: t('mPassword'), sub: t('mPasswordSub'), submit: guard(sub.password) });
    if (!defs.length) {
      const none = document.createElement('p');
      none.className = 'sgx-reset-none';
      none.textContent = t('noOwner');
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
