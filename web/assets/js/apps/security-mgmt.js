/**
 * @fileoverview 管理凭证索引页（定稿 #31）：锁屏 / 应用两个入口 + 状态摘要。
 * 进门探针用 /api/lock-status（接受 stepup scope=keys），无效则跳回安全与隐私页。
 */
import { enterDoor, clearStepupThen, startDoorCountdown } from './app-gate.js';
import { stepupFetch } from '../lib/auth-flow.js';

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
      errOwnerConfigured: en ? 'Owner credential is set, please verify with the owner credential again' : '站长凭证已设置，请用站长凭证重新验证',
      doorCountdown: en ? 'Verification remaining {m}' : '验证剩余 {m}',
      doorCountdownExpired: en ? 'Expired' : '已过期',
      expiredStepupTitle: en ? 'Verification expired' : '验证已过期',
      expiredStepupDesc: en ? 'Verification has expired. Please verify again.' : '验证已过期，请重新验证',
      expiredStepupBtn: en ? 'Back to Security & Privacy' : '返回安全与隐私',
      expiredSessionTitle: en ? 'Session expired' : '会话已失效',
      expiredSessionDesc: en ? 'Your session has expired. Please go back to the lock screen.' : '会话已失效，请重新进入锁屏。',
      expiredSessionBtn: en ? 'Go to lock screen' : '去锁屏',
      lockSub: en ? 'Unlock password and passkeys' : '解锁密码和通行密钥',
      appsSub: en ? 'App keys' : '应用钥匙',
    };
    return map[k] || k;
  }

  /* 进门探针：/api/lock-status 接受有效的管理门票据。
     A-1：失败带回真实 reason/detail（enterDoor 按原因分流到弹框/面板），不再吞成 false。 */
  function probe() {
    return fetch('/api/lock-status', { method: 'GET', credentials: 'same-origin' })
      .then(function (r) {
        return r.json().then(function (j) {
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
          return { ok: false, reason: (j && j.error) || 'session', detail: j && j.reason, status: r.status, api: 'GET /api/lock-status' };
        }).catch(function () {
          return { ok: false, reason: 'parse', status: r.status, api: 'GET /api/lock-status' };
        });
      })
      .catch(function () { return { ok: false, reason: 'network', status: 0, api: 'GET /api/lock-status' }; });
  }

  function onEnter() {
    /* 探针通过后才渲染门内内容（入口区默认 hidden，见模板） */
    const main = $('mgmt-main');
    if (main) main.hidden = false;
    startDoorCountdown(t);
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
     即使页面卸载，请求仍会发出，服务端清票。不阻止导航。
     审查返工：只在「即将离开索引页、目标不在管理凭证区」时才清。
     从锁屏/应用子页返回索引页时，popstate 也会在索引页触发（bfcache 恢复或同文档历史），
     此时目标仍在门内，清票会误清，导致回索引页后再点锁屏/应用要求重新验证。
     目标判定：popstate 触发时 window.location 已更新为目标 URL；event.state.url 也可作参考。 */
  window.addEventListener('popstate', function (e) {
    let dest = '';
    try {
      /* 优先用 state.url（pushState 时写入），回退到当前 location */
      if (e && e.state && e.state.url) {
        dest = new URL(e.state.url, window.location.origin).pathname;
      } else {
        dest = window.location.pathname;
      }
    } catch (_) {
      dest = window.location.pathname;
    }
    /* 管理凭证区路径（含 /en/）：索引页、锁屏、应用、Book 子页 */
    const inMgmtArea = dest === '/settings/security/mgmt/' || dest === '/en/settings/security/mgmt/' ||
      dest === '/settings/security/lock/' || dest === '/en/settings/security/lock/' ||
      dest === '/settings/security/apps/' || dest === '/en/settings/security/apps/' ||
      dest === '/settings/security/apps/book/' || dest === '/en/settings/security/apps/book/';
    /* 目标仍在门内：不清除（回索引页后再进锁屏/应用不要求重新验证） */
    if (inMgmtArea) return;
    try {
      stepupFetch('clear', { keepalive: true }).catch(function () {});
    } catch (e2) {}
  });

  enterDoor(probe, onEnter, t);
})();
