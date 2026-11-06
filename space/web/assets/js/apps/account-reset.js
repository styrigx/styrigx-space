/**
 * @fileoverview 账号 → 重置登录（/account/reset/，PR3）。
 *
 * 与锁屏弹层里的「无法登录？」同一个界面（auth/reset-flow.js），只是提交不同：
 * 账号根密钥 → POST /api/account { action:'root-reset', key } → 账号 Worker 只签 AccountResetTicket（by=root，3 分钟）
 * → 直接进 账号 → 账号安全（reset 票已有效，不用再验证），在那里重设账号密码 / 删除或添加通行密钥，
 * 然后回账号页用新凭证正常登录（账号根凭证不签账号会话）。
 */
import { sgxReplace } from '../lib/diag-jumptrace.js';
import { mountResetFlow } from '../auth/reset-flow.js';
import { createT, securityUrl } from './account-common.js';
import { accountSubmitters } from '../auth/account-methods.js';
import { KEY_ROOT } from '../lib/key-names.js';

(function () {
  const el = document.getElementById('acct-reset');
  if (!el) return;
  const en = document.documentElement.lang === 'en';
  const t = createT(en);
  const sub = accountSubmitters(t);
  mountResetFlow({
    el: el,
    en: en,
    /* 账号侧：账号根凭证（root-reset），文案与原来一致 */
    keyKind: 'root',
    pmUser: KEY_ROOT,
    keyText: en
      ? { lead: 'First, verify with your root credential', ph: 'Root credential', empty: 'Enter root credential' }
      : { lead: '先用根凭证验证身份', ph: '根凭证', empty: '请输入根凭证' },
    submitKey: function (key) { return sub.root(key); },
    onDone: function () { sgxReplace(securityUrl(en)); },
  });
})();
