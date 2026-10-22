/**
 * @fileoverview 账号 → 账号信息（/account/profile/）：已登录卡 + 退出账号。
 *
 * - 进页 GET /api/account：没有账号会话（访客 / 只有锁屏会话 / 读失败）→ 回账号页登录，登录后回本页
 * - 退出账号：POST /api/account logout（清账号会话和门票）→ 回账号页（登录区）
 */
import { on } from '../lib/events.js';
import { toast } from '../lib/toast.js';
import { sgxReplace } from '../lib/diag-jumptrace.js';
import { accountUrl, createT } from './account-common.js';
import { ACCOUNT_API, postJSON } from '../lib/account-api.js';

(function () {
  const en = document.documentElement.lang === 'en';
  const t = createT(en);
  const root = document.getElementById('acct-profile');
  if (!root) return;

  function goLogin() {
    sgxReplace(accountUrl(en) + '?return=' + encodeURIComponent(location.pathname));
  }

  const logout = document.getElementById('acct-logout');
  if (logout) {
    on(logout, 'click', function () {
      postJSON(ACCOUNT_API, { action: 'logout' }).then(function () {
        toast(t('loggedOut'));
        sgxReplace(accountUrl(en));
      }, function () {
        toast(t('errNetwork'));
      });
    });
  }

  fetch(ACCOUNT_API, { method: 'GET', credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!(j && j.ok && j.session)) {
        goLogin();
        return;
      }
      const by = j.session.by || '';
      const byEl = document.getElementById('acct-by');
      if (byEl) byEl.textContent = by === 'root' ? t('byRoot') : by === 'passkey' ? t('byPasskey') : t('byPassword');
      root.hidden = false;
    })
    .catch(goLogin);
})();
