/**
 * 2.9.3：访客升级验证层。
 * 当访客访问站长专属路径时，首页返回 200 并带 data-sgx-upgrade="1"，
 * 本模块打开验证层：只显示通行密钥+密码，不显示访客入口，带「需要站长验证」提示。
 * 验证通过后跳回 data-sgx-upgrade-return。失败/取消留在原页，不跳转。
 *
 * 2.10.1：直接实现验证流程（不再引用不存在的 ./passkey.js，也不再派发
 * 无人监听的 sgx:upgrade-* 事件）。访客调用认证类 action 由中间件放行
 * （AUTH_ACTIONS），端点自身做会话/stepup 校验。
 *
 * 根凭证/密码改用弹层内联输入，不用原生弹窗（全站禁止原生弹窗，
 * 见 scripts/check-frontend.mjs）。
 */
import { sgxNavigate, sgxReplace } from '../lib/diag-jumptrace.js';
import { bindEyeButton } from '../lib/dialog-behavior.js';
import { STORE_CLASS_LOCKKEY } from '../lib/key-names.js';

export function initUpgrade() {
  const html = document.documentElement;
  if (html.getAttribute('data-sgx-upgrade') !== '1') return;
  const returnPath = html.getAttribute('data-sgx-upgrade-return') || '/';
  const isEn = html.lang === 'en';

  // 创建遮罩和对话框
  const overlay = document.createElement('div');
  overlay.id = 'sgx-upgrade-overlay';
  overlay.innerHTML =
    '<div class="sgx-upgrade-sheet" role="dialog" aria-modal="true" aria-label="' + (isEn ? 'Owner verification' : '站长验证') + '">' +
    '<div class="sgx-upgrade-title">' + (isEn ? 'Owner verification required' : '需要站长验证') + '</div>' +
    '<div class="sgx-upgrade-desc">' + (isEn ? 'This page requires owner verification.' : '此页面需要站长验证后才能进入。') + '</div>' +
    '<div id="sgx-upgrade-opts">' +
    '<button type="button" class="sgx-upgrade-btn" id="sgx-upgrade-pk">' + (isEn ? 'Verify with passkey' : '通行密钥验证') + '</button>' +
    '<button type="button" class="sgx-upgrade-btn" id="sgx-upgrade-pw">' + (isEn ? 'Verify with password' : '密码验证') + '</button>' +
    '<button type="button" class="sgx-upgrade-btn" id="sgx-upgrade-mk">' + (isEn ? 'Root credential' : '根凭证') + '</button>' +
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

  const close = () => overlay.remove();
  const errEl = document.getElementById('sgx-upgrade-err');
  const showErr = (msg) => {
    if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
  };

  document.getElementById('sgx-upgrade-cancel').addEventListener('click', close);

  /* 根凭证/密码走弹层内联输入：当前待验证的方式（'mk' 根凭证 / 'pw' 密码），
     null 表示停在三个按钮的初始状态 */
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
      inputEl.placeholder = kind === 'mk'
        ? (isEn ? 'Enter root credential' : '请输入根凭证')
        : (isEn ? 'Enter unlock password' : '请输入解锁密码');
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
  };
  const showOpts = () => {
    pendingKind = null;
    if (errEl) errEl.hidden = true;
    if (formEl) formEl.hidden = true;
    if (inputEl) inputEl.value = '';
    if (optsEl) optsEl.hidden = false;
  };

  function b64urlToBuf(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  function bufToB64url(buf) {
    const u8 = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // 根凭证验证：root-auth → root-session 换站长会话，再按 return 跳转。
  // root-auth 成功只签发 stepup（by=root, scope=root），不换会话直接跳过去
  // 会被 middleware 弹回锁屏，所以必须先调 /api/root-session。
  async function verifyRoot(k) {
    try {
      const res = await fetch('/api/root-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: k }),
        credentials: 'include',
      });
      const j = await res.json();
      if (j && j.ok) {
        const rsRes = await fetch('/api/root-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
          credentials: 'include',
        });
        let rsJ = null;
        try { rsJ = await rsRes.json(); } catch (e) {}
        if (!(rsJ && rsJ.ok)) {
          showErr(isEn ? 'Server error' : '服务器错误');
          return;
        }
        // 若 URL 带 return：location.replace 当前地址，L1 校验 return 并 302；
        // 无 return 才去安全页。前端不自己做 return 白名单。
        let ret = '';
        try { ret = new URLSearchParams(window.location.search).get('return') || ''; } catch (e) {}
        if (ret) {
          sgxReplace(window.location.href, 'upgrade.js:123', 'upgrade-root-ok-return');
        } else {
          sgxNavigate(isEn ? '/en/settings/security/' : '/settings/security/', 'upgrade.js:125', 'upgrade-root-ok');
        }
      } else if (res.status === 429) {
        showErr(isEn ? 'Too many attempts' : '尝试次数过多');
      } else {
        showErr(isEn ? 'Wrong root credential' : '根凭证错误');
      }
    } catch (e) {
      showErr(isEn ? 'Network error' : '网络错误');
    }
  }

  // 密码验证：直接调用 verify，成功后服务端签发 owner 会话
  async function verifyPw(pw) {
    try {
      const res = await fetch('/api/owner-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', password: pw }),
        credentials: 'include',
      });
      const j = await res.json();
      if (j && j.ok) {
        sgxNavigate(returnPath, 'upgrade.js:149', 'upgrade-password-ok');
      } else {
        showErr(isEn ? 'Wrong password' : '密码错误');
      }
    } catch (e) {
      showErr(isEn ? 'Network error' : '网络错误');
    }
  }

  document.getElementById('sgx-upgrade-mk').addEventListener('click', () => {
    showInput('mk');
  });
  document.getElementById('sgx-upgrade-pw').addEventListener('click', () => {
    showInput('pw');
  });
  document.getElementById('sgx-upgrade-back').addEventListener('click', showOpts);

  const submitInput = () => {
    if (!pendingKind) return;
    if (errEl) errEl.hidden = true;
    const v = inputEl ? inputEl.value : '';
    if (!v) return;
    if (pendingKind === 'mk') verifyRoot(v);
    else verifyPw(v);
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

  // 通行密钥验证：challenge → WebAuthn → auth，成功后服务端签发 owner 会话
  // 批次 B R2b：30 秒总超时 + get() 前临时隐藏升级层 + 按分支给文案
  document.getElementById('sgx-upgrade-pk').addEventListener('click', async () => {
    if (errEl) errEl.hidden = true;
    let timedOut = false;
    const timer = window.setTimeout(function () {
      timedOut = true;
      showErr(isEn ? 'Verification timed out, please retry' : '验证超时，请重试');
    }, 30000);
    try {
      if (!window.PublicKeyCredential) {
        showErr(isEn ? 'Not supported on this device' : '设备不支持');
        return;
      }
      const chRes = await fetch('/api/owner-passkey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'challenge', type: 'auth', pkClass: STORE_CLASS_LOCKKEY }),
        credentials: 'include',
      });
      if (timedOut) return;
      const ch = await chRes.json();
      if (timedOut) return;
      if (!ch || !ch.ok) {
        showErr(isEn ? 'Failed to start verification' : '验证初始化失败');
        return;
      }
      const allow = (ch.allowCredentials || []).map((c) => ({ id: b64urlToBuf(c.id), type: c.type }));
      /* get() 前临时隐藏升级层（系统框可能被遮罩盖住），落定后恢复 */
      let wasHidden = false;
      if (overlay && !overlay.hidden) { overlay.hidden = true; wasHidden = true; }
      let cred;
      try {
        cred = await Promise.race([
          navigator.credentials.get({
            publicKey: {
              challenge: b64urlToBuf(ch.challenge),
              rpId: ch.rpId,
              allowCredentials: allow,
              userVerification: 'required',
              timeout: 30000,
            },
          }),
          new Promise(function (_, reject) {
            window.setTimeout(function () { reject({ kind: 'timeout' }); }, 30000);
          }),
        ]);
      } finally {
        if (wasHidden) overlay.hidden = false;
      }
      if (timedOut) return;
      const authRes = await fetch('/api/owner-passkey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'auth',
          cid: ch.cid,
          credential: {
            id: cred.id,
            rawId: bufToB64url(cred.rawId),
            type: cred.type,
            response: {
              clientDataJSON: bufToB64url(cred.response.clientDataJSON),
              authenticatorData: bufToB64url(cred.response.authenticatorData),
              signature: bufToB64url(cred.response.signature),
              userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : null,
            },
          },
        }),
        credentials: 'include',
      });
      if (timedOut) return;
      const authJ = await authRes.json();
      if (timedOut) return;
      if (authJ && authJ.ok) {
        sgxNavigate(returnPath, 'upgrade.js:235', 'upgrade-passkey-ok');
      } else if (authJ && authJ.error === 'unknown-key') {
        showErr(isEn ? 'No passkey found on this device' : '这台设备上没有这把钥匙');
      } else {
        showErr(isEn ? 'Verification failed' : '验证失败');
      }
    } catch (e) {
      /* 用户取消留在原页；超时文案已由 timer 显示，不重复 */
      if (e && e.kind === 'timeout') {
        /* 已显示超时文案 */
      } else if (e && e.name === 'NotAllowedError') {
        /* 取消，留在原页 */
      } else if (e && e.name === 'NotFoundError') {
        showErr(isEn ? 'No passkey found on this device' : '这台设备上没有这把钥匙');
      } else if (typeof TypeError !== 'undefined' && e instanceof TypeError) {
        showErr(isEn ? 'Network connection failed, please retry' : '网络连接失败，请重试');
      } else if (typeof SyntaxError !== 'undefined' && e instanceof SyntaxError) {
        showErr(isEn ? 'Unexpected server response, please retry' : '服务响应异常，请重试');
      } else if (e && e.name !== 'NotAllowedError') {
        showErr(isEn ? 'Verification failed' : '验证失败');
      }
    } finally {
      window.clearTimeout(timer);
    }
  });
}
