/**
 * @fileoverview 管理凭证索引页（定稿 #31）：锁屏 / 应用两个入口 + 状态摘要。
 * 进门探针用 /api/lock-status（接受 stepup scope=keys），无效则跳回安全与隐私页。
 */
import { enterDoor, clearStepupThen } from './app-gate.js';

(function () {
  const en = document.documentElement.lang === 'en';
  /** @param {string} id */
  function $(id) {
    return document.getElementById(id);
  }

  /** @param {string} k */
  function t(k) {
    const map = {
      sessExp: en ? 'Session expired, please verify again' : '会话已过期，请重新验证',
      errStepupExpired: en ? 'Verification expired, please verify again' : '验证已过期，请重新验证',
      errNetwork: en ? 'Network connection failed, please retry' : '网络连接失败，请重试',
      errParse: en ? 'Bad server response, please retry' : '服务响应异常，请重试',
      lockSub: en ? 'Unlock password and passkeys' : '解锁密码和通行密钥',
      appsSub: en ? 'App keys' : '应用钥匙',
    };
    return map[k] || k;
  }

  /* 进门探针：/api/lock-status 接受有效的管理门票据 */
  function probe() {
    return fetch('/api/lock-status', { method: 'GET', credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) {
          /* 填充状态摘要 */
          const lockSub = $('mgmt-lock-sub');
          if (lockSub) {
            const parts = [];
            if (j.password) parts.push(en ? 'Password set' : '已设密码');
            if (j.passkey) parts.push(en ? 'Passkey set' : '已设通行密钥');
            lockSub.textContent = parts.length ? parts.join(' · ') : t('lockSub');
          }
          return true;
        }
        return false;
      })
      .catch(function () { return false; });
  }

  function onEnter() {
    /* 应用摘要：固定显示 Book（目前唯一应用） */
    const appsSub = $('mgmt-apps-sub');
    if (appsSub) appsSub.textContent = 'Book';
  }

  /* C2b：只在索引页（离开管理凭证区时）清票后跳安全页。
     锁屏/应用/Book 页都不加（返回目标仍在门内，加了会误清）。
     捕获阶段监听 [data-go-back]，抢在 navhistory.js 的委托之前。 */
  window.addEventListener('click', function (e) {
    let el = null;
    try {
      el = e.target && e.target.closest ? e.target.closest('[data-go-back]') : null;
    } catch (_) {}
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    clearStepupThen(en ? '/en/settings/security/' : '/settings/security/');
  }, true);

  /* C2b：系统返回手势（popstate）从索引页离开时同样清票。
     popstate 无法可靠拦截（浏览器立即导航），用 keepalive fetch 尽力而为：
     即使页面卸载，请求仍会发出，服务端清票。不阻止导航，不干扰 inpagenav。 */
  window.addEventListener('popstate', function () {
    try {
      fetch('/api/stepup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear' }),
        credentials: 'include',
        keepalive: true,
      }).catch(function () {});
    } catch (e) {}
  });

  enterDoor(probe, onEnter, t);
})();
