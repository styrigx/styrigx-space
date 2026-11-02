/**
 * @fileoverview 锁屏守卫（core chunk 里只有这一小块；frontend-js #6，2026-10-26 从 lock.js 拆出）。
 * - 读网关注入的 <html data-sgx-lock-session> 判断页面状态；valid 页只绑自动锁定（切回前台问服务端，401 → 重载）
 * - locked / unknown：先同步盖一层不透明遮罩（fail closed，和以前直接画锁屏同一时刻），再 import() 锁屏界面（shell/lock.js）；
 *   界面加载失败时遮罩不撤，只给「重新加载」按钮——绝不因为脚本没取到而露出页面
 * - 访客升级（data-sgx-upgrade="1"）：同样按需 import() shell/upgrade.js
 * 锁屏界面、升级层、auth-sheet / auth-flow / reset-flow / passkey-assert 这些只在锁屏 / 升级时用的模块因此不在每页的 core 里。
 * 去处判定（askServer / proceed）和本地开发判断放这里，锁屏界面从这里 import，两边是同一份。
 */
import { sgxNavigate, sgxReplace, sgxReload } from '../lib/diag-jumptrace.js';

/**
 * 是否本地开发（无 Functions 后端）。
 * 测试可用 ?test-no-local-bypass=1 强制走线上逻辑（调 lock-session-check）。
 */
export function isLocalDev() {
  try {
    if (new URLSearchParams(location.search).has('test-no-local-bypass')) return false;
  } catch (e) {}
  return /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
}

/* ============================================================
   锁屏状态机（2026-10-21 重写判定部分；界面不变）。唯一状态源：服务端。
   - 页面状态 pageState()：网关注入的 <html data-sgx-lock-session>：
       valid / locked / lock-reset；没有这个属性 = unknown（页面没经过网关，例如路由漏了这种 URL，
       或缓存/测试环境）。unknown 一律先画锁屏（fail closed），并立刻问服务端。
   - 服务端回答 askServer()：GET /api/lock-session-check[?return=]：{ok, role, next, upgrade}。
     next 是服务端校验过的去处（与首页 302 同一个 resolveReturn）；前端不做白名单，只照着跳。
   - 解锁成功 / 切回标签页 / bfcache 恢复 / 首帧对账，都走同一个 proceed(answer)：
       upgrade      → 去首页 ?return=（服务端给 admin 验证层，不出锁屏）
       next 是别处  → location.replace(next)（子站或站内原页面）
       没有 next    → 页面是 locked（锁屏态被瘦身过）就换到干净地址重新取一次（服务端画 valid），
                      valid / unknown 就原地开锁并把地址里的 lock/why/return 去掉
     每一条都不会「重载同一个地址再等服务端 302」——那依赖锁屏页本身过网关，线上曾经不成立，
     结果就是解锁后又回到锁屏（2026-10-21 用户报告）。
   - 已解锁页面切回前台：问服务端，401 → 重载（服务端画锁屏）。立即锁定 = 服务端清 cookie。
   - 本地 sessionStorage 只记「刚跳过哪里」防死循环，从不记解锁状态。
   ============================================================ */

/** @returns {'valid'|'locked'|'lock-reset'|'unknown'} */
export function pageState() {
  const s = document.documentElement.dataset.sgxLockSession;
  return s === 'valid' || s === 'locked' || s === 'lock-reset' ? s : 'unknown';
}

/** @param {string} k */
export function qp(k) {
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
export function askServer() {
  const ret = qp('return');
  const url = '/api/lock-session-check' + (ret ? '?return=' + encodeURIComponent(ret) : '');
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
      '<button type="button" class="sgx-credential-btn-primary" id="sgx-subsite-home">' + homeText + '</button>';
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
export function proceed(ans, unlockInPlace) {
  const why = qp('why');
  if (ans.upgrade && ans.next) {
    /* 访客 + admin 专属去处：首页 ?return= 由服务端给 admin 验证层（不出锁屏） */
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
  fetch('/api/lock-session-check', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) {
      if (r.status === 401) sgxReload();
    })
    .catch(function () {});
}
let autoLockBound = false;
export function bindAutoLock() {
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
  if (!SGX_FEAT_LOCK_GATE) return;
  if (isLocalDev()) {
    /* 本地开发没有后端，直接显示锁屏 */
    openLockScreen();
    return;
  }
  const state = pageState();
  try {
    window.dispatchEvent(new CustomEvent('sgx:session', { detail: { ok: state === 'valid' } }));
  } catch (e) {}
  if (state === 'lock-reset') return; /* LockResetTicket页：落地页需可操作 */
  if (state === 'valid') {
    bindAutoLock();
    /* 子站踢回（带 why）但主站会话有效：问服务端 next，回子站（20 秒窗口防死循环）。
       admin 验证页（data-sgx-upgrade）带 return 但不能跳走。 */
    if (qp('why') && qp('return') && document.documentElement.getAttribute('data-sgx-upgrade') !== '1') {
      askServer().then(function (ans) {
        if (ans.ok) proceed(ans, function () {});
      });
    }
    return;
  }
  /* locked / unknown：先盖遮罩再按需加载锁屏（fail closed），锁屏里立刻对账 */
  openLockScreen();
}

/* ============================================================
   按需加载锁屏界面 / 升级层（frontend-js #6）
   ============================================================ */

/** 锁屏界面加载前的遮罩：不透明、盖住整页、挡住点击和读屏（fail closed） */
function showLockCover() {
  let c = document.getElementById('sgx-lock-cover');
  if (c) return c;
  c = document.createElement('div');
  c.id = 'sgx-lock-cover';
  c.setAttribute('aria-busy', 'true');
  c.style.cssText = 'position:fixed;inset:0;z-index:301;background:var(--m-surface,#000);display:flex;align-items:center;justify-content:center;';
  document.body.appendChild(c);
  document.body.classList.add('sgx-locked');
  return c;
}

/** 锁屏界面脚本没取到（断网 / 部署换代）：遮罩不撤，给一个重新加载按钮 @param {HTMLElement} cover */
function lockLoadFailed(cover) {
  const en = document.documentElement.lang === 'en';
  cover.removeAttribute('aria-busy');
  cover.innerHTML = '<button type="button" class="sgx-credential-btn-primary" id="sgx-lock-cover-retry">' +
    (en ? 'Reload' : '重新加载') + '</button>';
  const btn = document.getElementById('sgx-lock-cover-retry');
  if (btn) btn.addEventListener('click', function () { sgxReload(); });
}

/* 页面自带验证门（锁屏凭证页等）已接管：之后不再画全局锁屏。见 releaseLockScreen() */
let lockReleased = false;

function openLockScreen() {
  if (lockReleased) return;
  const cover = showLockCover();
  import('./lock.js')
    .then(function (m) {
      /* 界面脚本按需加载期间页面自带的门已经接管（releaseLockScreen）：不再画锁屏，否则会盖在门 / 管理区上 */
      if (lockReleased) return;
      m.showLockScreen();
    })
    .catch(function () {
      if (!lockReleased) lockLoadFailed(cover);
    });
}

/**
 * 页面自带验证门（锁屏凭证页 apps/security-lock.js、门内页 apps/app-gate.js）进门 / 显示门口 / 显示失败原因时调用：
 * 撤掉全局锁屏（已画的锁屏、守卫的遮罩），并让还在加载中的锁屏界面不再画上来。
 * 以前锁屏是同步画的，页面晚些时候删掉 #sgx-lock 就够了；#6 之后锁屏界面是 import() 按需加载、晚于页面的请求返回，
 * 只删 DOM 会被随后画上的锁屏重新盖住（2026-10-26 passkey-e2e「锁屏凭证页：添加通行密钥」回归的根因）。
 * 这些页面本来就以自己的门为准（服务端 reauth 票），不靠全局锁屏，所以「释放」是粘性的、只对本页生效。
 */
export function releaseLockScreen() {
  lockReleased = true;
  try {
    const gl = document.getElementById('sgx-lock');
    if (gl) gl.remove();
    const cover = document.getElementById('sgx-lock-cover');
    if (cover) cover.remove();
    document.body.classList.remove('sgx-locked');
  } catch (e) {}
}

/**
 * 访客升级验证层：页面带 data-sgx-upgrade="1" 时按需加载 shell/upgrade.js 打开。
 */
export function initUpgrade() {
  const html = document.documentElement;
  if (html.getAttribute('data-sgx-upgrade') !== '1') return;
  const ret = html.getAttribute('data-sgx-upgrade-return') || '/';
  import('./upgrade.js').then(function (m) { m.openAdminVerify(ret); }).catch(function () {});
}
