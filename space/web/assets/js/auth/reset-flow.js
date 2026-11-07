/**
 * @fileoverview 「重置登录」界面（PR3）：账号页「无法登录？」→ /account/reset/，
 * 锁屏弹层里的「无法登录？」→ 弹层原地切到同一个界面。两处只是提交函数不同。
 *
 * 流程（服务端决定下一步）：
 * 1. 兜底凭证（全站唯一的兜底凭证输入框 createKeyField；种类由调用方给：锁屏重置交进站凭证 keyKind='space'，
 *    账号重置交账号根凭证 keyKind='root'）→ submitKey(key)
 *    - resolve {}（或 { done:true }）→ 完成 → onDone()
 *    - resolve { needLock: { passkey, password } } → 第 2 步（只有锁屏重置会出现：恢复开关无效时，账号拆分 PR3）
 *    - reject { message, clear? } → 行内报错
 * 2. 锁屏凭证（与锁屏解锁同一类凭证，验证行 auth/cred-rows.js：锁屏通行密钥 / 解锁密码，按服务端给的配置显示）
 *    → lock.passkey() / lock.password(value)（调用方把第 1 步的凭证一起提交）→ onDone()
 *
 * 第 1 步的凭证只存在闭包里，完成 / 卸载即清空，不挂 window、不留在 DOM。
 * 锁屏侧文案自带中英（锁屏在每个页面都可能出现，不依赖账号页的 i18n 表）；第 1 步的凭证文案由调用方按种类给（keyText）。
 * 本文件在 lib/ 层：不 import shell/ 或 apps/。
 */
import { onEnter, focusNoScroll } from './auth-flow.js';
import { bindSubmitButton } from '../lib/dialog-behavior.js';
import { renderCredRows, createKeyField, CRED_ICONS } from './cred-rows.js';
import { KEY_LOCK } from '../lib/key-names.js';
import { i18nTable } from '../lib/i18n.js';
/** 界面文案：页面字符串表 #sgx-i18n-core（语言包化 2026-11-07；当前语言已叠在英文上，缺键回退英文） */
const ct = i18nTable('core');

/** 文案在字符串表 js.core.rf*（语言包化 2026-11-07） */

/** @param {boolean} en */
export function resetT(en) {
  return function (/** @type {string} */ k) {
    return ct('rf' + k.charAt(0).toUpperCase() + k.slice(1)) || k;
  };
}

/**
 * 在容器里挂载重置登录界面。
 * @param {object} o
 * @param {HTMLElement} o.el 容器
 * @param {boolean} o.en
 * @param {string} o.keyKind 第 1 步凭证的种类（输入框 id 后缀）：锁屏侧 'space'，账号侧 'root'
 * @param {string} o.pmUser 第 1 步输入框的隐藏用户名：锁屏侧 KEY_SPACE，账号侧 KEY_ROOT
 * @param {{lead: string, ph: string, empty: string}} o.keyText 第 1 步文案（已按语言选好）：引导句、占位、空值提示
 * @param {(key: string) => Promise<{needLock?: {passkey?: boolean, password?: boolean}}|void>} o.submitKey
 * @param {(key: string) => {passkey: () => Promise<any>, password: (v: string) => Promise<any>}} [o.lock] 第 2 步提交（锁屏凭证）
 * @param {() => void} o.onDone
 * @param {(step: 'key'|'lock') => void} [o.onStep]
 * @param {boolean} [o.autofocus] 默认 true
 * @returns {{destroy: () => void}}
 */
export function mountResetFlow(o) {
  const t = resetT(o.en);
  const el = o.el;
  let firstKey = '';
  let alive = true;

  function step1() {
    el.textContent = '';
    if (o.onStep) o.onStep('key');
    const wrap = document.createElement('div');
    wrap.className = 'sgx-reset';
    wrap.dataset.step = 'key';
    const lead = document.createElement('p');
    lead.className = 'sgx-reset-lead';
    lead.textContent = o.keyText.lead;
    const rf = createKeyField({ id: 'sgx-reset-' + o.keyKind, placeholder: o.keyText.ph, pmUser: o.pmUser, en: o.en });
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
        err.textContent = o.keyText.empty;
        err.hidden = false;
        return;
      }
      busy = true;
      go.disabled = true;
      o.submitKey(v).then(function (r) {
        if (!alive) return;
        if (r && r.needLock) {
          firstKey = v;
          rf.input.value = '';
          step2(r.needLock);
          return;
        }
        firstKey = '';
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
    const sub = o.lock ? o.lock(firstKey) : null;
    const guard = function (fn) {
      return function (/** @type {any} */ v) {
        if (!firstKey) return Promise.reject({ message: t('sessionLost') });
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
          firstKey = '';
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
      firstKey = '';
      try { if (first) first.value = ''; } catch (e) {}
      el.textContent = '';
    },
  };
}

/** 供 HTML 属性用（外部有时要拿标题） */
export function resetTitle(en) {
  return ct('rfTitle');
}
