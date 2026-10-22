/**
 * @fileoverview 账号 → 重置登录（/account/reset/，PR3）。
 *
 * 与锁屏弹层里的「无法登录？」同一个界面（lib/reset-flow.js），只是提交不同：
 * 根凭证 → POST /api/root-auth { key, purpose:'account' } → 服务端签账号会话 + 账号门票（by=root）
 * → 直接进 账号 → 安全与隐私（门票已有效，不用再过门），在那里重设账号密码 / 删除或添加通行密钥。
 */
import { sgxReplace } from '../lib/diag-jumptrace.js';
import { mountResetFlow } from '../lib/reset-flow.js';
import { createT, securityUrl } from './account-common.js';
import { accountSubmitters } from '../lib/account-methods.js';

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
