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
import { reducedMotion } from '../lib/util.js';
import { followKeyboard } from './vk.js';
import { exchangeRootSession } from '../lib/root-session.js';
import { sgxNavigate, sgxReplace, sgxReload } from '../lib/diag-jumptrace.js';
import { onDialogBackdrop, onDialogCancel, recordDialogClose, tapFeedback } from '../lib/dialog-behavior.js';
import { getPasskeyAssertion, passkeyErrorText } from '../lib/passkey-assert.js';
import { pwFieldHtml, bindPwEye, onEnter, focusNoScroll } from '../lib/auth-flow.js';
import { KEY_LOCK } from '../lib/key-names.js';
import { mountResetFlow, resetT } from '../lib/reset-flow.js';
import { b64urlToBuf, bufToB64url } from '../lib/b64.js';

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

/* ============================================================
   锁屏状态机（2026-10-21 重写判定部分；界面不变）。唯一状态源：服务端。
   - 页面状态 pageState()：网关注入的 <html data-sgx-session>：
       valid / locked / lockreset；没有这个属性 = unknown（页面没经过网关，例如路由漏了这种 URL，
       或缓存/测试环境）。unknown 一律先画锁屏（fail closed），并立刻问服务端。
   - 服务端回答 askServer()：GET /api/session-check[?return=]：{ok, role, next, upgrade}。
     next 是服务端校验过的去处（与首页 302 同一个 resolveReturn）；前端不做白名单，只照着跳。
   - 解锁成功 / 切回标签页 / bfcache 恢复 / 首帧对账，都走同一个 proceed(answer)：
       upgrade      → 去首页 ?return=（服务端给主人验证层，不出锁屏）
       next 是别处  → location.replace(next)（子站或站内原页面）
       没有 next    → 页面是 locked（锁屏态被瘦身过）就换到干净地址重新取一次（服务端画 valid），
                      valid / unknown 就原地开锁并把地址里的 lock/why/return 去掉
     每一条都不会「重载同一个地址再等服务端 302」——那依赖锁屏页本身过网关，线上曾经不成立，
     结果就是解锁后又回到锁屏（2026-10-21 用户报告）。
   - 已解锁页面切回前台：问服务端，401 → 重载（服务端画锁屏）。立即锁定 = 服务端清 cookie。
   - 本地 sessionStorage 只记「刚跳过哪里」防死循环，从不记解锁状态。
   ============================================================ */

/** @returns {'valid'|'locked'|'lockreset'|'unknown'} */
function pageState() {
  const s = document.documentElement.dataset.sgxSession;
  return s === 'valid' || s === 'locked' || s === 'lockreset' ? s : 'unknown';
}

/** @param {string} k */
function qp(k) {
  try {
    return new URLSearchParams(window.location.search).get(k) || '';
  } catch (e) {
    return '';
  }
}

/**
 * 问服务端：会话是否有效、带 return 时该去哪。失败（401/网络）→ {ok:false}。
 * @returns {Promise<{ok:boolean, role?:string, next?:string|null, upgrade?:boolean}>}
 */
function askServer() {
  const ret = qp('return');
  const url = '/api/session-check' + (ret ? '?return=' + encodeURIComponent(ret) : '');
  return fetch(url, { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) {
      if (!r.ok) return { ok: false };
      return r.json().catch(function () { return { ok: false }; });
    })
    .then(function (d) { return d && d.ok === true ? d : { ok: false }; })
    .catch(function () { return { ok: false }; });
}

/* B1-8：子站回跳死循环判定（20 秒窗口）。只在子站踢回（带 ?why=）时用：
   20 秒内同一 target 第二次被踢回 → 失败卡（One UI 样式，不显示原因码），不再跳。
   记录 { target, at } 在真正跳之前写入。 */
function checkSubsiteLoop(target) {
  try {
    const raw = sessionStorage.getItem('sgx-subsite-jump');
    const now = Date.now();
    if (raw) {
      const rec = JSON.parse(raw);
      if (rec.target === target && (now - rec.at) < 20000) {
        return true; /* 死循环 */
      }
    }
    sessionStorage.setItem('sgx-subsite-jump', JSON.stringify({ target: target, at: now }));
  } catch (e) {}
  return false;
}
function showSubsiteFailure() {
  let el = document.getElementById('sgx-subsite-failure');
  if (!el) {
    const isEn = document.documentElement.lang === 'en';
    const msg = isEn ? 'Cannot return to the subsite, please try again' : '无法回到子站，请重试';
    const homeText = isEn ? 'Back to main site' : '回到主站';
    el = document.createElement('div');
    el.id = 'sgx-subsite-failure';
    el.className = 'sgx-card';
    el.style.cssText = 'position:fixed;bottom:24px;left:16px;right:16px;z-index:10001;padding:16px;text-align:center;';
    el.innerHTML =
      '<p style="margin:0 0 12px;font-size:15px;">' + msg + '</p>' +
      '<button type="button" class="sgx-door-btn-primary" id="sgx-subsite-home">' + homeText + '</button>';
    document.body.appendChild(el);
    const btn = document.getElementById('sgx-subsite-home');
    if (btn) {
      btn.addEventListener('click', function () {
        sgxNavigate('/');
      });
    }
  }
  el.hidden = false;
}

/** 当前地址去掉 lock / why / return（其余参数、hash 原样） */
function cleanUrl() {
  try {
    const u = new URL(window.location.href);
    u.searchParams.delete('lock');
    u.searchParams.delete('why');
    u.searchParams.delete('return');
    return u.pathname + (u.search && u.search !== '?' ? u.search : '') + u.hash;
  } catch (e) {
    return window.location.pathname;
  }
}

/** 绝对地址比较（next 可能是站内路径） @param {string} a */
function sameAsCurrent(a) {
  try {
    return new URL(a, window.location.href).href === window.location.href;
  } catch (e) {
    return false;
  }
}

/* locked 页面解锁后换到干净地址：10 秒内同一地址只换一次（服务端页面状态和接口说法长期不一致时不来回刷） */
function reloadGuardOk(url) {
  try {
    const k = 'sgx-unlock-reload';
    const prev = JSON.parse(sessionStorage.getItem(k) || 'null');
    const abs = new URL(url, window.location.href).href;
    if (prev && prev.url === abs && Date.now() - prev.at < 10000) return false;
    sessionStorage.setItem(k, JSON.stringify({ url: abs, at: Date.now() }));
  } catch (e) {
    return false;
  }
  return true;
}

/**
 * 服务端已确认会话有效后的唯一去处判定。
 * @param {{next?:string|null, upgrade?:boolean}} ans
 * @param {() => void} unlockInPlace 原地开锁（锁屏态时是开锁动画；valid 页面是空操作）
 * @returns {'navigate'|'in-place'|'failure'}
 */
function proceed(ans, unlockInPlace) {
  const why = qp('why');
  if (ans.upgrade && ans.next) {
    /* 访客 + 主人专属去处：首页 ?return= 由服务端给主人验证层（不出锁屏） */
    const home = document.documentElement.lang === 'en' ? '/en/' : '/';
    sgxReplace(home + '?return=' + encodeURIComponent(ans.next));
    return 'navigate';
  }
  if (ans.next) {
    if (why && checkSubsiteLoop(ans.next)) {
      unlockInPlace();
      showSubsiteFailure();
      return 'failure';
    }
    if (!sameAsCurrent(ans.next)) {
      sgxReplace(ans.next);
      return 'navigate';
    }
  }
  const clean = cleanUrl();
  if (pageState() === 'locked' && reloadGuardOk(clean)) {
    /* 锁屏态页面是瘦身过的（没有桌面内容）：重新取一次，服务端会画 valid */
    sgxReplace(clean);
    return 'navigate';
  }
  try { history.replaceState(history.state, '', clean); } catch (e) {}
  unlockInPlace();
  return 'in-place';
}

/* 已解锁页面：切回前台 / bfcache 恢复 / 转屏时向服务端确认，401 → 重载（服务端画锁屏）。
   节流 5 秒；网络错误不跳转，下次再查。页面正显示锁屏时不查（锁屏有自己的对账）。 */
let lastLockCheck = 0;
function checkSessionForAutoLock() {
  const now = Date.now();
  if (now - lastLockCheck < 5000) return;
  lastLockCheck = now;
  if (document.getElementById('sgx-lock')) return;
  fetch('/api/session-check', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) {
      if (r.status === 401) sgxReload();
    })
    .catch(function () {});
}
let autoLockBound = false;
function bindAutoLock() {
  if (autoLockBound) return;
  autoLockBound = true;
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') checkSessionForAutoLock();
  });
  window.addEventListener('focus', function () { checkSessionForAutoLock(); });
  window.addEventListener('pageshow', function (e) {
    if (e && e.persisted) checkSessionForAutoLock();
  });
  /* 只在宽度变化（转屏 / DeX 改窗口）时查；键盘开合只改高度 */
  let lastW = window.innerWidth;
  window.addEventListener('resize', function () {
    if (window.innerWidth === lastW) return;
    lastW = window.innerWidth;
    checkSessionForAutoLock();
  });
}

/**
 * 初始化锁屏（全站）。
 */
export function initLock() {
  /* Hark：CI 测试构建禁用锁屏（构建期 define，线上无绕过） */
  if (SGX_TEST_NO_LOCK) return;
  if (!SGX_FEAT_OWNER_GATE) return;
  if (isLocalDev()) {
    /* 本地开发没有后端，直接显示锁屏 */
    showLockScreen();
    return;
  }
  const state = pageState();
  try {
    window.dispatchEvent(new CustomEvent('sgx:session', { detail: { ok: state === 'valid' } }));
  } catch (e) {}
  if (state === 'lockreset') return; /* 重置锁屏门票页：落地页需可操作 */
  if (state === 'valid') {
    bindAutoLock();
    /* 子站踢回（带 why）但主站会话有效：问服务端 next，回子站（20 秒窗口防死循环）。
       主人验证页（data-sgx-upgrade）带 return 但不能跳走。 */
    if (qp('why') && qp('return') && document.documentElement.getAttribute('data-sgx-upgrade') !== '1') {
      askServer().then(function (ans) {
        if (ans.ok) proceed(ans, function () {});
      });
    }
    return;
  }
  /* locked / unknown：先画锁屏（fail closed），锁屏里立刻对账 */
  showLockScreen();
}

/**
 * 显示锁屏 UI（2.4.0 H）。
 */
function showLockScreen() {
  const en = document.documentElement.lang === 'en';
  const isLocal = isLocalDev();

  /* 头像：复用导航抽屉头的头像图片（2026-10-22 从顶栏挪进抽屉） */
  const navImg = /** @type {HTMLImageElement|null} */ (document.querySelector('.sgx-tb-avatar'));
  /* 锁屏头像 72px：用 192 那张（顶栏是 96） */
  const avatarSrc = navImg ? navImg.src.replace(/\/avatar\/96\.webp/, '/avatar/192.webp') : '';

  /* 顶栏保持全站三件套（用户 2026-10-23：顶栏保留设计）：左九宫格圆 + 页名长条 + 右快捷面板圆，图标取页面顶栏同一份。
     锁屏上两侧圆只是外观（span、不可点、不进读屏），抽屉 / 快捷面板在锁定时打不开，不能绕过锁屏。 */
  const tbNavEl = document.querySelector('#site-nav .sgx-tb-nav');
  const tbEndEl = document.querySelector('#site-nav .sgx-tb-end');
  const tbNavIc = tbNavEl ? tbNavEl.innerHTML : '';
  const tbEndIc = tbEndEl ? tbEndEl.innerHTML : '';
  const ov = document.createElement('div');
  ov.id = 'sgx-lock';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', en ? 'Lock screen' : '锁屏');
  /* PR3 锁屏版面：保留锁屏的感觉（小锁 → 时钟 → 日期天气 → 日刻今日一句 → 头像解锁），
     整组在屏幕里垂直居中，不再「时钟顶在上面、头像压在底部、中间一大片空」。
     日刻卡只展示（div，不是链接，点了不跳转）；拉不到就不显示。
     为了不跳版面：整组先透明，日刻有结论（缓存画上 / 拉到 / 失败）或等满 1.2 秒再一起显示；
     之后才拉到的句子这次不再插进来（下次锁屏从缓存直接画）。 */
  /* 2026-10-23 锁屏视觉统一（用户定稿）：和账号登录页同一套玻璃背景与版面 ——
     顶栏和全站一样是三件套（两侧圆只是外观，点不了，锁屏不能绕过）；
     头像（点它解锁）→ 欢迎回来 / 很高兴再次见到你 → 解锁按钮，整组在屏幕上下左右居中。
     （2026-10-23：小锁图标、左上字标、底部站点清单删掉；A Personal Digital Space 挪到抽屉头）
     时钟、日期天气、日刻不再放在锁屏上。解锁、凭证、会话逻辑不变：按钮只是转点头像。 */
  ov.innerHTML =
    '<div class="sgx-glass-bg" aria-hidden="true"></div>' +
    '<div class="sgx-lock-tb">' +
    '<span class="sgx-tb-nav" aria-hidden="true">' + tbNavIc + '</span>' +
    '<div class="sgx-tb-pill"><span class="sgx-tb-title" id="sgx-lock-title">' + (en ? 'Unlock screen' : '解锁屏幕') + '</span></div>' +
    '<span class="sgx-tb-end" aria-hidden="true">' + tbEndIc + '</span>' +
    '</div>' +
    '<div class="sgx-lock-stage is-pending" id="sgx-lock-stage">' +
    '<div class="sgx-lock-user"><button type="button" id="sgx-lock-avatar" aria-label="' +
    (en ? 'Unlock, choose method' : '解锁，选择方式') +
    '" aria-haspopup="dialog">' +
    '<span class="sgx-lock-halo" aria-hidden="true"></span>' +
    (avatarSrc
      ? '<img src="' + avatarSrc + '" alt="Styrigx" width="120" height="120">'
      : '<span class="sgx-lock-fb" aria-hidden="true">S</span>') +
    '</button>' +
    '<p class="sgx-lock-welcome">' + (en ? 'Welcome back' : '欢迎回来') + '</p>' +
    '<p class="sgx-lock-sub">' + (en ? 'Good to see you again' : '很高兴再次见到你') + '</p>' +
    '<button type="button" class="sgx-door-btn sgx-door-btn-primary sgx-lock-go" id="sgx-lock-go" aria-haspopup="dialog">' +
    UNLOCK + '<span>' + (en ? 'Unlock' : '解锁') + '</span></button>' +
    '</div>' +
    '</div>';
  document.body.appendChild(ov);
  document.body.classList.add('sgx-locked');
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';

  /* 2.8.0：锁屏显示时预加载 Turnstile（用户点验证时已就绪） */
  preloadTurnstile();

  /* 版面一次画完，直接显示（以前要等日刻） */
  const stage = document.getElementById('sgx-lock-stage');
  if (stage) stage.classList.remove('is-pending');

  let done = false;
  function cleanup() {
    if (ov.parentNode) ov.parentNode.removeChild(ov);
    document.body.classList.remove('sgx-locked');
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
    bindAutoLock();
  }

  /** 服务端确认有效后：关掉弹层，交给模块级 proceed（唯一去处判定） */
  function onServerOk(ans) {
    done = true;
    try { closeMethodSheet(true); } catch (e) {}
    if (dlg && dlg.open) closeDialog('session-ok');
    proceed(ans, doUnlockAnimation);
  }

  /* 解锁成功（密码 / 通行密钥 / 访客）后：先向服务端确认会话真的生效，再按服务端给的 next 走；
     没确认到 → 停在锁屏显示错误，绝不跳转。 */
  function unlock() {
    if (done) return;
    done = true;
    if (isLocal) {
      /* 本地开发没有后端：原地开锁 */
      doUnlockAnimation();
      return;
    }
    askServer().then(function (ans) {
      if (ans.ok) onServerOk(ans);
      else sessionCheckFailed();
    });
  }

  /* 锁屏显示期间（用户可能在别的标签页解锁了）：visibilitychange（visible）、focus、pageshow 时对账，
     节流 1 秒。ok → proceed；401/网络失败 → 保持锁屏（fail closed）。 */
  let lastRecheck = 0;
  function recheckSession() {
    if (done || isLocal) return;
    const now = Date.now();
    if (now - lastRecheck < 1000) return;
    lastRecheck = now;
    askServer().then(function (ans) {
      if (!done && ans.ok) onServerOk(ans);
    });
  }

  function bindRecheck() {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') recheckSession();
    });
    window.addEventListener('focus', recheckSession);
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

  /* 开锁动画（无 return 时）：显示桌面 */
  function doUnlockAnimation() {
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
  /* 键盘避让：各态 setBody 后对新生成输入框调 followKeyboard(dlg, input)，
     与其他弹层同一套逻辑（shell/vk.js）。作用到 dlg 而非 card，
     避免与 card 入场动画冲突；旧 verify-kb.js（只动 card）已删除。 */
  let dlgKbCleanup = null;
  function armDlgKbFor(input) {
    if (dlgKbCleanup) {
      try { dlgKbCleanup(); } catch (e) {}
      dlgKbCleanup = null;
    }
    if (dlg && input) dlgKbCleanup = followKeyboard(dlg, input);
  }
  function disarmDlgKb() {
    if (dlgKbCleanup) { try { dlgKbCleanup(); } catch (e) {} dlgKbCleanup = null; }
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
    /* 键盘避让由各态 setBody 后 armDlgKbFor(input) 接入（输入框那时才存在） */
    /* 卡片高度稳定后（body 有 min-height）再量，避免跳动 */
    requestAnimationFrame(function () {
      liftAvatar();
    });
    return true;
  }

  function closeDialog(reason) {
    recordDialogClose('lock-verify', reason || 'unknown');
    removeWidget();
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
      /* PR3：加载失败（onerror / 8 秒超时 / 加载了但没有 window.turnstile）时把这个 <script> 摘掉，
         下次「重试」重新插入；以前失败的标签一直留着，之后每次都走轮询分支、失败到刷新页面为止。 */
      const fail = function (why) {
        window.clearTimeout(to);
        try { s.remove(); } catch (e) {}
        reject(new Error(why));
      };
      const to = window.setTimeout(function () { fail('timeout'); }, 8000);
      s.onload = function () {
        if (/** @type {any} */ (window).turnstile) {
          window.clearTimeout(to);
          resolve(true);
        } else {
          fail('no-global');
        }
      };
      s.onerror = function () { fail('load'); };
      /* 2.8.0：避免重复插入（预加载和验证时各调一次） */
      const pending = document.querySelector('script[data-sgx-ts]');
      if (!pending) {
        document.head.appendChild(s);
      } else {
        /* 脚本正在加载：轮询等待就绪；那次加载失败（标签被摘掉）或等满 10 秒 → reject，重试会重新插入 */
        window.clearTimeout(to);
        let n = 0;
        const iv = window.setInterval(function () {
          if (/** @type {any} */ (window).turnstile) {
            window.clearInterval(iv);
            resolve(true);
          } else if (!pending.isConnected || ++n > 100) {
            window.clearInterval(iv);
            try { pending.remove(); } catch (e) {}
            reject(new Error('load'));
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

  /* 验证态：标题 + Cloudflare 官方 Turnstile 小组件，原样显示（appearance always、托管模式、size flexible，
     主题 / 语言跟随本站）。「正在验证… / 请验证您是真人」都是 Cloudflare 自己的界面，本站不加转圈、不设计时器。
     PR3：以前渲染进带 hidden（display:none）的容器、appearance interaction-only，挑战既不弹勾选框也不回调，
     三星浏览器上一直卡在「正在验证…」。容器现在一直可见。 */
  function verifyLoading() {
    dlgState = 'verify';
    setTitle(en ? "Checking you're human" : '正在确认你不是机器人');
    setBody('<div id="sgx-ts-wrap" class="sgx-ts-wrap"></div>');
    clearErr();
  }

  /* 验证态：成功 → 变勾，0.3s 后解锁 */
  function verifySuccess() {
    removeWidget();
    setBody('<div class="sgx-verify-loading"><div class="sgx-check">' + CHECK + '</div></div>');
    clearErr();
    window.setTimeout(function () {
      verifyDone = true;
      closeDialog('success');
      unlock();
    }, 300);
  }

  /* 失败 / 超时 → 提示 + 重试，不出现错误码。
     PR3：不设本站计时器，挑战中的重试只认 Cloudflare 自己的 timeout-callback / error-callback / expired-callback
     （以前 15 秒计时会冲掉还在跑的托管挑战）；脚本没加载上、/api/verify 不通过也走这里（原有行为）。 */
  /** @param {boolean} [isTimeout] */
  function showTurnstileRetry(isTimeout) {
    removeWidget();
    setBody(
      '<div class="sgx-verify-loading"><p class="sgx-verify-failtx">' +
        (isTimeout ? (en ? 'Verification timed out' : '验证时间过长') : (en ? 'Verification failed' : '验证失败')) +
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
  function verifyFailed() {
    showTurnstileRetry(false);
  }

  /* PR3：每次渲染一个新小组件 attempt +1；旧小组件迟到的回调一律丢弃（不会 submitToken、不会改写新状态）。 */
  let tsAttempt = 0;
  /* PR3：重渲染 / 换内容 / 关弹层前先 turnstile.remove（以前 setBody 冲掉容器后再对脱离 DOM 的小组件 reset） */
  function removeWidget() {
    tsAttempt++;
    try {
      const ts = /** @type {any} */ (window).turnstile;
      if (widgetId !== null && ts) {
        if (typeof ts.remove === 'function') ts.remove(widgetId);
        else ts.reset(widgetId);
      }
    } catch (e) {}
    widgetId = null;
  }

  function startVerify() {
    removeWidget();
    const attempt = tsAttempt;
    /** 只认本次小组件的回调 */
    const live = function () { return attempt === tsAttempt && dlgState === 'verify'; };
    verifyLoading();
    loadTurnstile().then(
      function () {
        if (!live()) return;
        const wrap = document.getElementById('sgx-ts-wrap');
        if (!wrap || !(/** @type {any} */ (window).turnstile)) {
          verifyFailed();
          return;
        }
        const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
        widgetId = /** @type {any} */ (window).turnstile.render(wrap, {
          sitekey: siteKey(),
          action: 'sgx-entry',
          appearance: 'always',
          size: 'flexible',
          theme: theme,
          language: en ? 'en' : 'zh-CN',
          callback: function (/** @type {string} */ token) {
            if (live()) submitToken(token);
          },
          'error-callback': function () {
            if (live()) showTurnstileRetry(false);
          },
          'expired-callback': function () {
            if (live()) verifyFailed();
          },
          'timeout-callback': function () {
            if (live()) showTurnstileRetry(true);
          },
        });
      },
      function () {
        if (live()) verifyFailed();
      }
    );
  }

  /**
   * 2.8.0 锁屏重设计：点击头像后弹出的解锁方式选择底部弹层。
   * One UI 风格：底部弹层（宽屏居中卡片），各带图标和一行说明。
   *
   * 补充定稿七.1：入口按锁屏凭证配置显示（配置以服务端 /api/lock-config 为准，
   * 读取失败按「已配置」处理）。「访客进入」始终在第一位，最下面一行小字「无法登录？」（PR3）：
   * - 两者都有 → 访客进入 / 通行密钥 / 密码 / 无法登录？
   * - 仅通行密钥 / 仅密码 → 访客进入 / 该项 / 无法登录？
   * - 都没设置（启动站）→ 访客进入 / 无法登录？（里面的根凭证走 root-auth 引导，原「根凭证」一行）
   * 「无法登录？」→ 弹层原地切到重置登录（openResetInSheet）。
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
        var cfg = { passkey: true, password: true, ownerConfigured: true };
        if (j && j.ok) {
          /* A-2：透传 resetOnly / ownerConfigured（不透传则 resetOnly 恒 false，锁屏清空态仍显示通行密钥/密码入口） */
          cfg = { passkey: !!j.passkey, password: !!j.password, resetOnly: !!j.resetOnly, ownerConfigured: j.ownerConfigured !== false };
        }
        buildMethodSheet(cfg);
      })
      .catch(function () {
        methodSheetLoading = false;
        if (methodSheet) return;
        /* 读取失败按已配置处理：不暴露根凭证入口 */
        buildMethodSheet({ passkey: true, password: true, ownerConfigured: true });
      });
  }
  /**
   * 按锁屏凭证配置构建方法弹层。
   * @param {{passkey:boolean, password:boolean, resetOnly?:boolean, ownerConfigured?:boolean}} cfg
   */
  function buildMethodSheet(cfg) {
    const hasPk = !!(window.PublicKeyCredential);
    /* A-2：resetOnly 时只渲染访客 +「无法登录？」（不渲染通行密钥/密码入口）。
       PR3：根凭证不再是单独一行；锁屏凭证都没设置（启动站）时，「无法登录？」里的根凭证走 root-auth 引导。 */
    const resetOnly = !!cfg.resetOnly;
    const showPk = !resetOnly && cfg.passkey && hasPk;
    const showPw = !resetOnly && cfg.password;
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
      /* 4. PR3：「无法登录？」小字（原「重置锁屏」「根凭证」两行合并到这里）：点了弹层原地切到重置登录 */
      '<button type="button" class="sgx-sheet-cant" id="sgx-mopt-cant">' + (en ? 'Can’t sign in?' : '无法登录？') + '</button>' +
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
    /* 批次 A 验收修复 P2：方法行点击轻触觉反馈。(b) 行 busy 不适用：
       点击即关弹层并在同一 tick 打开下一态；通行密钥行 → openPk() 已有带转圈的加载态。 */
    const visitorBtn = sheet.querySelector('#sgx-mopt-visitor');
    const pkBtn = sheet.querySelector('#sgx-mopt-pk');
    const pwBtn = sheet.querySelector('#sgx-mopt-pw');
    const cantBtn = sheet.querySelector('#sgx-mopt-cant');
    const cardEl = /** @type {HTMLElement|null} */ (sheet.querySelector('.sgx-sheet-card'));
    if (visitorBtn) on(visitorBtn, 'click', function () { tapFeedback(); close(); openVerify(); });
    if (pkBtn) on(pkBtn, 'click', function () { tapFeedback(); close(); openPk(); });
    if (pwBtn) on(pwBtn, 'click', function () { tapFeedback(); close(); openPw(); });
    if (cantBtn && cardEl) on(cantBtn, 'click', function () { tapFeedback(); openResetInSheet(cardEl, cfg); });
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

  /** @param {boolean} [navigating] 重置完成要跳页：不把焦点还给头像 */
  function closeMethodSheet(navigating) {
    if (!methodSheet) return;
    const sheet = methodSheet;
    methodSheet = null;
    if (flow) {
      try { flow.destroy(); } catch (e) {}
      flow = null;
    }
    sheet.classList.remove('visible');
    if (sheet._onKey) {
      document.removeEventListener('keydown', sheet._onKey);
    }
    window.setTimeout(function () {
      if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
      /* 焦点回到头像 */
      if (navigating) return;
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
      pwFieldHtml({ id: 'sgx-pw-input', eyeId: 'sgx-pw-eye', autocomplete: 'current-password', pmUser: KEY_LOCK, ariaLabel: en ? 'Password' : '密码', placeholder: en ? 'Password' : '密码', en: en }) +
        '<p id="sgx-pw-count" class="sgx-pw-count" hidden></p>' +
        '<button type="button" class="sgx-verify-skip" id="sgx-pw-go">' + (en ? 'Unlock' : '确定') + '</button>'
    );
    clearErr();
    if (!openDialog()) return;
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('sgx-pw-input'));
    const eye = document.getElementById('sgx-pw-eye');
    const go = document.getElementById('sgx-pw-go');
    /* 批次 A 验收修复 P2：眼睛按钮走 bindEyeButton（初始 eye-off） */
    if (eye && input) bindPwEye(eye, input, en);
    armDlgKbFor(input);
    if (input) {
      onEnter(input, submitPw);
      focusNoScroll(input);
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

  /* ---------- 重置登录（PR3：方法弹层里的「无法登录？」原地切到 lib/reset-flow.js） ----------
     与账号页 /account/reset/ 同一个界面，提交不同：
     - 锁屏凭证已设置（或读不到配置，按已设置处理）：根凭证 → POST /api/lockreset verify；
       恢复开关有效直接拿到重置锁屏门票；否则服务端回 needOwner → 再验账号凭证（账号通行密钥 / 账号密码，
       与账号登录同一套验证行）→ 门票 → 去 /settings/security/lock/ 重设解锁方式。
     - 锁屏凭证都没设置（启动站）：根凭证 → POST /api/root-auth（锁屏门票 by=root）→ /api/root-session 换会话
       （原「根凭证」那一行；根凭证不再是单独的解锁入口）。
     根凭证只存在 reset-flow 的闭包里。 */
  /**
   * @param {HTMLElement} cardEl 方法弹层卡片
   * @param {{passkey:boolean, password:boolean, resetOnly?:boolean}} cfg
   */
  function openResetInSheet(cardEl, cfg) {
    const bootstrap = !cfg.resetOnly && !cfg.passkey && !cfg.password;
    const T = resetT(en);
    cardEl.innerHTML =
      '<div class="sheet-handle" aria-hidden="true"></div>' +
      '<h2 class="sgx-sheet-title" id="sgx-reset-title">' + T('title') + '</h2>' +
      '<div class="sgx-sheet-reset" id="sgx-sheet-reset"></div>';
    const sheetEl = /** @type {HTMLElement|null} */ (cardEl.closest('#sgx-method-sheet'));
    if (sheetEl) sheetEl.setAttribute('aria-label', T('title'));
    const host = /** @type {HTMLElement} */ (cardEl.querySelector('#sgx-sheet-reset'));
    /** @param {any} body @returns {Promise<{s:number, j:any}>} */
    const post = function (url, body) {
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) {
          return r.text().then(function (t) {
            let j = null;
            try { j = JSON.parse(t); } catch (e) {}
            return { s: r.status, j: j };
          });
        });
    };
    const netErr = function () { throw { message: en ? 'Network error' : '网络错误' }; };
    const tooMany = { message: en ? 'Too many attempts' : '尝试次数过多' };
    const failed = { message: en ? 'Verification failed' : '验证失败', clear: true };
    /* 键盘避让：根凭证框、第二步展开的账号密码框，聚焦时卡片随键盘上移（与其他弹层同一套 followKeyboard） */
    let kbStop = null;
    /** @type {any} */ let kbFor = null;
    on(host, 'focusin', function (/** @type {FocusEvent} */ e) {
      const tg = /** @type {any} */ (e.target);
      if (!tg || tg.tagName !== 'INPUT' || !tg.classList.contains('sgx-pw-input') || tg === kbFor) return;
      if (kbStop) { try { kbStop(); } catch (e2) {} }
      kbFor = tg;
      kbStop = followKeyboard(cardEl, tg);
    });
    flow = mountResetFlow({
      el: host,
      en: en,
      submitRoot: function (key) {
        if (bootstrap) {
          return post('/api/root-auth', { key: key }).then(function (res) {
            if (res.j && res.j.ok) {
              return exchangeRootSession().then(function (r2) {
                if (!r2.ok) throw { message: en ? 'Server error' : '服务器错误' };
              });
            }
            if (res.s === 429) throw tooMany;
            if (res.s === 503 || res.s === 500) throw { message: en ? 'Server error' : '服务器错误' };
            throw { message: en ? 'Wrong root credential' : '根凭证错误', clear: true };
          }, netErr);
        }
        return post('/api/lockreset', { action: 'verify', rootKey: key }).then(function (res) {
          if (res.s === 200 && res.j && res.j.ok) {
            return res.j.needOwner ? { needOwner: { passkey: !!res.j.passkey, password: !!res.j.password } } : {};
          }
          if (res.s === 429) throw tooMany;
          throw failed;
        }, netErr);
      },
      owner: function (rootKey) {
        const verify = function (proof) {
          return post('/api/lockreset', { action: 'verify', rootKey: rootKey, ownerProof: proof }).then(function (res) {
            if (res.s === 200 && res.j && res.j.ok && !res.j.needOwner) return;
            if (res.s === 429) throw tooMany;
            throw failed;
          }, netErr);
        };
        return {
          password: function (v) { return verify({ type: 'password', password: v }); },
          passkey: function () {
            return post('/api/lockreset', { action: 'challenge' }).then(function (res) {
              const j = res.j;
              if (!j || !j.ok) throw { message: en ? 'Failed to start' : '启动失败' };
              const allow = (j.allowCredentials || []).map(function (c) {
                return { id: b64urlToBuf(c.id), type: 'public-key' };
              });
              return getPasskeyAssertion({
                challenge: b64urlToBuf(j.challenge),
                rpId: j.rpId,
                allowCredentials: allow,
                userVerification: 'required',
              }, { hideEl: sheetEl || undefined }).then(function (cred) {
                return verify({
                  type: 'passkey',
                  cid: j.cid,
                  credential: {
                    rawId: bufToB64url(cred.rawId),
                    response: {
                      authenticatorData: bufToB64url(cred.response.authenticatorData),
                      clientDataJSON: bufToB64url(cred.response.clientDataJSON),
                      signature: bufToB64url(cred.response.signature),
                      userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : null,
                    },
                  },
                });
              }, function (err) {
                /* 取消 / 没有匹配钥匙（NotAllowedError）：行内提示，留在本页可重新选择 */
                if (err && err.kind === 'cancelled') throw { cancelled: true, message: en ? 'Cancelled, you can select again' : '已取消验证，可重新选择' };
                if (err && err.kind === 'nokey' && err.cause && err.cause.name === 'NotAllowedError') throw { cancelled: true, message: passkeyErrorText('nokey', en) };
                throw { message: err && err.kind ? passkeyErrorText(err.kind, en) : (en ? 'Passkey failed' : '通行密钥验证失败') };
              });
            }, function (e) {
              if (e && e.message) throw e;
              netErr();
            });
          },
        };
      },
      onDone: function () {
        if (kbStop) { try { kbStop(); } catch (e) {} kbStop = null; }
        closeMethodSheet(true);
        if (bootstrap) {
          /* 带 return：同样问服务端去哪（与其他解锁方式同一条路）；否则去安全与隐私 */
          if (qp('return')) {
            done = false;
            unlock();
          } else sgxNavigate(en ? '/en/settings/security/' : '/settings/security/');
          return;
        }
        /* 跳转到锁屏凭证管理页（重置锁屏门票可开此页，仍进不了主页） */
        sgxNavigate(en ? '/en/settings/security/lock/' : '/settings/security/lock/');
      },
    });
  }
  /** @type {{destroy: () => void}|null} */
  let flow = null;

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
  function pkFailed(msg) {
    if (dlgState !== 'passkey') return;
    setBody(
      '<div class="sgx-verify-loading"><p class="sgx-verify-failtx">' +
        (msg || (en ? 'Passkey verification failed' : '通行密钥验证失败')) +
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
        /* B1-2：用公共函数（隐藏弹层 + 30s 超时 + 4 档错误） */
        return getPasskeyAssertion(
          {
            challenge: b64urlToBuf(ch.challenge),
            allowCredentials: allow,
            userVerification: 'required',
          },
          { hideEl: document.querySelector('.sgx-verify-dlg') }
        ).then(function (cred) {
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
        if (e && e.kind) pkFailed(passkeyErrorText(e.kind, en));
        else pkFailed();
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
    /* 「解锁」按钮 = 点头像（同一个入口，不另走流程） */
    const go = document.getElementById('sgx-lock-go');
    if (go) on(go, 'click', function (e) { e.stopPropagation(); av.click(); });
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

  /* 锁屏显示期间：如果用户在别的标签页解锁了，切回来时自动检测并按服务端的 next 走 */
  bindRecheck();

  /* 首帧对账：页面是 locked 或根本没有会话标记（unknown）时立刻问服务端。
     服务端说有效 → 直接按 next 走，不让用户对着一个本来有效的会话再解一次锁（2026-10-21：
     这是「切到别的标签页再回来就自己解锁」的根因之一——以前只有切回来才对账，首帧不对账 unknown）。 */
  if (!isLocal) {
    askServer().then(function (ans) {
      if (!done && ans.ok) {
        try { console.warn('[sgx-lock] page said ' + pageState() + ' but session-check ok'); } catch (e) {}
        onServerOk(ans);
      }
    });
  }
}
