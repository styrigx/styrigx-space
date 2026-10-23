/**
 * @fileoverview 登录/验证共用积木（纯重构抽出，行为与原各处副本一致）。
 *
 * 原来锁屏（shell/lock.js）、门内页（apps/security-lock.js、apps/account-security.js）、
 * 门内倒计时与离门清票（apps/app-gate.js）各自抄了一份同样的代码，这里只收「逐字相同」的部分：
 *
 * - 密码框：pwFieldHtml（锁屏弹层用的 HTML 片段）、bindPwEye（眼睛按钮中英文案）、
 *   onEnter（回车提交）、focusNoScroll（聚焦不滚动，失败退回普通 focus）
 * - 门内「设置/修改密码」弹层：bindDataEyes、createSetPwDialog、newPwError、pwSetRequest
 * - 锁屏凭证的门客户端：lockDoorFetch（POST /api/lock-door）
 *
 * 将来加新的凭证域（例如独立的「账户」登录）时，直接复用这些积木即可。
 * 本文件在 lib/ 层：不得 import shell/ 或 apps/（followKeyboard 由调用方传入）。
 */
import { on } from './events.js';
import { onDialogBackdrop, onDialogCancel, recordDialogClose, bindEyeButton } from './dialog-behavior.js';

/* ---------------------------------------------------------------------------
 * 密码框
 * ------------------------------------------------------------------------- */

/**
 * 眼睛按钮文案（锁屏、安全与隐私页验证弹层共用；门内页走 i18n 表 eyeShow/eyeHide）。
 * @param {boolean} en
 */
export function eyeLabels(en) {
  return {
    showLabel: en ? 'Show password' : '显示密码',
    hideLabel: en ? 'Hide password' : '隐藏密码',
  };
}

/**
 * 眼睛按钮走 bindEyeButton（初始 eye-off）。
 * @param {HTMLElement} eye
 * @param {any} input 密码输入框（HTMLInputElement）
 * @param {boolean} en
 * @returns {() => void} 复位函数（bindEyeButton 的返回值）
 */
export function bindPwEye(eye, input, en) {
  return bindEyeButton(eye, input, eyeLabels(en));
}

/** 隐藏用户名框的样式（只给密码管理器读，不可见、不可聚焦） */
export const PM_USER_STYLE = 'position:absolute;opacity:0;pointer-events:none;width:1px;height:1px;';

/**
 * 隐藏用户名框 HTML：让 Samsung Pass / Google 密码管理器把密码存成这个名字（AccountKey / LockKey / RootKey）。
 * @param {string} name key-names.js 里的 KEY_*
 */
export function pmUserHtml(name) {
  return '<input type="text" autocomplete="username" value="' + name + '" aria-hidden="true" tabindex="-1" style="' + PM_USER_STYLE + '">';
}

/**
 * 锁屏弹层里的密码框 HTML（.sgx-pw-field > input.sgx-pw-input + button.sgx-pw-eye）。
 * 输出与原手拼字符串逐字相同。
 * @param {object} o
 * @param {string} o.id 输入框 id
 * @param {string} o.eyeId 眼睛按钮 id
 * @param {string} o.autocomplete autocomplete 值
 * @param {string} o.placeholder 占位文字
 * @param {string} [o.ariaLabel] 输入框 aria-label（不传则不输出该属性）
 * @param {boolean} o.en 是否英文（眼睛按钮初始文案）
 * @param {string} [o.pmUser] 密码管理器里的名字（隐藏用户名框，如 LockKey）
 */
export function pwFieldHtml(o) {
  return '<div class="sgx-pw-field">' + (o.pmUser ? pmUserHtml(o.pmUser) : '') + '<input type="password" id="' + o.id + '" class="sgx-pw-input" autocomplete="' + o.autocomplete + '" ' +
    (o.ariaLabel !== undefined ? 'aria-label="' + o.ariaLabel + '" ' : '') +
    'placeholder="' + o.placeholder + '">' +
    '<button type="button" class="sgx-pw-eye" id="' + o.eyeId + '" aria-label="' + (o.en ? 'Show password' : '显示密码') + '"></button></div>';
}

/**
 * 回车提交（preventDefault 后调 fn）。
 * @param {HTMLElement} input
 * @param {() => void} fn
 */
export function onEnter(input, fn) {
  on(input, 'keydown', function (/** @type {KeyboardEvent} */ e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      fn();
    }
  });
}

/**
 * 聚焦不滚动；不支持 preventScroll 时退回普通 focus。
 * @param {HTMLElement} input
 */
export function focusNoScroll(input) {
  try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (_) {} }
}

/* ---------------------------------------------------------------------------
 * 门内「设置/修改密码」弹层（door.js 与 security-lock.js 共用）
 * DOM：#lockpw-dlg、#lockpw-1、#lockpw-2、#lockpw-title、#lockpw-err、#lockmgr-pwrow、
 *      [data-eye] 眼睛按钮、[data-dlg-close] 关闭按钮
 * ------------------------------------------------------------------------- */

/**
 * 页面上所有 [data-eye] 眼睛按钮统一接管（批次 A 验收修复 P2：图标 + 文案 + 复位）。
 * @param {(k:string)=>string} t 文案函数（eyeShow / eyeHide）
 * @returns {Array<() => void>} 每个按钮的复位函数（重开弹层时调用）
 */
export function bindDataEyes(t) {
  /** @type {Array<() => void>} */
  const eyeResets = [];
  function bindEye(btn, input) {
    if (!btn || !input) return;
    eyeResets.push(bindEyeButton(btn, input, { showLabel: t('eyeShow'), hideLabel: t('eyeHide') }));
  }
  document.querySelectorAll('[data-eye]').forEach(function (b) {
    const inp = document.getElementById(b.getAttribute('data-eye'));
    bindEye(b, inp);
  });
  return eyeResets;
}

/**
 * 新密码前端校验：至少 8 位、两次一致。
 * @param {string} va 第一次输入
 * @param {string} vb 第二次输入
 * @returns {'pwMin8'|'pwMismatch'|null} 文案 key；通过返回 null
 */
export function newPwError(va, vb) {
  if (va.length < 8) return 'pwMin8';
  if (va !== vb) return 'pwMismatch';
  return null;
}

/**
 * /api/owner-password 设置/修改请求体。
 * @param {boolean} hasPw 当前是否已设置
 * @param {string} kind 'owner' | 'lock'
 * @param {string} password 新密码
 * @returns {{action:'set'|'change', body:object}}
 */
export function pwSetRequest(hasPw, kind, password) {
  const action = hasPw ? 'change' : 'set';
  const body = action === 'set'
    ? { action: 'set', kind: kind, password: password }
    : { action: 'change', kind: kind, newPassword: password };
  return { action: action, body: body };
}

/**
 * 门内「设置/修改密码」弹层控制器：打开（清空两框、眼睛复位、标题、showModal、聚焦）、
 * 关闭（记录关闭原因）、遮罩/返回手势/× 按钮、密码行点击与回车/空格打开。
 * @param {object} o
 * @param {(id:string)=>HTMLElement|null} o.$ 取元素
 * @param {(k:string)=>string} o.t 文案函数（changeTitle / setTitle）
 * @param {(id:string)=>void} o.hideErr 隐藏错误
 * @param {(dlg:HTMLElement, inputs:any)=>any} o.followKeyboard shell/vk.js 的 followKeyboard（lib 不能 import shell，由调用方传入）
 * @param {Array<() => void>} o.eyeResets bindDataEyes 的返回值
 * @param {() => boolean} o.hasPw 当前是否已设置密码
 * @param {() => void} [o.beforeOpen] 打开前（清错之后）调用，如收起其他弹层
 * @returns {{dlg: any, open: () => void, close: (reason?: string) => void}}
 */
export function createSetPwDialog(o) {
  const $ = o.$;
  const t = o.t;
  const pwDlg = /** @type {any} */ ($('lockpw-dlg'));
  /* P2-13：密码输入框聚焦时，密码弹层随键盘上移（双输入框共用同一弹层） */
  o.followKeyboard(pwDlg, [$('lockpw-1'), $('lockpw-2')]);
  function openPwDlg() {
    o.hideErr('lockpw-err');
    if (o.beforeOpen) o.beforeOpen();
    const a = /** @type {HTMLInputElement|null} */ ($('lockpw-1')), b = /** @type {HTMLInputElement|null} */ ($('lockpw-2'));
    if (a) {
      a.value = '';
      a.type = 'password';
    }
    if (b) {
      b.value = '';
      b.type = 'password';
    }
    /* 重开弹层时眼睛按钮同步回密文态（eye-off + 显示密码） */
    o.eyeResets.forEach(function (reset) { try { reset(); } catch (e) {} });
    const title = $('lockpw-title');
    if (title) title.textContent = o.hasPw() ? t('changeTitle') : t('setTitle');
    try {
      pwDlg.showModal();
    } catch (e) {}
    if (a) {
      try {
        a.focus({ preventScroll: true });
      } catch (e2) {}
    }
  }
  /** @param {string} [reason] */
  function closePwDlg(reason) {
    recordDialogClose('lockpw', reason || 'unknown');
    try {
      if (pwDlg.open) pwDlg.close();
    } catch (e) {}
  }
  if (pwDlg) {
    /* 批次 A 收尾 A1/A2：点遮罩只失焦不关闭；返回手势键盘开着先收键盘 */
    on(pwDlg, 'click', function (/** @type {MouseEvent} */ e) {
      onDialogBackdrop(e, pwDlg);
    });
    on(pwDlg, 'cancel', function (/** @type {Event} */ e) {
      onDialogCancel(e, pwDlg, function (reason) { closePwDlg(reason); });
    });
    /* 批次 A 收尾 A3：右上角 × 关闭按钮 */
    const pwClose = pwDlg.querySelector('[data-dlg-close]');
    if (pwClose) on(pwClose, 'click', function () { closePwDlg('close-btn'); });
  }
  const pwRow = $('lockmgr-pwrow');
  if (pwRow) {
    const go = function () {
      openPwDlg();
    };
    on(pwRow, 'click', go);
    on(pwRow, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
  }
  return { dlg: pwDlg, open: openPwDlg, close: closePwDlg };
}

/* ---------------------------------------------------------------------------
 * 锁屏凭证的门（门票状态 / 清票）客户端
 * ------------------------------------------------------------------------- */

export const LOCK_DOOR_API = '/api/lock-door';

/**
 * POST /api/lock-door（JSON）。请求体 = { action, ...extra }。
 * 返回原始 fetch Promise，响应由调用方各自解析。
 * @param {string} action 'status' | 'clear'
 * @param {object} [opts]
 * @param {object} [opts.extra] 额外字段
 * @param {RequestCredentials} [opts.credentials] 默认 'include'
 * @param {boolean} [opts.keepalive] 离页时尽力送达
 * @returns {Promise<Response>}
 */
export function lockDoorFetch(action, opts) {
  const o = opts || {};
  /** @type {RequestInit} */
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action: action }, o.extra || {})),
    credentials: o.credentials || 'include',
  };
  if (o.keepalive) init.keepalive = true;
  return fetch(LOCK_DOOR_API, init);
}
