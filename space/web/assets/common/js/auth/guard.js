/**
 * @fileoverview 进站守卫（core chunk 里只有这一小块）：已登录页面的自动回锁。
 * v5 S3（整站放开）起页面对所有人都是同一份内容，守卫不盖遮罩：
 * - 读网关注入的 <html data-sgx-lock-session>（valid / locked；没有 = 页面没经过网关，按没登录算）
 * - valid：绑自动回锁（切回前台问服务端 whoami，v6 身份没了 → 重载，服务端画访客态页面）
 * - 2c：v6 su / exit / lock 之后顶栏就地切标记（SESSION_EVENT live），这里切成 valid 时补绑自动回锁；标记是 locked 时自动回锁不查
 * v6 P4（定稿 v5.2 §十三：删 space-core 进站签发）起只认 v6 会话：不再问旧的 GET /api/lock-session-check，旧的进站 / 解锁流程删了。
 */
import { sgxReload } from '../status/diag-jumptrace.js';

/** v6 身份接口（同 identity/api.js IDENTITY_API；守卫不 import 那边，那边带通行密钥代码） */
const IDENTITY_API = '/api/identity';

/** 页面标记变了的事件（window 上，detail { ok, live }）：首帧 initLock 发一次（没有 live）；2c 起 v6 su / exit / lock 之后
 *  顶栏（topbar-panel.js switchPageSession）就地切标记时发 live: true，云同步 / 名片 / AI 窗口 / 服务状态页各自接，不整页刷新 */
export const SESSION_EVENT = 'sgx:session';

/** @returns {'valid'|'locked'|'unknown'} */
export function pageState() {
  const s = document.documentElement.dataset.sgxLockSession;
  return s === 'valid' || s === 'locked' ? s : 'unknown';
}

/** 页面上有没有 v6 登录标记（服务端随 sgx-session 写的 sgx-id=1；非 HttpOnly、不含秘密，同 identity/api.js hasMarker） */
export function hasV6Marker() {
  try { return /(?:^|;\s*)sgx-id=1(?:;|$)/.test(document.cookie || ''); } catch (e) { return false; }
}

/**
 * v6 会话还在不在（POST /api/identity whoami）：true = 有身份 / false = 没有（服务端顺手清标记）/ null = 没问到（网络错，不当没有）。
 * @returns {Promise<boolean|null>}
 */
export function v6SignedIn() {
  return fetch(IDENTITY_API, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'whoami' }),
  }).then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { return j && j.ok === true ? !!(j.user && j.user.name) : null; }, function () { return null; });
}

/* 已登录页面：切回前台 / bfcache 恢复 / 转屏时向服务端确认，v6 身份没了 → 重载（服务端画访客态页面）。
   节流 5 秒；网络错误不跳转，下次再查。没有 v6 登录标记 = 已经退出了（服务端清标记）→ 直接重载。 */
let lastLockCheck = 0;
function checkSessionForAutoLock() {
  /* 2c：v6 exit / lock 就地切回 locked 的页面不再查（访客态已经画好了，查了只会白刷一次） */
  if (pageState() !== 'valid') return;
  const now = Date.now();
  if (now - lastLockCheck < 5000) return;
  lastLockCheck = now;
  if (!hasV6Marker()) { sgxReload(); return; }
  v6SignedIn().then(function (on) { if (on === false) sgxReload(); }, function () {});
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
