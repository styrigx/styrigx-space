/**
 * 账号 › 应用授权（G1–G7，cmd/grants.js）+ 奇趣 / 日刻的授权同意（A17 / O6）。S9 起都在全站终端 #sgx-term 的账号层里跑（账号卡片只展示，「应用授权」一行右边是已授权个数）。
 *
 * 覆盖：
 * - 账号卡片「应用授权」= 已授权个数；点这一行 → 终端预填 app（不替人回车）
 * - app：一行一应用（[n] 名字 · scope · 授权时间 · 设备 / 已取消；敏感操作另要验证的标出来）
 * - app deny <n>：[y/N] → grants/revoke；app allow <n>：直接 grants/add（v6 root 档 = sudo 每次重验，不再有 sudo root reauth 票）
 * - v6 P4（定稿 v5.2 §十三 P4）起旧账号会话、sudo root reauth、奇趣 / 日刻的授权同意入口删了
 * - 旧地址 #acct=apps：打开终端预填 app
 */
const { test, expect } = require('@playwright/test');
const T = require('../helpers/account-term.cjs');
const fx = require('../../../fixtures/app-grants.cjs');

const { mockAccount, openTerm, log, termIn, ps, typeLine, mode } = T;

test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(async ({ page }) => { await T.zh(page); });

/** grants/list / grants/add / grants/revoke 替身（状态跟着变） @param {Partial<Record<string, boolean>>} [off] */
function grantHandlers(off = {}) {
  const st = { off: Object.assign({}, off) };
  return {
    st,
    h: {
      'grants/list': () => [200, { ok: true, grants: fx.grants(st.off) }],
      'grants/revoke': (b) => { st.off[b.app] = true; return [200, { ok: true, grants: fx.grants(st.off) }]; },
      'grants/add': (b) => { delete st.off[b.app]; return [200, { ok: true, grants: fx.grants(st.off) }]; },
    },
  };
}

test('卡片「应用授权」= 已授权个数，点了终端预填 app；app 一行一应用（scope · 授权时间 · 设备 · 敏感操作）', async ({ page }) => {
  const g = grantHandlers({ wellbeing: true });
  await mockAccount(page, { handlers: g.h });
  await T.goPage(page);
  const card = await T.openCard(page);
  await expect(card.locator('[data-at-v="grants"] .sgx-pop-v')).toHaveText('4');
  await card.locator('[data-at-run="app"]').click();
  await expect(card).toBeHidden();
  await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
  await expect(termIn(page)).toHaveValue('app');
  await termIn(page).press('Enter');
  await expect(log(page)).toContainText('[1] 奇趣 · curio.write · 授权于 11-05 · Galaxy S25 Ultra 批量导入书签另要验证账号');
  await expect(log(page)).toContainText('[2] 日刻 · daymark.write · 授权于 11-05 · Galaxy S25 Ultra');
  await expect(log(page)).toContainText('[4] 数字健康 · wellbeing.write · 已取消');
  await expect(log(page)).toContainText('[5] 头像 · avatar.write · 授权于 11-05 · 已退出的设备');
  await expect(log(page).locator('.sgx-at-p')).toHaveCount(5);
});

test('app deny <n>：[y/N] → grants/revoke；app allow <n>：v6 root 直接 grants/add（不再 sudo root reauth）', async ({ page }) => {
  const g = grantHandlers();
  const calls = await mockAccount(page, { handlers: g.h });
  await T.goPage(page);
  await openTerm(page);
  await expect(ps(page)).toHaveText('root@space:~/wild#');
  await typeLine(page, 'app deny 2');
  await expect(log(page)).toContainText('取消 日刻 的授权？ [y/N]');
  await typeLine(page, 'y');
  await expect(log(page)).toContainText('已取消日刻的授权');
  expect(calls.find((c) => c.action === 'grants/revoke')).toEqual({ action: 'grants/revoke', app: 'daymark' });
  await mode(page, 'cmd');
  await typeLine(page, 'app deny 2');
  await expect(log(page)).toContainText('已经取消授权了');

  await typeLine(page, 'app allow 2');
  await expect(log(page)).toContainText('已重新授权日刻');
  await expect(log(page)).not.toContainText('sudo root reauth');
  expect(calls.find((c) => c.action === 'grants/add')).toEqual({ action: 'grants/add', app: 'daymark' });
  expect(calls.some((c) => /^(reauth|session)\//.test(c.action))).toBe(false);
  await mode(page, 'cmd');
  await typeLine(page, 'app allow 2');
  await expect(log(page)).toContainText('已经授权了');
  await typeLine(page, 'app allow 9');
  await expect(log(page)).toContainText('没有这个应用');
  await expect(log(page)).toContainText('先列出来：app');
});

test('v6 普通用户：app 提示先 su root，不发请求', async ({ page }) => {
  const g = grantHandlers();
  const calls = await mockAccount(page, { user: T.V6_USER('styrigx'), handlers: g.h });
  await T.goPage(page);
  await openTerm(page);
  await typeLine(page, 'app');
  await expect(log(page)).toContainText('su root');
  expect(calls.length).toBe(0);
});

test('旧地址 #acct=apps → 终端预填 app；app allow 直接 grants/add', async ({ page }) => {
  const g = grantHandlers({ prefs: true });
  const calls = await mockAccount(page, { handlers: g.h });
  await T.goPage(page, '/zh/#acct=apps');
  await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
  await expect(termIn(page)).toHaveValue('app');
  await expect(page).toHaveURL(/\/zh\/$/);
  await typeLine(page, 'app allow 3');
  await expect(log(page)).toContainText('已重新授权设置同步');
  expect(calls.some((c) => c.action === 'session/password' || c.action === 'reauth/password')).toBe(false);
});
