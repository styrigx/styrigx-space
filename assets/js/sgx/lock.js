/**
 * @fileoverview 全站锁屏 + Turnstile 入站验证（2.4.0 H）。
 * - 每个标签页会话首次进站（任意页）先锁屏；通过后 sessionStorage 标记，本次访问不再出现。
 * - 点头像（电脑回车/空格）→ 底部 dialog 验证卡（One UI 密码界面式）+ Turnstile；
 *   通过 → 开锁动画 → 现有解锁流程；失败 → 红色提示 + 重试。
 * - 兜底：Turnstile 脚本失败或 /api/verify 超时（8s）→ 允许直接解锁；
 *   本地开发（localhost）跳过验证。
 * - 2.4.0-G：SGX_FEAT_LEGACY_LOCK_SCREEN / SGX_FEAT_OWNER_GATE 编译期可移除。
 */
import { on } from './events.js';
import { visibleInterval } from './scheduler.js';
import { reducedMotion } from './util.js';
import { get as featGet } from './features.js';

const LOCK =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const UNLOCK =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.9-1"/></svg>';

/**
 * 初始化锁屏（全站；2.4.0 H）。
 */
export function initLock() {
  /* Hark：CI 测试构建禁用锁屏（构建期 define，线上无绕过） */
  if (SGX_TEST_NO_LOCK) return;
  if (!SGX_FEAT_LEGACY_LOCK_SCREEN) return;
  const force = /(?:^|[?&])lock=1(?:&|$)/.test(location.search);
  let seen = false;
  try {
    seen = sessionStorage.getItem('sgx-lock-shown') === '1';
  } catch (e) {}
  if (seen && !force) return;

  const en = document.documentElement.lang === 'en';
  const isLocal = /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);

  /* 天气：和顶栏同一数据来源，取不到就不显示 */
  /** @returns {{icon: string, temp: string}|null} */
  function wxData() {
    try {
      if (!featGet('weather-show')) return null;
    } catch (e) {}
    try {
      if (localStorage.getItem('sgx-weather-show') === '0') return null;
      const c = JSON.parse(localStorage.getItem('sgx-weather') || 'null');
      const d = c && c.data;
      if (!d || !d.current) return null;
      const WXI = {
        0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️', 45: '🌫️', 48: '🌫️', 51: '🌦️', 53: '🌦️',
        55: '🌧️', 61: '🌧️', 63: '🌧️', 65: '🌧️', 71: '🌨️', 73: '🌨️', 75: '❄️',
        80: '🌦️', 81: '🌧️', 82: '⛈️', 95: '⛈️', 96: '⛈️',
      };
      const unit = localStorage.getItem('sgx-temp-unit') === 'f' ? 'f' : 'c';
      let t = d.current.temperature_2m;
      t = unit === 'f' ? Math.round((t * 9) / 5 + 32) : Math.round(t);
      return { icon: WXI[d.current.weather_code] || '☁️', temp: t + '°' };
    } catch (e) {
      return null;
    }
  }

  /* 头像：复用顶栏左侧头像图片 */
  const navImg = /** @type {HTMLImageElement|null} */ (document.querySelector('#nav-brand img'));
  const avatarSrc = navImg ? navImg.src : '';

  const wx = wxData();
  const ov = document.createElement('div');
  ov.id = 'sgx-lock';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', en ? 'Lock screen' : '锁屏');
  ov.innerHTML =
    '<div class="sgx-lock-top" id="sgx-lock-ic">' +
    LOCK +
    '</div>' +
    '<div class="sgx-lock-clockwrap"><div class="sgx-lock-clock" id="sgx-lock-clock">--:--</div>' +
    '<div class="sgx-lock-date"><span id="sgx-lock-date"></span>' +
    (wx
      ? '<span class="sgx-lock-wx"><span aria-hidden="true">' +
        wx.icon +
        '</span><span>' +
        wx.temp +
        '</span></span>'
      : '') +
    '</div></div>' +
    '<div class="sgx-lock-user"><button type="button" id="sgx-lock-avatar" aria-label="' +
    (en ? 'Unlock' : '解锁') +
    '">' +
    '<span class="sgx-lock-halo" aria-hidden="true"></span>' +
    (avatarSrc
      ? '<img src="' + avatarSrc + '" alt="Styrigx" width="72" height="72">'
      : '<span class="sgx-lock-fb" aria-hidden="true">S</span>') +
    '</button><div class="sgx-lock-name">Styrigx</div>' +
    /* 2.4.0 I：验证入口（Hark：owner-gate 控制） */
    (SGX_FEAT_OWNER_GATE
      ? '<div class="sgx-lock-links">' +
        (window.PublicKeyCredential
          ? '<button type="button" id="sgx-lock-pkbtn" class="sgx-lock-pwlink">' +
            (en ? 'Use passkey' : '使用通行密钥') +
            '</button>'
          : '') +
        '<button type="button" id="sgx-lock-pwlink" class="sgx-lock-pwlink">' +
        (en ? 'Use password' : '使用密码') +
        '</button></div>'
      : '') +
    '</div>';
  document.body.appendChild(ov);
  document.body.classList.add('sgx-locked');
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';

  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WDZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  function tick() {
    const d = new Date();
    const c = document.getElementById('sgx-lock-clock');
    if (c) c.textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const de = document.getElementById('sgx-lock-date');
    if (de)
      de.textContent = en
        ? MON[d.getMonth()] + ' ' + d.getDate() + ', ' + WD[d.getDay()]
        : d.getMonth() + 1 + '月' + d.getDate() + '日 ' + WDZH[d.getDay()];
  }
  const stopTick = visibleInterval(tick, 60000);

  let done = false;
  function cleanup() {
    stopTick();
    if (ov.parentNode) ov.parentNode.removeChild(ov);
    document.body.classList.remove('sgx-locked');
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  }
  function unlock() {
    if (done) return;
    done = true;
    try {
      sessionStorage.setItem('sgx-lock-shown', '1');
    } catch (e) {}
    const ic = document.getElementById('sgx-lock-ic');
    if (ic) ic.innerHTML = UNLOCK;
    if (reducedMotion()) {
      ov.style.transition = 'opacity .25s ease';
      ov.style.opacity = '0';
      window.setTimeout(cleanup, 280);
    } else {
      document.body.classList.remove('sgx-locked');
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          ov.classList.add('sgx-lock-out');
        });
      });
      window.setTimeout(cleanup, 450);
    }
  }

  /* ============ Turnstile 验证卡（2.4.0 H） ============ */
  /** @type {HTMLDialogElement|null} */ let vdlg = null;
  /** @type {any} */ let widgetId = null;
  let verifyDone = false;

  function siteKey() {
    try {
      const meta = document.querySelector('meta[name="sgx-turnstile"]');
      if (meta) return meta.getAttribute('content') || '';
    } catch (e) {}
    return '';
  }

  function ensureDialog() {
    if (vdlg) return vdlg;
    const d = document.createElement('dialog');
    d.className = 'sgx-verify-dlg';
    d.setAttribute('aria-labelledby', 'sgx-verify-title');
    d.innerHTML =
      '<div class="sgx-verify-card">' +
      '<div class="sheet-handle" data-vclose></div>' +
      '<h2 id="sgx-verify-title" class="sgx-verify-title">' +
      (en ? 'Verify to unlock' : '验证后解锁') +
      '</h2>' +
      '<div id="sgx-verify-box" class="sgx-verify-box"></div>' +
      '<p id="sgx-verify-err" class="sgx-verify-err" hidden></p>' +
      '</div>';
    document.body.appendChild(d);
    vdlg = /** @type {HTMLDialogElement} */ (d);
    on(d, 'click', function (/** @type {MouseEvent} */ e) {
      if (e.target === d) closeVerify();
      const t = /** @type {Element|null} */ (e.target);
      if (t && t.closest && t.closest('[data-vclose]')) closeVerify();
    });
    on(d, 'cancel', function (/** @type {Event} */ e) {
      e.preventDefault();
      closeVerify();
    });
    return vdlg;
  }

  function closeVerify() {
    if (vdlg && vdlg.open) {
      try { vdlg.close(); } catch (e) {}
    }
  }

  function showError(msg) {
    const err = document.getElementById('sgx-verify-err');
    if (err) {
      err.textContent = msg;
      err.hidden = false;
      if (!reducedMotion()) {
        const card = vdlg && vdlg.querySelector('.sgx-verify-card');
        if (card) {
          card.classList.remove('sgx-shake');
          void /** @type {HTMLElement} */ (card).offsetWidth;
          card.classList.add('sgx-shake');
        }
      }
    }
  }

  function loadTurnstile() {
    return new Promise(function (resolve, reject) {
      if (/** @type {any} */ (window).turnstile) {
        resolve(true);
        return;
      }
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.defer = true;
      const to = window.setTimeout(function () {
        reject(new Error('timeout'));
      }, 8000);
      s.onload = function () {
        window.clearTimeout(to);
        resolve(true);
      };
      s.onerror = function () {
        window.clearTimeout(to);
        reject(new Error('load'));
      };
      document.head.appendChild(s);
    });
  }

  function openVerify() {
    if (verifyDone) {
      unlock();
      return;
    }
    if (isLocal) {
      unlock();
      return;
    }
    if (!SGX_FEAT_OWNER_GATE) {
      unlock();
      return;
    }
    const dlg = ensureDialog();
    const err = document.getElementById('sgx-verify-err');
    if (err) err.hidden = true;
    try { dlg.showModal(); } catch (e) { unlock(); return; }

    const key = siteKey();
    if (!key) {
      closeVerify();
      unlock();
      return;
    }

    try {
      const l = document.createElement('link');
      l.rel = 'preconnect';
      l.href = 'https://challenges.cloudflare.com';
      document.head.appendChild(l);
    } catch (e) {}

    loadTurnstile().then(
      function () {
        const box = document.getElementById('sgx-verify-box');
        if (!box || !(/** @type {any} */ (window).turnstile)) {
          throw new Error('no-box');
        }
        box.innerHTML = '';
        const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
        widgetId = /** @type {any} */ (window).turnstile.render(box, {
          sitekey: key,
          action: 'sgx-entry',
          theme: theme,
          language: en ? 'en' : 'zh-CN',
          callback: function (/** @type {string} */ token) {
            submitToken(token);
          },
          'error-callback': function () {
            showError(en ? 'Verification failed, please retry' : '验证失败，请重试');
            resetWidget();
          },
          'expired-callback': function () {
            showError(en ? 'Verification expired, please retry' : '验证已过期，请重试');
            resetWidget();
          },
        });
      },
      function () {
        const box = document.getElementById('sgx-verify-box');
        if (box) {
          box.innerHTML =
            '<p class="sgx-verify-fallback">' +
            (en ? 'Verification service unavailable' : '验证服务暂不可用') +
            '</p><button type="button" class="sgx-verify-skip" id="sgx-verify-skip">' +
            (en ? 'Unlock directly' : '直接解锁') +
            '</button>';
          const skip = document.getElementById('sgx-verify-skip');
          if (skip) {
            on(skip, 'click', function () {
              closeVerify();
              unlock();
            });
          }
        }
      }
    );
  }

  function resetWidget() {
    try {
      if (widgetId !== null && /** @type {any} */ (window).turnstile) {
        /** @type {any} */ (window).turnstile.reset(widgetId);
      }
    } catch (e) {}
  }

  /** @param {string} token */
  function submitToken(token) {
    const ctrl = new AbortController();
    const to = window.setTimeout(function () {
      ctrl.abort();
    }, 8000);
    fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token }),
      signal: ctrl.signal,
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        window.clearTimeout(to);
        if (j && j.ok) {
          verifyDone = true;
          closeVerify();
          unlock();
        } else {
          showError(en ? 'Verification failed, please retry' : '验证失败，请重试');
          resetWidget();
        }
      })
      .catch(function () {
        window.clearTimeout(to);
        showError(en ? 'Verification service unavailable' : '验证服务暂不可用');
        const box = document.getElementById('sgx-verify-box');
        if (box && !document.getElementById('sgx-verify-skip')) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'sgx-verify-skip';
          b.id = 'sgx-verify-skip';
          b.textContent = en ? 'Unlock directly' : '直接解锁';
          on(b, 'click', function () {
            closeVerify();
            unlock();
          });
          box.appendChild(b);
        }
      });
  }

  /* ============ 密码解锁（2.4.0 I） ============ */
  /** @type {HTMLDialogElement|null} */ let pdlg = null;
  let pwLockedUntil = 0;

  function ensurePwDialog() {
    if (pdlg) return pdlg;
    const d = document.createElement('dialog');
    d.className = 'sgx-verify-dlg';
    d.setAttribute('aria-labelledby', 'sgx-pw-title');
    d.innerHTML =
      '<div class="sgx-verify-card">' +
      '<div class="sheet-handle" data-pclose></div>' +
      '<h2 id="sgx-pw-title" class="sgx-verify-title">' +
      (en ? 'Enter password' : '输入密码') +
      '</h2>' +
      '<input type="password" id="sgx-pw-input" class="sgx-pw-input" autocomplete="current-password" ' +
      'aria-label="' + (en ? 'Password' : '密码') + '">' +
      '<p id="sgx-pw-err" class="sgx-verify-err" hidden></p>' +
      '<p id="sgx-pw-count" class="sgx-pw-count" hidden></p>' +
      '<button type="button" class="sgx-verify-skip" id="sgx-pw-go">' +
      (en ? 'Unlock' : '确定') +
      '</button></div>';
    document.body.appendChild(d);
    pdlg = /** @type {HTMLDialogElement} */ (d);
    on(d, 'click', function (/** @type {MouseEvent} */ e) {
      if (e.target === d) closePw();
      const t = /** @type {Element|null} */ (e.target);
      if (t && t.closest && t.closest('[data-pclose]')) closePw();
    });
    on(d, 'cancel', function (/** @type {Event} */ e) {
      e.preventDefault();
      closePw();
    });
    const input = d.querySelector('#sgx-pw-input');
    const go = d.querySelector('#sgx-pw-go');
    if (input) {
      on(input, 'keydown', function (/** @type {KeyboardEvent} */ e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitPw();
        }
      });
    }
    if (go) on(go, 'click', submitPw);
    return pdlg;
  }

  function closePw() {
    if (pdlg && pdlg.open) {
      try { pdlg.close(); } catch (e) {}
    }
  }

  function pwShowError(msg) {
    const err = document.getElementById('sgx-pw-err');
    if (err) {
      err.textContent = msg;
      err.hidden = false;
      if (!reducedMotion()) {
        const card = pdlg && pdlg.querySelector('.sgx-verify-card');
        if (card) {
          card.classList.remove('sgx-shake');
          void /** @type {HTMLElement} */ (card).offsetWidth;
          card.classList.add('sgx-shake');
        }
      }
    }
  }

  function pwCountdown() {
    const el = document.getElementById('sgx-pw-count');
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('sgx-pw-input'));
    const go = document.getElementById('sgx-pw-go');
    function tickCount() {
      const left = Math.max(0, Math.ceil((pwLockedUntil - Date.now()) / 1000));
      if (left <= 0) {
        if (el) el.hidden = true;
        if (input) input.disabled = false;
        if (go) /** @type {HTMLButtonElement} */ (go).disabled = false;
        return;
      }
      if (el) {
        el.textContent = en
          ? 'Try again in ' + left + 's'
          : left + ' 秒后可再试';
        el.hidden = false;
      }
      if (input) input.disabled = true;
      if (go) /** @type {HTMLButtonElement} */ (go).disabled = true;
      window.setTimeout(tickCount, 1000);
    }
    tickCount();
  }

  function openPw() {
    const dlg = ensurePwDialog();
    const err = document.getElementById('sgx-pw-err');
    if (err) err.hidden = true;
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('sgx-pw-input'));
    if (input) input.value = '';
    try { dlg.showModal(); } catch (e) { return; }
    /* 桌面自动聚焦 */
    if (input) {
      try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (_) {} }
    }
    if (Date.now() < pwLockedUntil) pwCountdown();
  }

  function submitPw() {
    if (Date.now() < pwLockedUntil) return;
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('sgx-pw-input'));
    const pw = input ? input.value : '';
    if (!pw) {
      pwShowError(en ? 'Enter password' : '请输入密码');
      return;
    }
    fetch('/api/owner-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify', password: pw }),
    })
      .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
      .then(function (res) {
        const j = res.j;
        if (j && j.ok) {
          closePw();
          unlock();
        } else if (j && j.error === 'locked') {
          pwLockedUntil = Date.now() + 30000;
          pwShowError(en ? 'Too many attempts' : '尝试次数过多');
          pwCountdown();
        } else if (j && j.error === 'not-set') {
          pwShowError(en ? 'No password set' : '未设置密码');
        } else {
          pwShowError(en ? 'Wrong password' : '密码错误');
          if (input) input.value = '';
        }
      })
      .catch(function () {
        pwShowError(en ? 'Network error' : '网络错误');
      });
  }

  const pwlink = document.getElementById('sgx-lock-pwlink');
  if (pwlink) {
    on(pwlink, 'click', function (e) {
      e.stopPropagation();
      openPw();
    });
  }

  /* ============ 通行密钥解锁（2.4.0 I） ============ */
  const pkbtn = document.getElementById('sgx-lock-pkbtn');
  if (pkbtn && window.PublicKeyCredential) {
    on(pkbtn, 'click', function (e) {
      e.stopPropagation();
      pkAuth();
    });
  }
  /** @returns {Uint8Array} */
  function b64urlToBuf(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  /** @param {ArrayBuffer} buf */
  function bufToB64url(buf) {
    const u8 = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function pkAuth() {
    fetch('/api/owner-passkey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'challenge', type: 'auth' }),
    })
      .then(function (r) { return r.json(); })
      .then(function (ch) {
        if (!ch || !ch.ok) throw new Error('challenge');
        const allow = (ch.allowCredentials || []).map(function (c) {
          return { id: b64urlToBuf(c.id), type: c.type };
        });
        return navigator.credentials.get({
          publicKey: {
            challenge: b64urlToBuf(ch.challenge),
            allowCredentials: allow,
            userVerification: 'preferred',
            timeout: 60000,
          },
        }).then(function (cred) {
          return { cred: cred, cid: ch.cid };
        });
      })
      .then(function (res) {
        const cred = res.cred;
        return fetch('/api/owner-passkey', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'auth',
            cid: res.cid,
            credential: {
              id: cred.id,
              rawId: bufToB64url(cred.rawId),
              response: {
                clientDataJSON: bufToB64url(cred.response.clientDataJSON),
                authenticatorData: bufToB64url(cred.response.authenticatorData),
                signature: bufToB64url(cred.response.signature),
                userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : null,
              },
              type: cred.type,
            },
          }),
        });
      })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) {
          unlock();
        } else {
          /* 失败 → 回退到密码 */
          openPw();
        }
      })
      .catch(function () {
        /* 用户取消或失败 → 回退到密码 */
        openPw();
      });
  }

  const av = document.getElementById('sgx-lock-avatar');
  if (av) {
    on(av, 'click', function (e) {
      e.stopPropagation();
      openVerify();
    });
    try {
      av.focus(/** @type {any} */ ({ preventScroll: true }));
    } catch (e) {
      try {
        av.focus();
      } catch (_) {}
    }
  }
  on(document, 'keydown', function (/** @type {KeyboardEvent} */ e) {
    if (done || !document.getElementById('sgx-lock')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      const t = /** @type {HTMLElement|null} */ (e.target);
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (vdlg && vdlg.open) return;
      e.preventDefault();
      openVerify();
    }
  });
}
