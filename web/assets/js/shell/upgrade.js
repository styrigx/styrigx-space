/**
 * 2.9.3：访客升级验证层。
 * 当访客访问管理员专属路径时，首页返回 200 并带 data-sgx-upgrade="1"，
 * 本模块打开验证层：只显示通行密钥+密码，不显示访客入口，带「需要管理员验证」提示。
 * 验证通过后跳回 data-sgx-upgrade-return。失败/取消留在原页，不跳转。
 *
 * 2.10.1：直接实现验证流程（不再引用不存在的 ./passkey.js，也不再派发
 * 无人监听的 sgx:upgrade-* 事件）。访客调用认证类 action 由中间件放行
 * （AUTH_ACTIONS），端点自身做会话/reauth 票校验。
 *
 * 根凭证/密码改用弹层内联输入，不用原生弹窗（全站禁止原生弹窗，
 * 见 scripts/check-frontend.mjs）。
 */
import { sgxNavigate } from '../lib/diag-jumptrace.js';
import { bindEyeButton } from '../lib/dialog-behavior.js';
import { followKeyboard } from './vk.js';
import { getPasskeyAssertion, passkeyErrorText, assertionOptions, assertionToJSON, isPasskeyCancel } from '../auth/passkey-assert.js';

/**
 * B1-2：upgrade 流程通行密钥错误的展示决策（纯函数，可单测）。
 * 规则（与 46fe723 之前对齐）：
 * - cancelled、NotAllowedError 产生的 nokey：以前不弹错，现在也不弹错 → 返回 null
 * - InvalidStateError 产生的 nokey：以前弹通用报错，现在也弹通用报错
 * - timeout / failed：弹错；文案用 B1-2 的 4 档文案（46fe723 计划内）
 * @param {{kind?: string, cause?: {name?: string}}|null|undefined} e getPasskeyAssertion 抛出的错误
 * @param {boolean} isEn 是否英文
 * @returns {string|null} 要显示的文案；null 表示不弹错
 */
export function upgradePasskeyErrorText(e, isEn) {
  const kind = e && e.kind;
  if (isPasskeyCancel(e)) return null;
  if (kind === 'nokey') { /* InvalidStateError */
    return isEn ? 'Verification failed' : '验证失败';
  }
  return passkeyErrorText(kind || 'failed', isEn);
}

/**
 * 管理员验证层（访客 → 管理员的「升级」，状态机里独立于锁屏的一态）：
 * - 就地弹出，盖在当前页面上；不出锁屏、不跳页。
 * - 只给 admin 方式：通行密钥、密码（根凭证不拥有会话，不在这里）；没有访客入口。
 * - 取消 / 失败：关掉弹层留在原页；不调任何接口，访客会话原样保留。
 * - 通过：服务端签发 admin 会话（替换访客会话）→ 跳到 returnPath（站内路径，由调用方给：
 *   security.js 给锁屏凭证页地址；lock-guard.js 的 initUpgrade 按需加载本模块后给服务端校验过的 data-sgx-upgrade-return）。
 * @param {string} returnPath
 */
export function openAdminVerify(returnPath) {
  if (document.getElementById('sgx-upgrade-overlay')) return;
  const html = document.documentElement;
  const isEn = html.lang === 'en';

  // 创建遮罩和对话框
  const overlay = document.createElement('div');
  overlay.id = 'sgx-upgrade-overlay';
  overlay.innerHTML =
    '<div class="sgx-upgrade-sheet" role="dialog" aria-modal="true" aria-label="' + (isEn ? 'Admin verification' : '管理员验证') + '">' +
    '<div class="sgx-upgrade-title">' + (isEn ? 'Admin verification required' : '需要管理员验证') + '</div>' +
    '<div class="sgx-upgrade-desc">' + (isEn ? 'This page requires admin verification.' : '此页面需要管理员验证后才能进入。') + '</div>' +
    '<div id="sgx-upgrade-opts">' +
    '<button type="button" class="sgx-upgrade-btn" id="sgx-upgrade-pk">' + (isEn ? 'Verify with passkey' : '通行密钥验证') + '</button>' +
    '<button type="button" class="sgx-upgrade-btn" id="sgx-upgrade-pw">' + (isEn ? 'Verify with password' : '密码验证') + '</button>' +
    '</div>' +
    '<div id="sgx-upgrade-form" hidden>' +
    '<div class="sgx-pw-field"><input type="password" id="sgx-upgrade-input" class="sgx-upgrade-input" autocomplete="off" />' +
    '<button type="button" class="sgx-pw-eye" id="sgx-upgrade-eye" aria-label="' + (isEn ? 'Show password' : '显示密码') + '"></button></div>' +
    '<button type="button" class="sgx-upgrade-btn" id="sgx-upgrade-go">' + (isEn ? 'Verify' : '验证') + '</button>' +
    '<button type="button" class="sgx-upgrade-cancel" id="sgx-upgrade-back">' + (isEn ? 'Back' : '返回') + '</button>' +
    '</div>' +
    '<button type="button" class="sgx-upgrade-cancel" id="sgx-upgrade-cancel">' + (isEn ? 'Cancel' : '取消') + '</button>' +
    '<p class="sgx-upgrade-err" id="sgx-upgrade-err" hidden></p>' +
    '</div>';
  document.body.appendChild(overlay);

  const close = () => {
    /* B1-4：关闭时解绑键盘避让监听，避免 visualViewport 监听泄漏 */
    try { if (window.__sgxUpgradeKbCleanup) window.__sgxUpgradeKbCleanup(); } catch (e) {}
    overlay.remove();
  };
  const errEl = document.getElementById('sgx-upgrade-err');
  const showErr = (msg) => {
    if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
  };

  document.getElementById('sgx-upgrade-cancel').addEventListener('click', close);

  /* 密码走弹层内联输入：当前待验证的方式（'pw' 密码），null 表示停在按钮的初始状态。
     根凭证不拥有会话，不能把访客升级成 admin，所以这里没有根凭证入口。 */
  let pendingKind = null;
  const optsEl = document.getElementById('sgx-upgrade-opts');
  const formEl = document.getElementById('sgx-upgrade-form');
  const inputEl = document.getElementById('sgx-upgrade-input');

  /* 批次 A 验收修复 P2：访客升级弹层补眼睛按钮（初始 eye-off；每次展开复位）。
     眼睛按钮常驻 DOM，只绑一次，重复绑定会叠加 click 监听导致一次点击切两次。 */
  let resetUpgradeEye = null;
  const showInput = (kind) => {
    pendingKind = kind;
    if (errEl) errEl.hidden = true;
    if (optsEl) optsEl.hidden = true;
    if (inputEl) {
      inputEl.value = '';
      inputEl.placeholder = isEn ? 'Enter unlock password' : '请输入解锁密码';
    }
    const eyeEl = document.getElementById('sgx-upgrade-eye');
    if (eyeEl && inputEl) {
      if (!resetUpgradeEye) {
        resetUpgradeEye = bindEyeButton(eyeEl, inputEl, {
          showLabel: isEn ? 'Show password' : '显示密码',
          hideLabel: isEn ? 'Hide password' : '隐藏密码',
        });
      } else {
        resetUpgradeEye();
      }
    }
    if (formEl) formEl.hidden = false;
    try { if (inputEl) inputEl.focus({ preventScroll: true }); } catch (e) {}
    /* B1-4：键盘避让（与锁屏同一实现） */
    try {
      if (window.__sgxUpgradeKbCleanup) window.__sgxUpgradeKbCleanup();
      const sheet = document.querySelector('.sgx-upgrade-sheet');
      if (sheet && inputEl) window.__sgxUpgradeKbCleanup = followKeyboard(sheet, inputEl);
    } catch (e2) {}
  };
  const showOpts = () => {
    pendingKind = null;
    if (errEl) errEl.hidden = true;
    if (formEl) formEl.hidden = true;
    if (inputEl) inputEl.value = '';
    if (optsEl) optsEl.hidden = false;
  };

  // 密码验证：直接调用 verify，成功后服务端签发 admin 会话
  async function verifyPw(pw) {
    try {
      const res = await fetch('/api/lock-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', password: pw }),
        credentials: 'include',
      });
      const j = await res.json();
      if (j && j.ok) {
        sgxNavigate(returnPath);
      } else {
        showErr(isEn ? 'Wrong password' : '密码错误');
      }
    } catch (e) {
      showErr(isEn ? 'Network error' : '网络错误');
    }
  }

  document.getElementById('sgx-upgrade-pw').addEventListener('click', () => {
    showInput('pw');
  });
  document.getElementById('sgx-upgrade-back').addEventListener('click', showOpts);

  const submitInput = () => {
    if (!pendingKind) return;
    if (errEl) errEl.hidden = true;
    const v = inputEl ? inputEl.value : '';
    if (!v) return;
    verifyPw(v);
  };
  document.getElementById('sgx-upgrade-go').addEventListener('click', submitInput);
  if (inputEl) {
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitInput();
      }
    });
  }

  // 通行密钥验证：challenge → WebAuthn → auth，成功后服务端签发 admin 会话
  document.getElementById('sgx-upgrade-pk').addEventListener('click', async () => {
    if (errEl) errEl.hidden = true;
    try {
      if (!window.PublicKeyCredential) {
        showErr(isEn ? 'Not supported on this device' : '设备不支持');
        return;
      }
      const chRes = await fetch('/api/lock-passkey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'challenge', type: 'auth' }),
        credentials: 'include',
      });
      const ch = await chRes.json();
      if (!ch || !ch.ok) {
        showErr(isEn ? 'Server error' : '服务器错误');
        return;
      }
      /* B1-2：用公共函数（隐藏弹层 + 30s 超时 + 4 档错误） */
      let cred;
      try {
        const dlg = document.querySelector('.sgx-upgrade-sheet');
        cred = await getPasskeyAssertion(assertionOptions(ch), { hideEl: dlg });
      } catch (e) {
        /* B1-2：cancelled 和 NotAllowedError 的 nokey 以前不弹错，现在也不弹错；
           InvalidStateError 保持 46fe723 前的通用报错；timeout/failed 用 4 档文案(46fe723) */
        const msg = upgradePasskeyErrorText(e, isEn);
        if (msg) showErr(msg);
        return;
      }
      const authRes = await fetch('/api/lock-passkey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'auth',
          cid: ch.cid,
          credential: assertionToJSON(cred),
        }),
        credentials: 'include',
      });
      const authJ = await authRes.json();
      if (authJ && authJ.ok) {
        sgxNavigate(returnPath);
      } else {
        showErr(isEn ? 'Verification failed' : '验证失败');
      }
    } catch (e) {
      /* 用户取消/无钥匙(NotAllowedError)：留在原页不弹错；其余弹错（保持 46fe723 前 e.name !== 'NotAllowedError' 的行为） */
      const isCancelLike = e && (e.kind === 'cancelled' ||
        (e.kind === 'nokey' && e.cause && e.cause.name === 'NotAllowedError') ||
        e.name === 'NotAllowedError');
      if (!isCancelLike) showErr(isEn ? 'Verification failed' : '验证失败');
    }
  });
}
