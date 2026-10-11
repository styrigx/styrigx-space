/**
 * @fileoverview 全站锁屏 + Turnstile 入站验证（2.4.0 H）。
 * 分层规范 L4：lock.js 只负责两件事——
 * 1. 按 L1（middleware 注入的 <html data-sgx-session>）画锁屏，不自己判断会话；
 * 2. 把密码或通行密钥提交给 L2（functions/api/*）。
 * 唯一状态源是服务端签发的 sgx-verified 会话；禁止用 sessionStorage、
 * localStorage、前端内存或标签页状态另做判断。
 * - 点头像（电脑回车/空格）→ 底部 dialog 验证卡（One UI 密码界面式）+ Turnstile；
 *   通过 → 开锁动画 → 现有解锁流程；失败 → 红色提示 + 重试。
 * - 本地开发（localhost）跳过验证。
 * - 安全与隐私：验证/密码/通行密钥三态共用同一个底部弹层组件（圆角、材质、
 *   拖动条、标题字号位置、按钮样式一致）；弹层背景完全不透明；打开时底层
 *   名字与入口设 visibility:hidden + inert；容器无 outline，:focus-visible 只在
 *   内部可交互元素上用本站焦点色。
 * - Turnstile：appearance 'interaction-only' + size 'flexible'，theme/language 跟随；
 *   默认只显示本站加载态，确需交互时才在同一位置出现小组件；成功变勾 0.3s 后解锁；
 *   失败/超时显示普通提示 + 重试，不出现错误码。
 */
import { on } from '../lib/events.js';
import { visibleInterval } from '../lib/scheduler.js';
import { reducedMotion } from '../lib/util.js';
import { get as featGet } from '../lib/features.js';

const LOCK =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const UNLOCK =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.9-1"/></svg>';
const CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.5l5 5 10-11"/></svg>';

/**
 * 是否本地开发（无 Functions 后端）。
 * 测试可用 ?test-no-local-bypass=1 强制走线上逻辑（调 session-check）。
 */
function isLocalDev() {
  try {
    if (new URLSearchParams(location.search).has('test-no-local-bypass')) return false;
  } catch (e) {}
  return /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
}

/**
 * 初始化锁屏（全站；2.4.0 H）。
 */
export function initLock() {
  /* Hark：CI 测试构建禁用锁屏（构建期 define，线上无绕过） */
  if (SGX_TEST_NO_LOCK) return;
  /* 2.8.0：legacy-lock-screen 已彻底删除，只剩 owner-gate 开关 */
  if (!SGX_FEAT_OWNER_GATE) return;
  const isLocal = isLocalDev();
  if (isLocal) {
    /* 本地开发没有 Functions 后端，直接显示锁屏 */
    showLockScreen();
    return;
  }
  /* 分层规范 L4：lock.js 只按 L1 给出的状态画锁屏，不自己判断。
     L1（middleware）把会话状态注入 <html data-sgx-session="valid|locked">，
     这里只读这个。 */
  const state = document.documentElement.dataset.sgxSession;
  const ok = state === 'valid';
  try {
    window.dispatchEvent(new CustomEvent('sgx:session', { detail: { ok: ok } }));
  } catch (e) {}
  if (!ok) {
    showLockScreen();
  }
  /* 会话有效：直接显示页面，不弹锁屏 */
}

/**
 * 显示锁屏 UI（2.4.0 H）。
 */
function showLockScreen() {
  const en = document.documentElement.lang === 'en';
  const isLocal = isLocalDev();

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
    (en ? 'Unlock, choose method' : '解锁，选择方式') +
    '" aria-haspopup="dialog">' +
    '<span class="sgx-lock-halo" aria-hidden="true"></span>' +
    (avatarSrc
      ? '<img src="' + avatarSrc + '" alt="Styrigx" width="72" height="72">'
      : '<span class="sgx-lock-fb" aria-hidden="true">S</span>') +
    '</button>' +
    /* 2.8.0 锁屏重设计：只保留头像，删掉「Styrigx」文字；
       「使用通行密钥」「使用密码」改成点击头像后弹底部选单 */
    '</div>';
  document.body.appendChild(ov);
  document.body.classList.add('sgx-locked');
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';

  /* 2.8.0：锁屏显示时预加载 Turnstile（用户点验证时已就绪） */
  preloadTurnstile();

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
    /* 本地开发没有 Functions 后端，直接确认（生产环境才调 session-check） */
    if (isLocal) {
      handleSessionOk();
      return;
    }
    /* 2.4.1 防循环：先向服务端确认会话真的生效（/api/session-check），
       确认后才处理；没确认到 → 停在锁屏显示错误，绝不跳转。 */
    fetch('/api/session-check', { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) return { ok: false };
        return r.json().catch(function () {
          return { ok: false };
        });
      })
      .then(function (d) {
        if (d && d.ok === true) {
          handleSessionOk();
        } else {
          sessionCheckFailed();
        }
      })
      .catch(function () {
        sessionCheckFailed();
      });
  }

  /* 2.4.1 回跳修复：锁屏显示期间，用户可能在别的标签页解锁了。
     在 visibilitychange（visible）、focus、pageshow 时调 /api/session-check；
     节流至少 1 秒，和密码/通行密钥解锁共用 done 标志。
     ok → 走 handleSessionOk；401/网络失败 → 保持锁屏（fail-closed）。
     禁止用 sessionStorage、localStorage、跨标签页通道或前端内存传递
     解锁状态，状态源只有服务端 sgx-verified。 */
  let lastRecheck = 0;
  function recheckSession() {
    if (done) return;
    const now = Date.now();
    if (now - lastRecheck < 1000) return;
    lastRecheck = now;
    if (isLocal) return;
    fetch('/api/session-check', { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) return { ok: false };
        return r.json().catch(function () {
          return { ok: false };
        });
      })
      .then(function (d) {
        if (done) return;
        if (d && d.ok === true) {
          done = true;
          handleSessionOk();
        }
        /* 401：保持锁屏，什么都不做 */
      })
      .catch(function () {
        /* 网络失败：保持锁屏（fail-closed） */
      });
  }
  function bindRecheck() {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') recheckSession();
    });
    window.addEventListener('focus', recheckSession);
    /* pageshow：只在 bfcache 恢复时（persisted=true）重查，初始加载不查
       （初始加载时 showLockScreen 已经按 L1 状态画过屏，避免 reload 循环）。 */
    window.addEventListener('pageshow', function (e) {
      if (e && e.persisted) recheckSession();
    });
  }

  /* 会话没生效：停在锁屏，显示友好错误，不跳转（允许重试） */
  function sessionCheckFailed() {
    done = false;
    try {
      ensureDialog();
      setTitle(en ? 'Session not active' : '会话未生效');
      setBody(
        '<p class="sgx-verify-failtx">' +
          (en
            ? 'The session was not recognized. Please try again.'
            : '会话未生效，请重试。') +
          '</p>'
      );
      clearErr();
      if (dlg && !dlg.open) {
        try {
          dlg.showModal();
        } catch (e) {}
      }
      dlgState = 'session-failed';
    } catch (e) {}
  }

  /* 服务端已确认会话有效后的统一处理（2.4.1）：
     - URL 带 return：不做开锁动画，直接 location.replace(location.href)，
       交给 L1 middleware 校验 return 并 302。分层规范：return 校验只归 L1，
       前端不再重复做白名单校验。
     - 不带 return：保持现有开锁动画，显示桌面。 */
  function handleSessionOk() {
    let ret = '';
    try {
      ret = new URLSearchParams(window.location.search).get('return') || '';
    } catch (e) {}
    if (ret) {
      window.location.replace(window.location.href);
      return;
    }
    doUnlockAnimation();
  }

  /* 开锁动画（无 return 时）：显示桌面 */
  function doUnlockAnimation() {
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
      s.setAttribute('data-sgx-ts', '1');
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
      /* 2.8.0：避免重复插入（预加载和验证时各调一次） */
      if (!document.querySelector('script[data-sgx-ts]')) {
        document.head.appendChild(s);
      } else {
        /* 脚本正在加载：轮询等待就绪 */
        let n = 0;
        const iv = window.setInterval(function () {
          if (/** @type {any} */ (window).turnstile) {
            window.clearInterval(iv);
            window.clearTimeout(to);
            resolve(true);
          } else if (++n > 100) {
            window.clearInterval(iv);
          }
        }, 100);
      }
    });
  }

  /**
   * 2.8.0 Turnstile 速度优化：锁屏显示时就预加载脚本（不阻塞），
   * 用户点验证时 window.turnstile 已就绪，省去点击后的加载等待。
   * Chrome/三星浏览器曾超过 10 秒，主因是点击后才开始加载。
   */
  function preloadTurnstile() {
    try {
      if (/** @type {any} */ (window).turnstile) return;
      if (!siteKey()) return;
      const run = function () {
        loadTurnstile().catch(function () { /* 预加载失败不影响，验证时重试 */ });
      };
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 2000 });
      } else {
        window.setTimeout(run, 500);
      }
    } catch (e) {}
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

  /**
   * 2.8.0 锁屏重设计：点击头像后弹出的解锁方式选择底部弹层。
   * One UI 风格：底部弹层（宽屏居中卡片），三个选项，各带图标和一行说明：
   * 1. 访客进入（Cloudflare Turnstile，第一个）
   * 2. 通行密钥
   * 3. 密码
   * 点外部、Esc 或下滑关闭；键盘可操作。
   */
  let methodSheet = null;
  function openMethodSheet() {
    if (methodSheet) return;
    const hasPk = !!(window.PublicKeyCredential);
    const sheet = document.createElement('div');
    sheet.id = 'sgx-method-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', en ? 'Choose unlock method' : '选择解锁方式');
    sheet.innerHTML =
      '<div class="sgx-sheet-backdrop" data-close></div>' +
      '<div class="sgx-sheet-card" role="document">' +
      '<div class="sheet-handle" aria-hidden="true"></div>' +
      '<h2 class="sgx-sheet-title">' + (en ? 'Unlock' : '解锁') + '</h2>' +
      /* 1. 访客进入（Turnstile） */
      '<button type="button" class="sgx-method-opt" id="sgx-mopt-visitor" aria-label="' +
        (en ? 'Enter as visitor, verify you are human' : '访客进入，验证你不是机器人') + '">' +
      '<span class="sgx-method-ic" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l2.5 2.5"/></svg></span>' +
      '<span class="sgx-method-tx"><span class="sgx-method-name">' + (en ? 'Visitor' : '访客进入') + '</span>' +
      '<span class="sgx-method-desc">' + (en ? 'Verify you are human via Cloudflare' : '通过 Cloudflare 验证你不是机器人') + '</span></span>' +
      '</button>' +
      /* 2. 通行密钥（如果设备支持） */
      (hasPk
        ? '<button type="button" class="sgx-method-opt" id="sgx-mopt-pk" aria-label="' +
          (en ? 'Use passkey' : '使用通行密钥') + '">' +
          '<span class="sgx-method-ic" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.9-.8"/></svg></span>' +
          '<span class="sgx-method-tx"><span class="sgx-method-name">' + (en ? 'Passkey' : '通行密钥') + '</span>' +
          '<span class="sgx-method-desc">' + (en ? 'Unlock with fingerprint or device PIN' : '用指纹或设备 PIN 解锁') + '</span></span>' +
          '</button>'
        : '') +
      /* 3. 密码 */
      '<button type="button" class="sgx-method-opt" id="sgx-mopt-pw" aria-label="' +
        (en ? 'Use password' : '使用密码') + '">' +
      '<span class="sgx-method-ic" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></span>' +
      '<span class="sgx-method-tx"><span class="sgx-method-name">' + (en ? 'Password' : '密码') + '</span>' +
      '<span class="sgx-method-desc">' + (en ? 'Enter your unlock password' : '输入解锁密码') + '</span></span>' +
      '</button>' +
      '</div>';
    document.body.appendChild(sheet);
    methodSheet = sheet;
    /* 动画：下一帧加 visible 触发过渡 */
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        sheet.classList.add('visible');
      });
    });
    const close = function () { closeMethodSheet(); };
    const visitorBtn = sheet.querySelector('#sgx-mopt-visitor');
    const pkBtn = sheet.querySelector('#sgx-mopt-pk');
    const pwBtn = sheet.querySelector('#sgx-mopt-pw');
    if (visitorBtn) on(visitorBtn, 'click', function () { close(); openVerify(); });
    if (pkBtn) on(pkBtn, 'click', function () { close(); openPk(); });
    if (pwBtn) on(pwBtn, 'click', function () { close(); openPw(); });
    const backdrop = sheet.querySelector('[data-close]');
    if (backdrop) on(backdrop, 'click', close);
    /* Esc 关闭 */
    const onKey = function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    on(document, 'keydown', onKey);
    sheet._onKey = onKey;
    /* 下滑关闭（touch） */
    let startY = 0;
    const card = sheet.querySelector('.sgx-sheet-card');
    if (card) {
      on(card, 'touchstart', function (/** @type {TouchEvent} */ e) {
        if (e.touches.length === 1) startY = e.touches[0].clientY;
      }, { passive: true });
      on(card, 'touchend', function (/** @type {TouchEvent} */ e) {
        if (e.changedTouches.length === 1) {
          const dy = e.changedTouches[0].clientY - startY;
          if (dy > 80) close();
        }
      });
    }
    /* 焦点移到第一个选项（访客进入），键盘可操作 */
    try {
      if (visitorBtn) visitorBtn.focus({ preventScroll: true });
    } catch (e) {}
  }

  function closeMethodSheet() {
    if (!methodSheet) return;
    const sheet = methodSheet;
    methodSheet = null;
    sheet.classList.remove('visible');
    if (sheet._onKey) {
      document.removeEventListener('keydown', sheet._onKey);
    }
    window.setTimeout(function () {
      if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
      /* 焦点回到头像 */
      try {
        const av = document.getElementById('sgx-lock-avatar');
        if (av) av.focus({ preventScroll: true });
      } catch (e) {}
    }, 250);
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
              userVerification: 'required',
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

  /* ---------- 入口接线（2.8.0 锁屏重设计） ---------- */
  /* 头像点击 → 解锁方式选择底部弹层（不再直进 Turnstile） */
  const av = document.getElementById('sgx-lock-avatar');
  if (av) {
    on(av, 'click', function (e) {
      e.stopPropagation();
      if (!SGX_FEAT_OWNER_GATE) {
        unlock();
        return;
      }
      openMethodSheet();
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
      if (methodSheet) return;
      e.preventDefault();
      /* 2.8.0：键盘也走方式选择弹层 */
      if (!SGX_FEAT_OWNER_GATE) {
        unlock();
        return;
      }
      openMethodSheet();
    }
  });

  /* 锁屏显示期间：如果用户在别的标签页解锁了，切回来时自动检测并回跳 */
  bindRecheck();
}
