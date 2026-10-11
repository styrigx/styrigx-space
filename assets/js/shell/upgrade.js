/**
 * 2.9.3：访客升级验证层。
 * 当访客访问主人专属路径时，首页返回 200 并带 data-sgx-upgrade="1"，
 * 本模块打开验证层：只显示通行密钥+密码，不显示访客入口，带「需要主人验证」提示。
 * 验证通过后跳回 data-sgx-upgrade-return。失败/取消留在原页，不跳转。
 *
 * 2.10.1：直接实现验证流程（不再引用不存在的 ./passkey.js，也不再派发
 * 无人监听的 sgx:upgrade-* 事件）。访客调用认证类 action 由中间件放行
 * （AUTH_ACTIONS），端点自身做会话/stepup 校验。
 */
export function initUpgrade() {
  const html = document.documentElement;
  if (html.getAttribute('data-sgx-upgrade') !== '1') return;
  const returnPath = html.getAttribute('data-sgx-upgrade-return') || '/';
  const isEn = html.lang === 'en';

  // 创建遮罩和对话框
  const overlay = document.createElement('div');
  overlay.id = 'sgx-upgrade-overlay';
  overlay.innerHTML =
    '<div class="sgx-upgrade-sheet" role="dialog" aria-modal="true" aria-label="' + (isEn ? 'Owner verification' : '主人验证') + '">' +
    '<div class="sgx-upgrade-title">' + (isEn ? 'Owner verification required' : '需要主人验证') + '</div>' +
    '<div class="sgx-upgrade-desc">' + (isEn ? 'This page requires owner verification.' : '此页面需要主人验证后才能进入。') + '</div>' +
    '<button type="button" class="sgx-upgrade-btn" id="sgx-upgrade-pk">' + (isEn ? 'Verify with passkey' : '通行密钥验证') + '</button>' +
    '<button type="button" class="sgx-upgrade-btn" id="sgx-upgrade-pw">' + (isEn ? 'Verify with password' : '密码验证') + '</button>' +
    '<button type="button" class="sgx-upgrade-btn" id="sgx-upgrade-mk">' + (isEn ? 'Management key (recovery)' : '管理密钥（恢复用）') + '</button>' +
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

  // 管理密钥验证：调 /api/owner-auth，成功后进入安全与隐私页
  document.getElementById('sgx-upgrade-mk').addEventListener('click', async () => {
    if (errEl) errEl.hidden = true;
    const k = window.prompt(isEn ? 'Enter management key (recovery)' : '请输入管理密钥（恢复用）');
    if (!k) return;
    try {
      const res = await fetch('/api/owner-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: k }),
        credentials: 'include',
      });
      const j = await res.json();
      if (j && j.ok) {
        location.href = isEn ? '/en/settings/security/' : '/settings/security/';
      } else if (res.status === 429) {
        showErr(isEn ? 'Too many attempts' : '尝试次数过多');
      } else {
        showErr(isEn ? 'Wrong management key' : '管理密钥错误');
      }
    } catch (e) {
      showErr(isEn ? 'Network error' : '网络错误');
    }
  });

  // 通行密钥验证：challenge → WebAuthn → auth，成功后服务端签发 owner 会话
  document.getElementById('sgx-upgrade-pk').addEventListener('click', async () => {
    if (errEl) errEl.hidden = true;
    try {
      if (!window.PublicKeyCredential) {
        showErr(isEn ? 'Not supported on this device' : '设备不支持');
        return;
      }
      const chRes = await fetch('/api/owner-passkey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'challenge', type: 'auth', pkClass: 'lock' }),
        credentials: 'include',
      });
      const ch = await chRes.json();
      if (!ch || !ch.ok) {
        showErr(isEn ? 'Server error' : '服务器错误');
        return;
      }
      const allow = (ch.allowCredentials || []).map((c) => ({ id: b64urlToBuf(c.id), type: c.type }));
      const cred = await navigator.credentials.get({
        publicKey: {
          challenge: b64urlToBuf(ch.challenge),
          rpId: ch.rpId,
          allowCredentials: allow,
          userVerification: 'required',
          timeout: 60000,
        },
      });
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
      const authJ = await authRes.json();
      if (authJ && authJ.ok) {
        location.href = returnPath;
      } else {
        showErr(isEn ? 'Verification failed' : '验证失败');
      }
    } catch (e) {
      /* 用户取消或失败：留在原页 */
      if (e && e.name !== 'NotAllowedError') showErr(isEn ? 'Verification failed' : '验证失败');
    }
  });

  // 密码验证：直接调用 verify，成功后服务端签发 owner 会话
  document.getElementById('sgx-upgrade-pw').addEventListener('click', async () => {
    if (errEl) errEl.hidden = true;
    const pw = window.prompt(isEn ? 'Enter unlock password' : '请输入解锁密码');
    if (!pw) return;
    try {
      const res = await fetch('/api/owner-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', password: pw }),
        credentials: 'include',
      });
      const j = await res.json();
      if (j && j.ok) {
        location.href = returnPath;
      } else {
        showErr(isEn ? 'Wrong password' : '密码错误');
      }
    } catch (e) {
      showErr(isEn ? 'Network error' : '网络错误');
    }
  });
}
