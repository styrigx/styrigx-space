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
import { armVerifyKeyboard } from './verify-kb.js';
import { get, getJSON } from '../lib/storage.js';
import { exchangeRootSession } from '../lib/root-session.js';
import { sgxNavigate, sgxReplace, sgxReload } from '../lib/diag-jumptrace.js';
import { onDialogBackdrop, onDialogCancel, recordDialogClose } from '../lib/dialog-behavior.js';

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

/* 子站验证失败提示（小字显示在页面底部；幂等，重复调用只更新文案）。
   原在 showLockScreen 内，提到模块作用域：initLock 在会话有效时不进锁屏，
   也需要直接显示 ?why= 原因。 */
function showSubsiteFailure(why) {
  let el = document.getElementById('sgx-subsite-failure');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sgx-subsite-failure';
    el.style.cssText = 'position:fixed;bottom:24px;left:0;right:0;text-align:center;font-size:12px;color:rgba(255,255,255,0.6);z-index:10001;';
    document.body.appendChild(el);
  }
  const reasons = {
    'no-cookie': '无凭证',
    'bad-format': '凭证格式错误',
    'expired': '凭证已过期',
    'key-import': '公钥导入失败',
    'sig': '签名验证失败',
    'epoch-fetch': '无法获取会话纪元',
    'epoch-stale': '凭证纪元过旧',
    'no-config': '子站未配置公钥'
  };
  el.textContent = '子站验证失败：' + (reasons[why] || why);
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
     L1（middleware）把会话状态注入 <html data-sgx-session="valid|locked|lockreset">，
     这里只读这个。lockreset 票据页跳过锁屏覆盖（落地页需可操作）。 */
  const state = document.documentElement.dataset.sgxSession;
  const ok = state === 'valid';
  const isLockreset = state === 'lockreset';
  try {
    window.dispatchEvent(new CustomEvent('sgx:session', { detail: { ok: ok } }));
  } catch (e) {}
  if (!ok && !isLockreset) {
    showLockScreen();
  }
  /* 会话有效：直接显示页面，不弹锁屏。
     防死循环失效修复：子站踢回带 ?why= 时 L1 已停止 302（返回 200 首页），
     这里直接显示失败原因，不再跳回子站。会话无效时走锁屏解锁流程，
     解锁后 handleSessionOk 会显示（已有逻辑，不重复）。 */
  if (ok) {
    try {
      const why = new URLSearchParams(window.location.search).get('why');
      if (why) showSubsiteFailure(why);
    } catch (e) {}
  }
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
    if (get('sgx-weather-show') === '0') return null;
    const c = getJSON('sgx-weather', null);
    try {
      const d = c && c.data;
      if (!d || !d.current) return null;
      const WXI = {
        0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️', 45: '🌫️', 48: '🌫️', 51: '🌦️', 53: '🌦️',
        55: '🌧️', 61: '🌧️', 63: '🌧️', 65: '🌧️', 71: '🌨️', 73: '🌨️', 75: '❄️',
        80: '🌦️', 81: '🌧️', 82: '⛈️', 95: '⛈️', 96: '⛈️',
      };
      const unit = get('sgx-temp-unit') === 'f' ? 'f' : 'c';
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
    let why = '';
    try {
      const params = new URLSearchParams(window.location.search);
      ret = params.get('return') || '';
      why = params.get('why') || '';
    } catch (e) {}
    /* 诊断：如果带 why（子站验证失败被踢回），显示原因并不再自动跳回子站，避免死循环 */
    if (why) {
      showSubsiteFailure(why);
      return;
    }
    if (ret) {
      sgxReplace(window.location.href, 'lock.js:321', 'return-reload');
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
  /* 键盘避让清理函数 */
  let dlgKbCleanup = null;
  function armDlgKb() {
    if (dlgKbCleanup) dlgKbCleanup();
    if (dlg) dlgKbCleanup = armVerifyKeyboard(dlg);
  }
  function disarmDlgKb() {
    if (dlgKbCleanup) { dlgKbCleanup(); dlgKbCleanup = null; }
  }

  function ensureDialog() {
    if (dlg) return dlg;
    const d = document.createElement('dialog');
    d.className = 'sgx-verify-dlg';
    d.setAttribute('aria-labelledby', 'sgx-verify-title');
    d.innerHTML =
      '<div class="sgx-verify-card">' +
      /* 批次 A 收尾 A3：右上角 × 关闭按钮 */
      '<button type="button" class="sgx-dlg-close" data-dlg-close aria-label="' + (en ? 'Close' : '关闭') + '">×</button>' +
      '<div class="sheet-handle" data-dclose aria-hidden="true"></div>' +
      '<h2 id="sgx-verify-title" class="sgx-verify-title"></h2>' +
      '<div id="sgx-verify-body" class="sgx-verify-body"></div>' +
      '<p id="sgx-verify-err" class="sgx-verify-err" hidden></p>' +
      '</div>';
    document.body.appendChild(d);
    dlg = /** @type {HTMLDialogElement} */ (d);
    /* 批次 A 收尾 A1/A2：点遮罩只失焦不关闭；返回手势键盘开着先收键盘 */
    on(d, 'click', function (/** @type {MouseEvent} */ e) {
      if (onDialogBackdrop(e, d)) return;
      const t = /** @type {Element|null} */ (e.target);
      if (t && t.closest && t.closest('[data-dlg-close]')) closeDialog('close-btn');
    });
    on(d, 'cancel', function (/** @type {Event} */ e) {
      onDialogCancel(e, d, function (reason) { closeDialog(reason); });
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
    armDlgKb();
    /* 卡片高度稳定后（body 有 min-height）再量，避免跳动 */
    requestAnimationFrame(function () {
      liftAvatar();
    });
    return true;
  }

  function closeDialog(reason) {
    recordDialogClose('lock-verify', reason || 'unknown');
    disarmDlgKb();
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
      closeDialog('success');
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
   * One UI 风格：底部弹层（宽屏居中卡片），各带图标和一行说明。
   *
   * 补充定稿七.1：入口按锁屏凭证配置显示（配置以服务端 /api/lock-config 为准，
   * 读取失败按「已配置」处理，不暴露根凭证入口）。「访客进入」始终在第一位：
   * - 两者都有 → 访客进入 / 通行密钥 / 密码 / 重置锁屏
   * - 仅通行密钥 → 访客进入 / 通行密钥 / 重置锁屏
   * - 仅密码 → 访客进入 / 密码 / 重置锁屏
   * - 都没设置 → 访客进入 / 根凭证（不显示重置锁屏）
   * 点外部、Esc 或下滑关闭；键盘可操作。
   */
  let methodSheet = null;
  let methodSheetLoading = false;
  function openMethodSheet() {
    if (methodSheet || methodSheetLoading) return;
    methodSheetLoading = true;
    fetch('/api/lock-config', { method: 'GET', credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        methodSheetLoading = false;
        if (methodSheet) return;
        var cfg = { passkey: true, password: true };
        if (j && j.ok) {
          cfg = { passkey: !!j.passkey, password: !!j.password };
        }
        buildMethodSheet(cfg);
      })
      .catch(function () {
        methodSheetLoading = false;
        if (methodSheet) return;
        /* 读取失败按已配置处理：不暴露根凭证入口 */
        buildMethodSheet({ passkey: true, password: true });
      });
  }
  /**
   * 按锁屏凭证配置构建方法弹层。
   * @param {{passkey:boolean, password:boolean}} cfg
   */
  function buildMethodSheet(cfg) {
    const hasPk = !!(window.PublicKeyCredential);
    const showPk = cfg.passkey && hasPk;
    const showPw = cfg.password;
    const showReset = cfg.passkey || cfg.password;
    const showMk = !cfg.passkey && !cfg.password;
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
      /* 2. 通行密钥（已配置且设备支持） */
      (showPk
        ? '<button type="button" class="sgx-method-opt" id="sgx-mopt-pk" aria-label="' +
          (en ? 'Use passkey' : '使用通行密钥') + '">' +
          '<span class="sgx-method-ic" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.9-.8"/></svg></span>' +
          '<span class="sgx-method-tx"><span class="sgx-method-name">' + (en ? 'Passkey' : '通行密钥') + '</span>' +
          '<span class="sgx-method-desc">' + (en ? 'Unlock with fingerprint or device PIN' : '用指纹或设备 PIN 解锁') + '</span></span>' +
          '</button>'
        : '') +
      /* 3. 密码（已配置） */
      (showPw
        ? '<button type="button" class="sgx-method-opt" id="sgx-mopt-pw" aria-label="' +
          (en ? 'Use password' : '使用密码') + '">' +
          '<span class="sgx-method-ic" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></span>' +
          '<span class="sgx-method-tx"><span class="sgx-method-name">' + (en ? 'Password' : '密码') + '</span>' +
          '<span class="sgx-method-desc">' + (en ? 'Enter your unlock password' : '输入解锁密码') + '</span></span>' +
          '</button>'
        : '') +
      /* 4. 重置锁屏：验证身份后重设解锁方式（任一锁屏凭证已配置时显示） */
      (showReset
        ? '<button type="button" class="sgx-method-opt" id="sgx-mopt-reset" aria-label="' +
          (en ? 'Reset lock screen' : '重置锁屏') + '">' +
          '<span class="sgx-method-ic" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg></span>' +
          '<span class="sgx-method-tx"><span class="sgx-method-name">' + (en ? 'Reset lock screen' : '重置锁屏') + '</span>' +
          '<span class="sgx-method-desc">' + (en ? 'Lost unlock method? Verify identity, then reset unlock method' : '丢了锁屏凭证？验证身份后重设解锁方式') + '</span></span>' +
          '</button>'
        : '') +
      /* 5. 根凭证：锁屏凭证都没设置时显示。调 /api/root-auth（只签发 stepup，
         不签发会话），成功后进入站长模式。走真实比对，计入 rootlimit 和审计；
         任一锁屏凭证已配置时服务端拒绝这条路径。 */
      (showMk
        ? '<button type="button" class="sgx-method-opt" id="sgx-mopt-mk" aria-label="' +
          (en ? 'Root credential' : '根凭证') + '">' +
          '<span class="sgx-method-ic" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></span>' +
          '<span class="sgx-method-tx"><span class="sgx-method-name">' + (en ? 'Root credential' : '根凭证') + '</span>' +
          '<span class="sgx-method-desc">' + (en ? 'Unlock owner mode with your root credential' : '使用根凭证解锁站长模式') + '</span></span>' +
          '</button>'
        : '') +
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
    const resetBtn = sheet.querySelector('#sgx-mopt-reset');
    const mkBtn = sheet.querySelector('#sgx-mopt-mk');
    if (visitorBtn) on(visitorBtn, 'click', function () { close(); openVerify(); });
    if (pkBtn) on(pkBtn, 'click', function () { close(); openPk(); });
    if (pwBtn) on(pwBtn, 'click', function () { close(); openPw(); });
    if (resetBtn) on(resetBtn, 'click', function () { close(); openReset(); });
    if (mkBtn) on(mkBtn, 'click', function () { close(); openMk(); });
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
          closeDialog('success');
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

  /* ---------- 根凭证态（与验证态同一弹层） ----------
     补充定稿七.1：锁屏凭证都没设置时的方法弹层入口。调 /api/root-auth
     （只签发 stepup(by=root, scope=root)，不签发会话），成功后进入安全与隐私页
     （站长模式）。走真实比对，计入 rootlimit 和审计；任一锁屏凭证已配置时
     服务端拒绝这条路径（无会话假入口，写死 401）。 */
  function openMk() {
    dlgState = 'mgmtkey';
    setTitle(en ? 'Root credential' : '根凭证');
    setBody(
      '<div class="sgx-pw-field"><input type="password" id="sgx-mk-input" class="sgx-pw-input" autocomplete="off" ' +
        'aria-label="' + (en ? 'Root credential' : '根凭证') + '" placeholder="' + (en ? 'Root credential' : '根凭证') + '">' +
        '<button type="button" class="sgx-pw-eye" id="sgx-mk-eye" aria-label="' + (en ? 'Show' : '显示') + '"></button></div>' +
        '<button type="button" class="sgx-verify-skip" id="sgx-mk-go">' + (en ? 'Verify' : '验证') + '</button>'
    );
    clearErr();
    if (!openDialog()) return;
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('sgx-mk-input'));
    const eye = document.getElementById('sgx-mk-eye');
    const go = document.getElementById('sgx-mk-go');
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
          submitMk();
        }
      });
      try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (_) {} }
    }
    if (go) on(go, 'click', submitMk);
  }

  function submitMk() {
    if (dlgState !== 'mgmtkey') return;
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('sgx-mk-input'));
    const key = input ? input.value : '';
    if (!key) {
      showError(en ? 'Enter root credential' : '请输入根凭证');
      return;
    }
    fetch('/api/root-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key }),
    })
      .then(function (r) {
        return r.text().then(function (t) {
          let j = null;
          try { j = JSON.parse(t); } catch (e) {}
          return { s: r.status, j: j };
        });
      })
      .then(function (res) {
        if (dlgState !== 'mgmtkey') return;
        const j = res.j;
        if (!j) {
          showError(en ? 'Server error' : '服务器错误');
          return;
        }
        if (j.ok) {
          /* 锁屏未配置场景：root-auth 只签发 stepup(by=root, scope=root)，
             需调 /api/root-session 换站长会话（by=root，1 小时）再跳转，
             否则无会话会被 middleware 302 回锁屏。
             用共享函数 exchangeRootSession（与 security.js 共用）。 */
          exchangeRootSession()
            .then(function (res2) {
              if (dlgState !== 'mgmtkey') return;
              if (res2.ok) {
                closeDialog('success');
                /* 若 URL 带 return，走与密码/通行密钥相同的 handleSessionOk 路径
                   （location.replace 当前地址，L1 校验 return 并 302）；
                   无 return 才去安全页。前端不自己做 return 白名单。 */
                let ret = '';
                try { ret = new URLSearchParams(window.location.search).get('return') || ''; } catch (e) {}
                if (ret) {
                  handleSessionOk();
                } else {
                  sgxNavigate(en ? '/en/settings/security/' : '/settings/security/', 'lock.js:1103', 'mgmtkey-ok');
                }
              } else {
                showError(en ? 'Server error' : '服务器错误');
                if (input) input.value = '';
              }
            })
            .catch(function () {
              if (dlgState !== 'mgmtkey') return;
              showError(en ? 'Network error' : '网络错误');
            });
        } else if (res.s === 429) {
          showError(en ? 'Too many attempts' : '尝试次数过多');
        } else if (res.s === 503 || res.s === 500) {
          showError(en ? 'Server error' : '服务器错误');
        } else {
          showError(en ? 'Wrong root credential' : '根凭证错误');
          if (input) input.value = '';
        }
      })
      .catch(function () {
        if (dlgState !== 'mgmtkey') return;
        showError(en ? 'Network error' : '网络错误');
      });
  }

  /* ---------- 重置锁屏 ----------
     始终先显示第一步输入框，由 verify 结果决定下一步：
     票据 → 重设解锁方式；needOwner → 第二步；not-set → 通用失败提示（不泄露原因）。
     第一步的根凭证存闭包变量 resetRootKey，用完即清，不挂 window。 */
  var resetRootKey = null;
  function openReset() {
    dlgState = 'reset';
    resetRootKey = null;
    setTitle(en ? 'Reset lock screen' : '重置锁屏');
    clearErr();
    if (!openDialog()) return;
    renderResetStep1();
  }

  /* 重置步骤 1：验证身份。服务端决定下一步：开关有效则直接完成，
     否则返回 needOwner 进入第二步。 */
  function renderResetStep1() {
    dlgState = 'reset-step1';
    setTitle((en ? 'Reset lock screen' : '重置锁屏') + ' (1/2)');
    setBody(
      '<div class="sgx-reset-hint">' + (en ? 'Verify identity' : '验证身份') + '</div>' +
      '<div class="sgx-pw-field"><input type="password" id="sgx-reset-root" class="sgx-pw-input" autocomplete="off" ' +
        'placeholder="' + (en ? 'Credential' : '凭证') + '">' +
        '<button type="button" class="sgx-verify-skip" id="sgx-reset-go">' + (en ? 'Verify' : '验证') + '</button></div>'
    );
    clearErr();
    var go = document.getElementById('sgx-reset-go');
    var input = document.getElementById('sgx-reset-root');
    if (input) {
      on(input, 'keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitResetRoot(); }
      });
      try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (_) {} }
    }
    if (go) on(go, 'click', submitResetRoot);
  }

  function submitResetRoot() {
    if (dlgState !== 'reset-step1') return;
    var input = document.getElementById('sgx-reset-root');
    var rootKey = input ? input.value : '';
    if (!rootKey) {
      showError(en ? 'Enter credential' : '请输入凭证');
      return;
    }
    /* 第一步凭证存闭包变量（不用 window，用完即清），供第二步一起提交 */
    resetRootKey = rootKey;
    /* 立即清空输入框，不在 DOM 残留 */
    if (input) input.value = '';
    postResetVerify({ rootKey: rootKey }, function (res) {
      if (dlgState !== 'reset-step1') return;
      if (res.s === 200 && res.j && res.j.ok && !res.j.needOwner) {
        /* 开关有效：直接完成 */
        resetRootKey = null;
        resetDone();
      } else if (res.s === 200 && res.j && res.j.ok && res.j.needOwner) {
        renderResetStep2(!!res.j.passkey, !!res.j.password);
      } else if (res.s === 429) {
        resetRootKey = null;
        showError(en ? 'Too many attempts' : '尝试次数过多');
      } else {
        resetRootKey = null;
        showError(en ? 'Verification failed' : '验证失败');
        var inp = document.getElementById('sgx-reset-root');
        if (inp) inp.value = '';
      }
    });
  }

  /* 重置步骤 2：站长凭证（按配置显示按钮） */
  function renderResetStep2(hasPk, hasPw) {
    dlgState = 'reset-step2';
    setTitle((en ? 'Reset lock screen' : '重置锁屏') + ' (2/2)');
    /* 补充四：根凭证正确但开关无效时，在此步骤下方显示恢复开关提示。
       仅此处显示；根凭证错误、访客假入口、其他页面一律不出现。 */
    var switchHint = en
      ? 'Owner credential unavailable? Add key recovery-switch (any value) in Cloudflare KV, valid for 24 hours, single use only.'
      : '站长凭证也无法使用？在 Cloudflare KV 添加键 recovery-switch（值任意），24 小时内有效且仅限一次。';
    var pkBtnHtml = hasPk
      ? '<button type="button" class="sgx-verify-skip" id="sgx-reset-pk">' + (en ? 'Use passkey' : '使用通行密钥') + '</button>'
      : '';
    var pwFormHtml = hasPw
      ? '<div class="sgx-pw-field"><input type="password" id="sgx-reset-pw" class="sgx-pw-input" autocomplete="off" ' +
        'placeholder="' + (en ? 'Owner password' : '站长密码') + '">' +
        '<button type="button" class="sgx-verify-skip" id="sgx-reset-pw-go">' + (en ? 'Verify' : '验证') + '</button></div>'
      : '';
    setBody(
      '<div class="sgx-reset-hint">' + (en ? 'Verify owner credential' : '验证站长凭证') + '</div>' +
      pkBtnHtml + pwFormHtml +
      '<div class="sgx-reset-switch-hint">' + switchHint + '</div>'
    );
    clearErr();
    var pkBtn = document.getElementById('sgx-reset-pk');
    var pwGo = document.getElementById('sgx-reset-pw-go');
    if (pkBtn) on(pkBtn, 'click', resetPk);
    if (pwGo) on(pwGo, 'click', resetPw);
  }

  /* 统一提交 verify（内部函数） */
  function postResetVerify(body, cb) {
    fetch('/api/lockreset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: 'verify' }, body)),
    })
      .then(function (r) {
        return r.text().then(function (t) {
          var j = null;
          try { j = JSON.parse(t); } catch (e) {}
          return { s: r.status, j: j };
        });
      })
      .then(cb)
      .catch(function () {
        cb({ s: 0, j: null });
      });
  }

  function resetDone() {
    resetRootKey = null;
    closeDialog('success');
    /* 跳转到锁屏凭证管理页（lockreset 票据可开此页，仍进不了主页） */
    sgxNavigate(en ? '/en/settings/security/lock/' : '/settings/security/lock/', 'lock.js:1251', 'reset-done');
  }

  /* 重置步骤 2a：站长通行密钥 */
  function resetPk() {
    if (dlgState !== 'reset-step2') return;
    fetch('/api/lockreset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'challenge' }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (dlgState !== 'reset-step2') return;
        if (!j || !j.ok) {
          showError(en ? 'Failed to start' : '启动失败');
          return;
        }
        var allow = (j.allowCredentials || []).map(function (c) {
          return { id: Uint8Array.from(atob(c.id.replace(/-/g, '+').replace(/_/g, '/')), function (ch) { return ch.charCodeAt(0); }), type: 'public-key' };
        });
        navigator.credentials.get({
          publicKey: {
            challenge: Uint8Array.from(atob(j.challenge.replace(/-/g, '+').replace(/_/g, '/')), function (ch) { return ch.charCodeAt(0); }),
            rpId: j.rpId,
            allowCredentials: allow,
            userVerification: 'required',
          },
        }).then(function (cred) {
          if (dlgState !== 'reset-step2') return;
          var b64u = function (buf) {
            return btoa(String.fromCharCode.apply(null, new Uint8Array(buf)))
              .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          };
          var proof;
          try {
            proof = {
              type: 'passkey',
              cid: j.cid,
              credential: {
                rawId: b64u(cred.rawId),
                response: {
                  authenticatorData: b64u(cred.response.authenticatorData),
                  clientDataJSON: b64u(cred.response.clientDataJSON),
                  signature: b64u(cred.response.signature),
                  userHandle: cred.response.userHandle ? b64u(cred.response.userHandle) : null,
                },
              },
            };
          } catch (e) {
            showError(en ? 'Passkey failed' : '通行密钥验证失败');
            return;
          }
          submitResetOwner(proof);
        }).catch(function () {
          if (dlgState !== 'reset-step2') return;
          showError(en ? 'Passkey failed' : '通行密钥验证失败');
        });
      })
      .catch(function () {
        if (dlgState !== 'reset-step2') return;
        showError(en ? 'Network error' : '网络错误');
      });
  }

  /* 重置步骤 2b：站长密码 */
  function resetPw() {
    if (dlgState !== 'reset-step2') return;
    var input = document.getElementById('sgx-reset-pw');
    var pw = input ? input.value : '';
    if (!pw) {
      showError(en ? 'Enter owner password' : '请输入站长密码');
      return;
    }
    submitResetOwner({ type: 'password', password: pw });
  }

  function submitResetOwner(ownerProof) {
    if (dlgState !== 'reset-step2') return;
    var rootKey = resetRootKey || '';
    if (!rootKey) {
      showError(en ? 'Session expired, restart' : '会话过期，请重新开始');
      return;
    }
    postResetVerify({ rootKey: rootKey, ownerProof: ownerProof }, function (res) {
      if (dlgState !== 'reset-step2') return;
      if (res.s === 200 && res.j && res.j.ok) {
        resetDone();
      } else if (res.s === 429) {
        showError(en ? 'Too many attempts' : '尝试次数过多');
      } else {
        showError(en ? 'Verification failed' : '验证失败');
      }
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
          closeDialog('success');
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

  /* 已解锁标签页的自动锁定：visibilitychange（visible）、pageshow（含 bfcache）、
     focus 时向服务端确认会话（/api/session-check），失败就重载切到锁屏。
     不用跨标签页广播 / storage / 前端内存做锁屏状态，状态源只有服务端。
     节流 5 秒；网络错误不跳转，下次再查。
     「锁定所有设备」靠 epoch 生效，子站缓存最多约 60 秒。 */
  let lastLockCheck = 0;
  /* A2：留痕写上 session-check 的 HTTP 状态码 + 触发事件。
     A6：键盘收起可能引发 focus / visibilitychange / resize，三种事件都覆盖。 */
  function checkSessionForAutoLock(trigger) {
    const now = Date.now();
    if (now - lastLockCheck < 5000) return;
    lastLockCheck = now;
    /* 如果当前已是锁屏状态，不需要检查（锁屏页有自己的 recheck 逻辑） */
    if (document.body.classList.contains('sgx-locked')) return;
    fetch('/api/session-check', { credentials: 'same-origin' })
      .then(function (r) {
        if (r.ok) return; /* 会话有效，什么都不做 */
        /* 401 或其他失败：重载，L1 middleware 会显示锁屏。
           留痕含状态码 + 触发事件，定位 #1 的「无记录重载」。 */
        sgxReload('lock.js:1531', 'session-check=' + r.status + ';trigger=' + (trigger || 'unknown'));
      })
      .catch(function () {
        /* 网络错误：不跳转，下次再查 */
      });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') checkSessionForAutoLock('visibilitychange');
  });
  window.addEventListener('focus', function () { checkSessionForAutoLock('focus'); });
  window.addEventListener('pageshow', function (e) {
    if (e && e.persisted) checkSessionForAutoLock('pageshow');
  });
  /* A6：键盘收起引发 resize 时也查一次（同 5 秒节流）。 */
  window.addEventListener('resize', function () { checkSessionForAutoLock('resize'); });
}
