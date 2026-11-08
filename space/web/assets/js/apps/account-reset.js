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
import { ACCOUNT_API, postJSON } from '../auth/account-api.js';
import { KEY_ROOT } from '../lib/key-names.js';
import { i18nTable } from '../lib/i18n.js';
/** 界面文案：页面字符串表 #sgx-i18n-core（语言包化 2026-11-07） */
const ct = i18nTable('core');

(function () {
  const el = document.getElementById('acct-reset');
  if (!el) return;
  const en = document.documentElement.lang === 'en';
  const t = createT();
  /** 重置登录（账号）第一步：恢复密钥 → AccountResetTicket（3 分钟；不签账号会话，设好新凭证后正常登录）。
   *  原在 auth/account-methods.js 的登录提交器里（X4，2026-11-08 搬来：恢复密钥只给 reset 用）。 @param {string} value */
  function submitRecovery(value) {
    return postJSON(ACCOUNT_API, { action: 'root-reset', key: value }).then(function (res) {
      if (res.j && res.j.ok) return;
      if (res.s === 429) throw { message: t('errLocked') };
      if (res.j && res.j.error === 'config') throw { message: t('errConfig') };
      /* 401：统一提示恢复密钥不正确 */
      throw { message: t('errWrongRoot'), clear: true };
    }, function () {
      throw { message: t('errNetwork') };
    });
  }
  mountResetFlow({
    el: el,
    en: en,
    /* 账号侧：账号根凭证（root-reset），文案与原来一致 */
    keyKind: 'root',
    pmUser: KEY_ROOT,
    keyText: { lead: ct('rfRootLead'), ph: ct('rfRootPh'), empty: ct('rfRootEmpty') },
    submitKey: submitRecovery,
    onDone: function () { sgxReplace(securityUrl(en)); },
  });
})();
