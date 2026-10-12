/**
 * @fileoverview 管理凭证索引页（定稿 #31）：锁屏 / 应用两个入口 + 状态摘要。
 * 进门探针用 /api/lock-status（接受 stepup scope=keys），无效则跳回安全与隐私页。
 */
import { enterDoor } from './app-gate.js';

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

  enterDoor(probe, onEnter, t);
})();
