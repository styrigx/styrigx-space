/**
 * @fileoverview 安全与隐私页。
 * - 三个入口（访客与站长看到完全一样）：站长凭证、管理凭证、立即锁定。
 * - 站长凭证 → 弹层「需要验证」→ 单个「根凭证」按钮 → /api/root-auth。
 *   访客会话下为假入口（服务端写死 401），UI 与真入口完全一致。
 * - 管理凭证 → 弹层「需要凭证」→ 按钮按站长凭证配置（/api/owner-status）：
 *   未设置→根凭证；仅通行密钥→通行密钥验证；仅密码→密码验证；两者都有→两个按钮。
 * - 立即锁定：调服务端 /api/lock 清除会话 cookie 后重载，回到锁屏。
 * - 从 /api/owner-status（需鉴权）读取只读状态，渲染状态卡片（访客不调用）。
 * - localStorage 统一走 storage.js。
 */
import { on } from '../lib/events.js';
import { get as storeGet } from '../lib/storage.js';
import { toast } from '../lib/toast.js';
import { mgmtButtons } from './mgmt-buttons.js';

(function () {
  const en = document.documentElement.lang === 'en';
  /** @type {any} */
  let T = {};
  try {
    T = JSON.parse(document.getElementById('sgx-i18n-security').textContent || '{}');
  } catch (e) {}
  /** @param {string} k */
  function t(k) {
    const v = T[k];
    if (v && typeof v === 'object') return en ? v.en : v.zh;
    return v || k;
  }

  const lockUrl = en ? '/en/settings/security/lock/' : '/settings/security/lock/';

  const card = document.getElementById('sec-status');
  const cardTitle = document.getElementById('sec-status-title');
  const cardSub = document.getElementById('sec-status-sub');

  /**
   * 渲染状态。
   * @param {boolean} hasPw
   * @param {boolean} hasPk
   */
  function render(hasPw, hasPk) {
    if (card) {
      card.hidden = false;
      card.classList.toggle('is-ok', hasPw && hasPk);
      card.classList.toggle('is-warn', !(hasPw && hasPk));
    }
    if (hasPw && hasPk) {
      if (cardTitle) cardTitle.textContent = t('okTitle');
      if (cardSub) cardSub.textContent = t('okSub');
    } else {
      if (cardTitle) cardTitle.textContent = t('warnTitle');
      const miss = [];
      if (!hasPw) miss.push(t('missPw'));
      if (!hasPk) miss.push(t('missPk'));
      if (cardSub) cardSub.textContent = miss.join('，');
    }
  }

  /** @param {boolean} [silent] */
  function refresh(silent) {
    /* 访客不再调用 /api/owner-status（接口已加鉴权，访客 401）；状态卡片保持隐藏。 */
    try {
      if (document.documentElement.dataset.sgxRole === 'visitor') return;
    } catch (e) {}
    fetch('/api/owner-status', { method: 'GET', credentials: 'same-origin' })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (j && j.ok) {
          render(!!j.password, !!j.passkey);
          if (!silent) toast(t('refreshToast'));
        } else {
          throw new Error('bad');
        }
      })
      .catch(function () {
        /* 读取失败：保持现状 */
      });
  }

  /* 立即锁定：调服务端清除 sgx-verified，然后重载 → 锁屏出现。
     访客和站长都能用，不设限。 */
  const lockNow = document.getElementById('sec-locknow');
  if (lockNow) {
    const go = function () {
      fetch('/api/lock', { method: 'POST', credentials: 'include' })
        .then(function () {
          location.reload();
        })
        .catch(function () {
          location.reload();
        });
    };
    on(lockNow, 'click', go);
    on(lockNow, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
  }

  const more = document.getElementById('sec-more');
  if (more) {
    on(more, 'click', function () {
      refresh(false);
    });
  }

  /* 重置所有设置入口：跳回设置页关于分组（由设置页处理二次确认） */
  const resetLink = document.getElementById('sec-reset-link');
  if (resetLink) {
    on(resetLink, 'click', function () {
      try {
        storeGet('sgx-set-recent');
      } catch (e) {}
    });
  }

  /* ============ 入口 1：站长凭证 ============
     弹层标题「需要验证」，单个「根凭证」按钮。
     点击 → 显示根凭证输入框 → POST /api/root-auth → 成功则进入管理页。
     访客会话下服务端为假入口（写死 401），UI 完全一致。 */
  (function () {
    const row = document.getElementById('sec-owner-cred');
    const dlg = document.getElementById('sec-owner-dlg');
    const opts = document.getElementById('sec-owner-opts');
    const keyform = document.getElementById('sec-owner-keyform');
    const input = document.getElementById('sec-owner-input');
    const err = document.getElementById('sec-owner-err');
    const goBtn = document.getElementById('sec-owner-go');
    const backBtn = document.getElementById('sec-owner-back');
    const rootBtn = document.getElementById('sec-owner-root');
    if (!row || !dlg) return;

    function showErr(msg) {
      if (err) {
        err.textContent = msg;
        err.hidden = false;
      }
    }
    function hideErr() {
      if (err) err.hidden = true;
    }
    function showOpts() {
      if (opts) opts.hidden = false;
      if (keyform) keyform.hidden = true;
      hideErr();
    }
    function showKeyform() {
      if (opts) opts.hidden = true;
      if (keyform) keyform.hidden = false;
      hideErr();
      if (input) {
        input.value = '';
        try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (_) {} }
      }
    }

    function openDlg() {
      showOpts();
      if (typeof dlg.showModal === 'function') {
        try { dlg.showModal(); } catch (e) {}
      }
    }
    function closeDlg() {
      try { dlg.close(); } catch (e) {}
    }

    function submitRoot() {
      const key = input ? input.value : '';
      hideErr();
      if (!key) {
        showErr(en ? 'Enter root credential' : '请输入根凭证');
        return;
      }
      fetch('/api/root-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key }),
        credentials: 'same-origin',
      })
        .then(function (r) {
          return r.json().then(function (j) { return { s: r.status, j: j }; });
        })
        .then(function (res) {
          const j = res.j;
          if (j && j.ok) {
            closeDlg();
            location.href = lockUrl;
          } else if (res.s === 429) {
            showErr(en ? 'Too many attempts' : '尝试次数过多');
          } else {
            /* 401 auth（含访客假入口）：统一提示密码错误 */
            showErr(en ? 'Wrong password' : '密码错误');
            if (input) input.value = '';
          }
        })
        .catch(function () {
          showErr(en ? 'Network error' : '网络错误');
        });
    }

    on(row, 'click', openDlg);
    on(row, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDlg();
      }
    });
    if (rootBtn) on(rootBtn, 'click', showKeyform);
    if (goBtn) on(goBtn, 'click', submitRoot);
    if (input) {
      on(input, 'keydown', function (/** @type {KeyboardEvent} */ e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitRoot();
        }
      });
    }
    if (backBtn) on(backBtn, 'click', showOpts);
    dlg.addEventListener('click', function (e) {
      if (e.target === dlg) closeDlg();
    });
  })();

  /* ============ 入口 2：管理凭证 ============
     弹层标题「需要凭证」，按钮按站长凭证配置（/api/owner-status）：
     - 什么都没设置 → 只显示「根凭证」
     - 只设了通行密钥 → 「通行密钥验证」
     - 只设了密码 → 「密码验证」
     - 两个都设了 → 两个都显示，不显示根凭证
     补充定稿七.2：访客会话下为假入口——弹层固定为标题「需要凭证」、
     只有「根凭证」一个按钮，不读站长凭证配置；服务端（/api/root-auth
     访客假入口）写死返回密码错误，不读 D1/KV/环境变量凭证，不计 rootlimit、
     不写审计，固定延迟。 */
  (function () {
    const row = document.getElementById('sec-mgmt-cred');
    const dlg = document.getElementById('sec-mgmt-dlg');
    const opts = document.getElementById('sec-mgmt-opts');
    const keyform = document.getElementById('sec-mgmt-keyform');
    const input = document.getElementById('sec-mgmt-input');
    const err = document.getElementById('sec-mgmt-err');
    const goBtn = document.getElementById('sec-mgmt-go');
    const backBtn = document.getElementById('sec-mgmt-back');
    if (!row || !dlg || !opts) return;

    /** 当前选择的验证方式：'root' | 'password' */
    let mode = 'root';

    function showErr(msg) {
      if (err) {
        err.textContent = msg;
        err.hidden = false;
      }
    }
    function hideErr() {
      if (err) err.hidden = true;
    }

    function renderOpts(hasPw, hasPk) {
      opts.innerHTML = '';
      hideErr();
      if (keyform) keyform.hidden = true;
      opts.hidden = false;

      const mkBtn = function (id, label, cb) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sec-sheet-opt';
        b.id = id;
        b.textContent = label;
        on(b, 'click', cb);
        opts.appendChild(b);
        return b;
      };

      /* 按钮决策走纯函数 mgmtButtons（可测试），与 /api/owner-status 的语义对齐 */
      const buttons = mgmtButtons(hasPw, hasPk);
      for (const kind of buttons) {
        if (kind === 'root') {
          /* 什么都没设置 → 只显示「根凭证」 */
          mkBtn('sec-mgmt-root', en ? 'Root credential' : '根凭证', function () {
            mode = 'root';
            showKeyform(en ? 'Root credential' : '根凭证');
          });
        } else if (kind === 'passkey') {
          /* 通行密钥验证 → stepup */
          mkBtn('sec-mgmt-pk', en ? 'Verify with passkey' : '通行密钥验证', doPasskeyStepup);
        } else if (kind === 'password') {
          /* 密码验证 → stepup verify-password */
          mkBtn('sec-mgmt-pw', en ? 'Verify with password' : '密码验证', function () {
            mode = 'password';
            showKeyform(en ? 'Password' : '密码');
          });
        }
      }
      /* 两个都设了时不显示根凭证（mgmtButtons 已保证） */
    }

    function showKeyform(placeholder) {
      opts.hidden = true;
      if (keyform) keyform.hidden = false;
      hideErr();
      if (input) {
        input.value = '';
        input.placeholder = placeholder || '';
        try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (_) {} }
      }
    }
    function showOpts() {
      if (keyform) keyform.hidden = true;
      opts.hidden = false;
      hideErr();
    }

    function openDlg() {
      /* 补充定稿七.2：访客会话下为假入口——固定单个「根凭证」按钮，
         不读站长凭证配置（角色由服务端注入的 data-sgx-role 提供，UI 展示用）。 */
      var isVisitor = false;
      try {
        isVisitor = document.documentElement.dataset.sgxRole === 'visitor';
      } catch (e) {}
      if (isVisitor) {
        renderOpts(false, false);
      } else {
        /* 每次打开时重新读取配置（/api/owner-status 已加鉴权，只看站长密码 +
           class=owner 通行密钥）。读取失败显示错误，不退回根凭证。 */
        fetch('/api/owner-status', { method: 'GET', credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j && j.ok) {
              renderOpts(!!j.password, !!j.passkey);
            } else {
              throw new Error('bad');
            }
          })
          .catch(function () {
            /* 读取失败：显示错误，不退回根凭证（避免显示必然失败的按钮） */
            opts.innerHTML = '';
            if (keyform) keyform.hidden = true;
            opts.hidden = false;
            showErr(en ? 'Failed to load configuration' : '读取配置失败，请重试');
          });
      }
      if (typeof dlg.showModal === 'function') {
        try { dlg.showModal(); } catch (e) {}
      }
    }
    function closeDlg() {
      try { dlg.close(); } catch (e) {}
    }

    function submitKeyform() {
      const key = input ? input.value : '';
      hideErr();
      if (!key) {
        showErr(en ? 'Enter credential' : '请输入凭证');
        return;
      }
      if (mode === 'root') {
        /* 根凭证 → /api/root-auth */
        fetch('/api/root-auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: key }),
          credentials: 'same-origin',
        })
          .then(function (r) {
            return r.json().then(function (j) { return { s: r.status, j: j }; });
          })
          .then(function (res) {
            const j = res.j;
            if (j && j.ok) {
              closeDlg();
              location.href = lockUrl;
            } else if (res.s === 429) {
              showErr(en ? 'Too many attempts' : '尝试次数过多');
            } else {
              showErr(en ? 'Wrong password' : '密码错误');
              if (input) input.value = '';
            }
          })
          .catch(function () {
            showErr(en ? 'Network error' : '网络错误');
          });
      } else {
        /* 密码 → /api/stepup verify-password */
        fetch('/api/stepup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'verify-password', password: key }),
          credentials: 'same-origin',
        })
          .then(function (r) {
            return r.json().then(function (j) { return { s: r.status, j: j }; });
          })
          .then(function (res) {
            const j = res.j;
            if (j && j.ok) {
              closeDlg();
              location.href = lockUrl;
            } else {
              showErr(en ? 'Wrong password' : '密码错误');
              if (input) input.value = '';
            }
          })
          .catch(function () {
            showErr(en ? 'Network error' : '网络错误');
          });
      }
    }

    function doPasskeyStepup() {
      hideErr();
      if (!window.PublicKeyCredential) {
        showErr(en ? 'Passkey not supported' : '不支持通行密钥');
        return;
      }
      /* 先拿 challenge，再调 WebAuthn，最后 verify */
      fetch('/api/stepup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'challenge' }),
        credentials: 'same-origin',
      })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.ok || !j.challenge) throw new Error('challenge');
          const chal = Uint8Array.from(atob(j.challenge.replace(/-/g, '+').replace(/_/g, '/')), function (c) { return c.charCodeAt(0); });
          const allow = (j.allowCredentials || []).map(function (c) {
            return {
              type: 'public-key',
              id: Uint8Array.from(atob(c.id.replace(/-/g, '+').replace(/_/g, '/')), function (x) { return x.charCodeAt(0); }),
            };
          });
          return navigator.credentials.get({
            publicKey: {
              challenge: chal,
              rpId: j.rpId,
              allowCredentials: allow.length ? allow : undefined,
              userVerification: 'required',
            },
          }).then(function (cred) {
            return { cred: cred, cid: j.cid };
          });
        })
        .then(function (r) {
          const cred = r.cred;
          const authResp = {
            id: cred.id,
            rawId: btoa(String.fromCharCode.apply(null, new Uint8Array(cred.rawId))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
            type: cred.type,
            response: {
              authenticatorData: btoa(String.fromCharCode.apply(null, new Uint8Array(cred.response.authenticatorData))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
              clientDataJSON: btoa(String.fromCharCode.apply(null, new Uint8Array(cred.response.clientDataJSON))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
              signature: btoa(String.fromCharCode.apply(null, new Uint8Array(cred.response.signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
              userHandle: cred.response.userHandle ? btoa(String.fromCharCode.apply(null, new Uint8Array(cred.response.userHandle))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null,
            },
          };
          return fetch('/api/stepup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'verify', cid: r.cid, credential: authResp }),
            credentials: 'same-origin',
          });
        })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.ok) {
            closeDlg();
            location.href = lockUrl;
          } else {
            showErr(en ? 'Verification failed' : '验证失败');
          }
        })
        .catch(function () {
          showErr(en ? 'Verification failed' : '验证失败');
        });
    }

    on(row, 'click', openDlg);
    on(row, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDlg();
      }
    });
    if (goBtn) on(goBtn, 'click', submitKeyform);
    if (input) {
      on(input, 'keydown', function (/** @type {KeyboardEvent} */ e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitKeyform();
        }
      });
    }
    if (backBtn) on(backBtn, 'click', showOpts);
    dlg.addEventListener('click', function (e) {
      if (e.target === dlg) closeDlg();
    });
  })();

  refresh(true);
})();
