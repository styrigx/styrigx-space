/**
 * SGX 子站自动锁定检查
 * 主站「立即锁定」后，已打开的 blog 标签页切回来时自动跳到锁屏。
 *
 * 原理：会话 Cookie 是 HttpOnly，子域名不同源，BroadcastChannel 收不到，
 * 只能由页面在变为可见时主动问服务器 /api/lock-session-check（主站网关 workers/auth-gateway/src/subsites.js 回答）：
 * - 204：会话仍有效，什么都不做
 * - 401 {ok:false, why}：why 只有 no-cookie / invalid-session 两种（与网关页面 302 的 why 同一套）；
 *   跳主站锁屏 https://styrigx.com/?lock=1&why=<why>&return=<当前地址>（参数顺序同网关 lockRedirect）
 * - 其他状态码 / 网络错误：不跳转，下次再查
 * 回跳地址先去掉当前地址里已有的 lock / why / return 参数，防止一层层嵌套越跳越长。
 * 单测：tests/sgx-lock-check.test.mjs
 */
(function () {
  'use strict';

  var LAST_CHECK = 0;
  var CHECK_INTERVAL = 5000; // 节流：5 秒一次
  var MAIN_ORIGIN = 'https://styrigx.com';
  /* 网关 401 的原因名（主站 subsites.js）；不认识的 / 解析失败一律当 invalid-session */
  var REASONS = { 'no-cookie': 1, 'invalid-session': 1 };
  var STRIP = ['lock', 'why', 'return'];

  /** 当前地址去掉 lock / why / return 参数（保留其他参数和 #hash） */
  function returnUrl(href) {
    try {
      var u = new URL(href);
      for (var i = 0; i < STRIP.length; i++) u.searchParams.delete(STRIP[i]);
      return u.href;
    } catch (e) {
      return href;
    }
  }

  function lockTarget(why, href) {
    return MAIN_ORIGIN + '/?lock=1&why=' + encodeURIComponent(why) +
      '&return=' + encodeURIComponent(returnUrl(href));
  }

  function checkLock() {
    var now = Date.now();
    if (now - LAST_CHECK < CHECK_INTERVAL) return;
    LAST_CHECK = now;

    fetch('/api/lock-session-check', {
      credentials: 'same-origin',
      cache: 'no-store',
    })
      .then(function (r) {
        if (r.status === 204) return; // 仍然有效，什么都不做
        if (r.status === 401) {
          return r.json().catch(function () { return null; }).then(function (d) {
            var why = d && typeof d.why === 'string' && REASONS[d.why] === 1 ? d.why : 'invalid-session';
            window.location.replace(lockTarget(why, window.location.href));
          });
        }
        // 其他状态码：不跳转，下次再查
      })
      .catch(function () {
        // 网络错误：不跳转，下次再查
      });
  }

  // visibilitychange 变为 visible 时检查
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') checkLock();
  });

  // focus 时检查
  window.addEventListener('focus', checkLock);

  // pageshow（含 bfcache 恢复）时检查
  window.addEventListener('pageshow', function (e) {
    if (e && e.persisted) checkLock();
  });
})();
