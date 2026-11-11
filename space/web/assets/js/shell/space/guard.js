/**
 * @fileoverview 进站守卫（core chunk 里只有这一小块；原 shell/lock-guard.js，进站 v3 L1 搬进 shell/space/）。
 * v5 S3（整站放开）起页面对所有人都是同一份内容，守卫不再盖遮罩：
 * - 读网关注入的 <html data-sgx-lock-session>（valid / locked；没有 = 页面没经过网关，按没进站算，不画锁屏）
 * - valid：绑自动回锁（切回前台问服务端，401 → 重载，服务端画访客态页面；2b：有 v6 登录标记时先问 whoami，v6 身份还在就不重载）
 * - 2c：v6 su / exit / lock 之后顶栏就地切标记（SESSION_EVENT live），这里切成 valid 时补绑自动回锁；标记是 locked 时自动回锁不查
 * - v5 S5 起没有锁屏界面了：进站是在终端里 sudo styrigx（shell/space/layer.js）。旧地址 ?entry=…（分享链接失效时网关回的 /?entry=1、旧书签）
 *   由终端接（topbar-panel.js：打开终端、预填 sudo styrigx；?entry=sudo 直接跑），守卫只负责已解锁页面的自动回锁
 * 进门二值（P2-3）：没有等级；进门之后的事（锁侧复验、账号）由各接口自己要。
 * 去处判定（askServer / proceed）和本地开发判断放这里，终端的钥匙层从这里 import，两边是同一份。
 */
import { sgxReplace, sgxReload } from '../../lib/diag-jumptrace.js';
import { spaceState } from './state.js';
import { API } from './paths.js';

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
   进站状态机。唯一状态源：服务端。
   - 页面状态 pageState()：网关注入的 <html data-sgx-lock-session>：valid / locked；没有这个属性 = unknown
     （页面没经过网关：本地开发、测试构建、缓存）。unknown 不画锁屏，各部件照常调接口，接口 401 再按没进站处理。
   - 服务端回答 askServer()：GET /api/lock-session-check[?return=]：{ok, by, exp, next}。
     next 是服务端校验过的去处（与首页 302 同一个 resolveReturn）；前端不做白名单，只照着跳。
     by（进门方式）只用于展示，记进 spaceState.by；不分等级。
   - 终端里解锁成功走 proceed(answer)：
       next 是别处  → location.replace(next)（站内原页面或子站）
       没有 next    → 页面是 locked 就换到干净地址重新取一次（服务端画 valid，上锁的部件按进站态重画），
                      valid / unknown 就原地开锁并把地址里的 entry/lock/why/return 去掉
   - 已解锁页面切回前台：问服务端，401 → 重载（服务端画访客态）。立即锁定 = 服务端清 cookie。
   - 本地 sessionStorage 只记「刚跳过哪里」防死循环，从不记解锁状态。
   ============================================================ */

/** 页面标记变了的事件（window 上，detail { ok, live }）：首帧 initLock 发一次（没有 live）；2c 起 v6 su / exit / lock 之后
 *  顶栏（topbar-panel.js switchPageSession）就地切标记时发 live: true，云同步 / 名片 / AI 窗口 / 服务状态页各自接，不整页刷新 */
export const SESSION_EVENT = 'sgx:session';

/** @returns {'valid'|'locked'|'unknown'} */
export function pageState() {
  const s = document.documentElement.dataset.sgxLockSession;
  return s === 'valid' || s === 'locked' ? s : 'unknown';
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
 * @returns {Promise<{ok:boolean, by?:string, exp?:number, next?:string|null}>}
 */
export function askServer() {
  const ret = qp('return');
  const url = API.sessionCheck + (ret ? '?return=' + encodeURIComponent(ret) : '');
  return fetch(url, { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) {
      if (!r.ok) return { ok: false };
      return r.json().catch(function () { return { ok: false }; });
    })
    .then(function (d) {
      if (!d || d.ok !== true) return { ok: false };
      spaceState.by = typeof d.by === 'string' ? d.by : '';
      return d;
    })
    .catch(function () { return { ok: false }; });
}

/** 当前地址去掉 entry / lock（旧参数，兼容读一版）/ why（v5 S3 前网关踢回带的，旧书签）/ return（其余参数、hash 原样） */
function cleanUrl() {
  try {
    const u = new URL(window.location.href);
    u.searchParams.delete('entry');
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
 * @param {{next?:string|null}} ans
 * @param {() => void} unlockInPlace 原地开锁（收掉开机动画）
 * @returns {'navigate'|'in-place'}
 */
export function proceed(ans, unlockInPlace) {
  if (ans.next) {
    if (!sameAsCurrent(ans.next)) {
      sgxReplace(ans.next);
      return 'navigate';
    }
  }
  const clean = cleanUrl();
  if (pageState() === 'locked' && reloadGuardOk(clean)) {
    /* 访客态页面（上锁的部件画成了锁）：重新取一次，服务端会画 valid */
    sgxReplace(clean);
    return 'navigate';
  }
  try { history.replaceState(history.state, '', clean); } catch (e) {}
  unlockInPlace();
  return 'in-place';
}

/** 页面上有没有 v6 登录标记（服务端随 sgx-session 写的 sgx-id=1；非 HttpOnly、不含秘密，同 shell/identity/api.js hasMarker） */
export function hasV6Marker() {
  try { return /(?:^|;\s*)sgx-id=1(?:;|$)/.test(document.cookie || ''); } catch (e) { return false; }
}

/**
 * v6 新会话还在不在（POST /api/identity whoami）：true = 有身份 / false = 没有（服务端顺手清标记）/ null = 没问到（网络错，不当没有）。
 * 守卫不 import shell/identity/api.js（那边带通行密钥代码），这里只发这一个请求。
 * @returns {Promise<boolean|null>}
 */
export function v6SignedIn() {
  return fetch(API.identity, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'whoami' }),
  }).then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { return j && j.ok === true ? !!(j.user && j.user.name) : null; }, function () { return null; });
}

/* 已解锁页面：切回前台 / bfcache 恢复 / 转屏时向服务端确认，401 → 重载（服务端画访客态页面）。
   节流 5 秒；网络错误不跳转，下次再查。
   2b：页面是 valid 也可能只因为 v6 新会话（网关 pageStateOf）；旧进站会话 401 时有 v6 登录标记就再问 whoami，
   v6 身份还在就不重载（重载了服务端照样画 valid，每次切回前台都会白刷一次），没了才重载。 */
let lastLockCheck = 0;
function checkSessionForAutoLock() {
  /* 2c：v6 exit / lock 就地切回 locked 的页面不再查（访客态已经画好了，查了只会白刷一次） */
  if (pageState() !== 'valid') return;
  const now = Date.now();
  if (now - lastLockCheck < 5000) return;
  lastLockCheck = now;
  fetch(API.sessionCheck, { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) {
      if (r.status !== 401) return;
      if (!hasV6Marker()) { sgxReload(); return; }
      return v6SignedIn().then(function (on) { if (on === false) sgxReload(); });
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
 * 初始化（主站每页；子站不加载守卫）。
 */
export function initLock() {
  /* Hark：CI 测试构建禁用锁屏（构建期 define，线上无绕过） */
  if (SGX_TEST_NO_LOCK) return;
  if (!SGX_FEAT_LOCK_GATE) return;
  const state = pageState();
  try {
    window.dispatchEvent(new CustomEvent('sgx:session', { detail: { ok: state === 'valid' } }));
  } catch (e) {}
  if (state === 'valid') bindAutoLock();
  /* 2c：su 之后就地切成 valid 的页面也绑自动回锁 */
  window.addEventListener(SESSION_EVENT, function (/** @type {any} */ e) { if (e && e.detail && e.detail.live && e.detail.ok) bindAutoLock(); });
}
