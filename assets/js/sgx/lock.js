/**
 * @fileoverview 全站锁屏 + Turnstile 入站验证（2.4.0 H）。
 * - 每个标签页会话首次进站（任意页）先锁屏；通过后 sessionStorage 标记，本次访问不再出现。
 * - 点头像（电脑回车/空格）→ 底部 dialog 验证卡（One UI 密码界面式）+ Turnstile；
 *   通过 → 开锁动画 → 现有解锁流程；失败 → 红色提示 + 重试。
 * - 本地开发（localhost）跳过验证。
 * - 2.4.0-G：SGX_FEAT_LEGACY_LOCK_SCREEN / SGX_FEAT_OWNER_GATE 编译期可移除。
 * - 安全与隐私：验证/密码/通行密钥三态共用同一个底部弹层组件（圆角、材质、
 *   拖动条、标题字号位置、按钮样式一致）；弹层背景完全不透明；打开时底层
 *   名字与入口设 visibility:hidden + inert；容器无 outline，:focus-visible 只在
 *   内部可交互元素上用本站焦点色。
 * - Turnstile：appearance 'interaction-only' + size 'flexible'，theme/language 跟随；
 *   默认只显示本站加载态，确需交互时才在同一位置出现小组件；成功变勾 0.3s 后解锁；
 *   失败/超时显示普通提示 + 重试，不出现错误码。
 */
import { on } from './events.js';
import { visibleInterval } from './scheduler.js';
import { reducedMotion } from './util.js';
import { get as featGet } from './features.js';

const LOCK =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const UNLOCK =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.9-1"/></svg>';
const CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.5l5 5 10-11"/></svg>';

/**
 * 初始化锁屏（全站；2.4.0 H）。
 */
export function initLock() {
  /* Hark：CI 测试构建禁用锁屏（构建期 define，线上无绕过） */
  if (SGX_TEST_NO_LOCK) return;
  /* Hark：legacy-lock-screen 和 owner-gate 是独立开关；
     只关旧锁屏时，owner-gate（Turnstile/密码）照常工作 */
  if (!SGX_FEAT_LEGACY_LOCK_SCREEN && !SGX_FEAT_OWNER_GATE) return;
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

  /* ============================================================
     统一底部弹层：验证 / 密码 / 通行密钥三态共用同一个 dialog。
     - 同样的圆角、材质、拖动条、标题字号/位置、按钮样式；
     - 卡片背景完全不透明；打开时底层名字与入口 visibility:hidden + inert；
     - 容器无 outline；:focus-visible 只在内部可交互元素上用本站焦点色。
     ============================================================ */
  /** @type {HTMLDialogElement|null} */ let dlg = null;
  /** @type {string|null} */ let dlgState = null;
  /** @type {any} */ let widgetId = null;
  let verifyDone = false;
  let pwLockedUntil = 0;

  function ensureDialog() {
    if (dlg) return dlg;
    const d = document.createElement('dialog');
    d.className = 'sgx-verify-dlg';
    d.setAttribute('aria-labelledby', 'sgx-verify-title');
    d.innerHTML =
      '<div class="sgx-verify-card">' +
      '<div class="sheet-handle" data-dclose aria-hidden="true"></div>' +
      '<h2 id="sgx-verify-title" class="sgx-verify-title"></h2>' +
      '<div id="sgx-verify-body" class="sgx-verify-body"></div>' +
      '<p id="sgx-verify-err" class="sgx-verify-err" hidden></p>' +
      '</div>';
    document.body.appendChild(d);
    dlg = /** @type {HTMLDialogElement} */ (d);
    on(d, 'click', function (/** @type {MouseEvent} */ e) {
      const t = /** @type {Element|null} */ (e.target);
      if (e.target === d) closeDialog();
      else if (t && t.closest && t.closest('[data-dclose]')) closeDialog();
    });
    on(d, 'cancel', function (/** @type {Event} */ e) {
      e.preventDefault();
      closeDialog();
    });
    return dlg;
  }

  /** @param {string} txt */
  function setTitle(txt) {
    ensureDialog();
    const el = document.getElementById('sgx-verify-title');
    if (el) el.textContent = txt;
  }
  /** @param {string} html */
  function setBody(html) {
    ensureDialog();
    const el = document.getElementById('sgx-verify-body');
    if (el) el.innerHTML = html;
  }
  function clearErr() {
    ensureDialog();
    const err = document.getElementById('sgx-verify-err');
    if (err) err.hidden = true;
  }
  /** @param {string} msg */
  function showError(msg) {
    const err = document.getElementById('sgx-verify-err');
    if (err) {
      err.textContent = msg;
      err.hidden = false;
      if (!reducedMotion()) {
        const card = dlg && dlg.querySelector('.sgx-verify-card');
        if (card) {
          card.classList.remove('sgx-shake');
          void /** @type {HTMLElement} */ (card).offsetWidth;
          card.classList.add('sgx-shake');
        }
      }
    }
  }

  /* 底层元素：弹层打开时隐藏并 inert，关闭时恢复 */
  /** @param {boolean} hidden */
  function setBgHidden(hidden) {
    const sels = ['.sgx-lock-name', '.sgx-lock-links'];
    for (let i = 0; i < sels.length; i++) {
      const el = document.querySelector(sels[i]);
      if (el) {
        el.classList.toggle('sgx-bg-hidden', hidden);
        try {
          /** @type {any} */ (el).inert = hidden;
        } catch (e) {}
      }
    }
  }

  /* 头像淡出避让：弹层打开时淡出，关闭时恢复（One UI 式） */
  function liftAvatar() {
    try {
      document.body.classList.add('sgx-dlg-open');
    } catch (e) {}
  }
  function resetAvatar() {
    try {
      document.body.classList.remove('sgx-dlg-open');
    } catch (e) {}
  }

  function openDialog() {
    const d = ensureDialog();
    clearErr();
    setBgHidden(true);
    try {
      d.showModal();
    } catch (e) {
      setBgHidden(false);
      return false;
    }
    /* 卡片高度稳定后（body 有 min-height）再量，避免跳动 */
    requestAnimationFrame(function () {
      liftAvatar();
    });
    return true;
  }

  function closeDialog() {
    resetAvatar();
    setBgHidden(false);
    if (dlg && dlg.open) {
      try {
        dlg.close();
      } catch (e) {}
    }
    dlgState = null;
  }

  /* ---------- Turnstile ---------- */
  function siteKey() {
    try {
      const meta = document.querySelector('meta[name="sgx-turnstile"]');
      if (meta) return meta.getAttribute('content') || '';
    } catch (e) {}
    return '';
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

  /* 验证态：加载中 */
  function verifyLoading() {
    dlgState = 'verify';
    setTitle(en ? "Checking you're human" : '正在确认你不是机器人');
    setBody(
      '<div class="sgx-verify-loading"><div class="sgx-spinner" role="progressbar" aria-label="' +
        (en ? 'Verifying' : '正在验证') +
        '"></div><p class="sgx-verify-loading-tx">' +
        (en ? 'Verifying…' : '正在验证…') +
        '</p></div><div id="sgx-ts-wrap" class="sgx-ts-wrap" hidden></div>'
    );
    clearErr();
  }

  /* 验证态：需要交互 → 在同一位置显示小组件 */
  function verifyInteractive() {
    const wrap = document.getElementById('sgx-ts-wrap');
    const loading = dlg && dlg.querySelector('.sgx-verify-loading');
    if (loading) /** @type {HTMLElement} */ (loading).hidden = true;
    if (wrap) wrap.hidden = false;
    liftAvatar();
  }

  /* 验证态：成功 → 变勾，0.3s 后解锁 */
  function verifySuccess() {
    setBody('<div class="sgx-verify-loading"><div class="sgx-check">' + CHECK + '</div></div>');
    clearErr();
    window.setTimeout(function () {
      verifyDone = true;
      closeDialog();
      unlock();
    }, 300);
  }

  /* 验证态：失败/超时 → 普通提示 + 重试，不出现错误码 */
  function verifyFailed() {
    setBody(
      '<div class="sgx-verify-loading"><p class="sgx-verify-failtx">' +
        (en ? 'Verification failed' : '验证失败') +
        '</p><button type="button" class="sgx-verify-skip" id="sgx-verify-retry">' +
        (en ? 'Retry' : '重试') +
        '</button></div>'
    );
    const retry = document.getElementById('sgx-verify-retry');
    if (retry) {
      on(retry, 'click', function () {
        startVerify();
      });
      try {
        retry.focus({ preventScroll: true });
      } catch (e) {}
    }
    liftAvatar();
  }

  function resetWidget() {
    try {
      if (widgetId !== null && /** @type {any} */ (window).turnstile) {
        /** @type {any} */ (window).turnstile.reset(widgetId);
      }
    } catch (e) {}
    widgetId = null;
  }

  function startVerify() {
    resetWidget();
    verifyLoading();
    loadTurnstile().then(
      function () {
        const wrap = document.getElementById('sgx-ts-wrap');
        if (!wrap || !(/** @type {any} */ (window).turnstile)) {
          verifyFailed();
          return;
        }
        const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
        widgetId = /** @type {any} */ (window).turnstile.render(wrap, {
          sitekey: siteKey(),
          action: 'sgx-entry',
          appearance: 'interaction-only',
          size: 'flexible',
          theme: theme,
          language: en ? 'en' : 'zh-CN',
          'before-interactive-callback': function () {
            verifyInteractive();
          },
          'after-interactive-callback': function () {
            /* 用户完成交互，等待 callback；保持小组件可见 */
          },
          callback: function (/** @type {string} */ token) {
            submitToken(token);
          },
          'error-callback': function () {
            verifyFailed();
          },
          'expired-callback': function () {
            verifyFailed();
          },
          'timeout-callback': function () {
            verifyFailed();
          },
        });
      },
      function () {
        verifyFailed();
      }
    );
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
    if (!siteKey()) {
      unlock();
      return;
    }
    if (!openDialog()) {
      unlock();
      return;
    }
    try {
      const l = document.createElement('link');
      l.rel = 'preconnect';
      l.href = 'https://challenges.cloudflare.com';
      document.head.appendChild(l);
    } catch (e) {}
    startVerify();
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
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        window.clearTimeout(to);
        if (j && j.ok) {
          verifySuccess();
        } else {
          verifyFailed();
        }
      })
      .catch(function () {
        window.clearTimeout(to);
        verifyFailed();
      });
  }

  /* ---------- 密码态（与验证态同一弹层） ---------- */
  function openPw() {
    dlgState = 'password';
    setTitle(en ? 'Enter password' : '输入密码');
    setBody(
      '<div class="sgx-pw-field"><input type="password" id="sgx-pw-input" class="sgx-pw-input" autocomplete="current-password" ' +
        'aria-label="' + (en ? 'Password' : '密码') + '" placeholder="' + (en ? 'Password' : '密码') + '">' +
        '<button type="button" class="sgx-pw-eye" id="sgx-pw-eye" aria-label="' + (en ? 'Show' : '显示') + '"></button></div>' +
        '<p id="sgx-pw-count" class="sgx-pw-count" hidden></p>' +
        '<button type="button" class="sgx-verify-skip" id="sgx-pw-go">' + (en ? 'Unlock' : '确定') + '</button>'
    );
    clearErr();
    if (!openDialog()) return;
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('sgx-pw-input'));
    const eye = document.getElementById('sgx-pw-eye');
    const go = document.getElementById('sgx-pw-go');
    if (eye && input) {
      eye.innerHTML =
        '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
      on(eye, 'click', function () {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        eye.setAttribute('aria-label', show ? (en ? 'Hide' : '隐藏') : (en ? 'Show' : '显示'));
        eye.classList.toggle('off', !show);
      });
    }
    if (input) {
      on(input, 'keydown', function (/** @type {KeyboardEvent} */ e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitPw();
        }
      });
      try {
        input.focus({ preventScroll: true });
      } catch (e) {
        try {
          input.focus();
        } catch (_) {}
      }
    }
    if (go) on(go, 'click', submitPw);
    if (Date.now() < pwLockedUntil) pwCountdown();
  }

  function pwCountdown() {
    const el = document.getElementById('sgx-pw-count');
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('sgx-pw-input'));
    const go = document.getElementById('sgx-pw-go');
    function tickCount() {
      if (dlgState !== 'password') return;
      const left = Math.max(0, Math.ceil((pwLockedUntil - Date.now()) / 1000));
      if (left <= 0) {
        if (el) el.hidden = true;
        if (input) input.disabled = false;
        if (go) /** @type {HTMLButtonElement} */ (go).disabled = false;
        return;
      }
      if (el) {
        el.textContent = en ? 'Try again in ' + left + 's' : left + ' 秒后可再试';
        el.hidden = false;
      }
      if (input) input.disabled = true;
      if (go) /** @type {HTMLButtonElement} */ (go).disabled = true;
      window.setTimeout(tickCount, 1000);
    }
    tickCount();
  }

  function submitPw() {
    if (dlgState !== 'password') return;
    if (Date.now() < pwLockedUntil) return;
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('sgx-pw-input'));
    const pw = input ? input.value : '';
    if (!pw) {
      showError(en ? 'Enter password' : '请输入密码');
      return;
    }
    fetch('/api/owner-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify', password: pw }),
    })
      /* 区分网络错误（fetch 抛错）/ 服务器错误（非 JSON 响应）/ 业务错误 */
      .then(function (r) {
        return r.text().then(function (t) {
          let j = null;
          try {
            j = JSON.parse(t);
          } catch (e) {}
          return { s: r.status, j: j };
        });
      })
      .then(function (res) {
        if (dlgState !== 'password') return;
        const j = res.j;
        if (!j) {
          showError(en ? 'Server error' : '服务器错误');
          return;
        }
        if (j.ok) {
          closeDialog();
          unlock();
        } else if (j.error === 'locked') {
          pwLockedUntil = Date.now() + 30000;
          showError(en ? 'Too many attempts' : '尝试次数过多');
          pwCountdown();
        } else if (j.error === 'not-set') {
          showError(en ? 'No password set yet' : '尚未设置密码');
        } else if (j.error === 'server') {
          showError(en ? 'Server error' : '服务器错误');
        } else {
          showError(en ? 'Wrong password' : '密码错误');
          if (input) input.value = '';
        }
      })
      .catch(function () {
        if (dlgState !== 'password') return;
        showError(en ? 'Network error' : '网络错误');
      });
  }

  /* ---------- 通行密钥态（与验证态同一弹层） ---------- */
  function openPk() {
    dlgState = 'passkey';
    setTitle(en ? 'Use passkey' : '使用通行密钥');
    setBody(
      '<div class="sgx-verify-loading"><div class="sgx-spinner" role="progressbar" aria-label="' +
        (en ? 'Verifying' : '正在验证') +
        '"></div><p class="sgx-verify-loading-tx">' +
        (en ? 'Verifying passkey…' : '正在验证通行密钥…') +
        '</p></div>'
    );
    clearErr();
    if (!openDialog()) return;
    pkAuth();
  }

  /* 通行密钥失败 → 同一弹层内给重试 / 用密码 */
  function pkFailed() {
    if (dlgState !== 'passkey') return;
    setBody(
      '<div class="sgx-verify-loading"><p class="sgx-verify-failtx">' +
        (en ? 'Passkey verification failed' : '通行密钥验证失败') +
        '</p><div class="sgx-verify-actions">' +
        '<button type="button" class="sgx-verify-skip" id="sgx-pk-retry">' + (en ? 'Retry' : '重试') + '</button>' +
        '<button type="button" class="sgx-verify-ghost" id="sgx-pk-topw">' + (en ? 'Use password' : '使用密码') + '</button>' +
        '</div></div>'
    );
    const retry = document.getElementById('sgx-pk-retry');
    const topw = document.getElementById('sgx-pk-topw');
    if (retry) on(retry, 'click', openPk);
    if (topw) on(topw, 'click', openPw);
    liftAvatar();
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
      .then(function (r) {
        return r.json();
      })
      .then(function (ch) {
        if (dlgState !== 'passkey') throw { done: true };
        if (!ch || !ch.ok) throw new Error('challenge');
        const allow = (ch.allowCredentials || []).map(function (c) {
          return { id: b64urlToBuf(c.id), type: c.type };
        });
        return navigator.credentials
          .get({
            publicKey: {
              challenge: b64urlToBuf(ch.challenge),
              allowCredentials: allow,
              userVerification: 'preferred',
              timeout: 60000,
            },
          })
          .then(function (cred) {
            return { cred: cred, cid: ch.cid };
          });
      })
      .then(function (res) {
        if (dlgState !== 'passkey') throw { done: true };
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
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (dlgState !== 'passkey') return;
        if (j && j.ok) {
          closeDialog();
          unlock();
        } else {
          /* 服务端不认识这把密钥 → 通知密码管理器删掉 */
          try {
            if (j && j.error === 'unknown-key' && window.PublicKeyCredential &&
                typeof PublicKeyCredential.signalUnknownCredential === 'function') {
              PublicKeyCredential.signalUnknownCredential({
                rpId: location.hostname,
                credentialId: cred.id,
              }).catch(function () {});
            }
          } catch (e) {}
          pkFailed();
        }
      })
      .catch(function (e) {
        if (e && e.done) return;
        pkFailed();
      });
  }

  /* ---------- 入口接线 ---------- */
  const pwlink = document.getElementById('sgx-lock-pwlink');
  if (pwlink) {
    on(pwlink, 'click', function (e) {
      e.stopPropagation();
      openPw();
    });
  }
  const pkbtn = document.getElementById('sgx-lock-pkbtn');
  if (pkbtn && window.PublicKeyCredential) {
    on(pkbtn, 'click', function (e) {
      e.stopPropagation();
      openPk();
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
      if (dlg && dlg.open) return;
      e.preventDefault();
      openVerify();
    }
  });
}
