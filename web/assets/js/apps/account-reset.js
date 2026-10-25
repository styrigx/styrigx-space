/**
 * @fileoverview 账号 → 重置登录（/account/reset/，PR3）。
 *
 * 与锁屏弹层里的「无法登录？」同一个界面（auth/reset-flow.js），只是提交不同：
 * 根凭证 → POST /api/root-auth { key, purpose:'account-reset' } → 服务端只签 AccountResetTicket（by=root，3 分钟）
 * → 直接进 账号 → 账号安全（reset 票已有效，不用再验证），在那里重设账号密码 / 删除或添加通行密钥，
 * 然后回账号页用新凭证正常登录（根凭证不签账号会话）。
 */
import { sgxReplace } from '../lib/diag-jumptrace.js';
import { mountResetFlow } from '../auth/reset-flow.js';
import { createT, securityUrl } from './account-common.js';
import { accountSubmitters } from '../auth/account-methods.js';

(function () {
  const el = document.getElementById('acct-reset');
  if (!el) return;
  const en = document.documentElement.lang === 'en';
  const t = createT(en);
  const sub = accountSubmitters(t);
  mountResetFlow({
    el: el,
    en: en,
    submitRoot: function (key) { return sub.root(key); },
    onDone: function () { sgxReplace(securityUrl(en)); },
  });
})();
