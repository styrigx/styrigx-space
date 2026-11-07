/**
 * 应用授权（P3-1）的 grant-list 假数据：5 个应用按作用域表顺序（workers/account/src/core/scopes.js），
 * 形状同 workers/account/src/api/account.js grantListView。授权时间固定在 2026-11-05 中午（UTC），换时区也是同一天。
 * account-apps.spec.js 与 visual.spec.js 共用。
 */
const AT = Date.UTC(2026, 10, 5, 4, 0, 0);
const DEV = { name: 'Galaxy S25 Ultra', gone: false };

/** @param {Partial<Record<string, boolean>>} [off] 取消了授权的应用 */
function grants(off = {}) {
  const base = [
    ['curio', '奇趣', 'Curio', ['curio.write'], ['POST /curio/api/import']],
    ['daymark', '日刻', 'Daymark', ['daymark.write'], []],
    ['prefs', '设置同步', 'Settings sync', ['prefs.sync'], []],
    ['wellbeing', '数字健康', 'Digital wellbeing', ['wellbeing.write'], []],
    ['avatar', '头像', 'Avatar', ['avatar.write'], []],
  ];
  /* name：接口只回英文原文（语言包化第二部分），中文名在主站字符串表 js.account.app_<app> */
  return base.map(([app, _zh, en, scopes, sensitive]) => {
    const on = !off[app];
    return { app, name: en, scopes, sensitive, granted: on, grantedAt: on ? AT : 0, by: on ? 'passkey' : '', device: on ? (app === 'avatar' ? { name: '', gone: true } : DEV) : null };
  });
}

module.exports = { AT, grants };
