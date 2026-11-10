/**
 * 账号 › 应用授权（G1–G7，cmd/grants.js）+ 奇趣 / 日刻的授权同意（A17 / O6）。S9 起都在全站终端 #sgx-term 的账号层里跑（账号卡片只展示，「应用授权」一行右边是已授权个数）。
 *
 * 覆盖：
 * - 账号卡片「应用授权」= 已授权个数；点这一行 → 终端预填 app（不替人回车）
 * - app：一行一应用（[n] 名字 · scope · 授权时间 · 设备 / 已取消；敏感操作另要验证的标出来）
 * - app deny <n>：[y/N] → grants/revoke（不用验证）；app allow <n>：没 reauth 票先 sudo root reauth，再 grants/add；有票直接 grants/add
 * - 授权同意（[data-acct-open][data-acct-app] / #acct&app=curio）：登录后判授权，已授权直接收起；没授权 → [y] grants/add / [n] 不写记录，选完收起终端
 * - 旧地址 #acct=apps：打开终端预填 app
 */
const { test, expect } = require('@playwright/test');
const T = require('../helpers/account-term.cjs');
const fx = require('../../../fixtures/app-grants.cjs');

const { SESSION, REAUTH, STATUS, mockAccount, openTerm, log, termIn, ps, picks, typeLine, mode } = T;

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
  await mockAccount(page, { status: STATUS({ session: SESSION() }), handlers: g.h });
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

test('app deny <n>：[y/N] → grants/revoke（不用验证）；app allow <n>：没 reauth 票先 sudo root reauth，再 grants/add', async ({ page }) => {
  const g = grantHandlers();
  let ticket = null;
  const calls = await mockAccount(page, {
    status: () => STATUS({ session: SESSION(), reauth: ticket }),
    handlers: Object.assign({}, g.h, { 'reauth/password': () => { ticket = REAUTH(); return [200, { ok: true }]; } }),
  });
  await T.goPage(page);
  await openTerm(page);
  await expect(ps(page)).toHaveText('root@account:~/wild#');
  await typeLine(page, 'app deny 2');
  await expect(log(page)).toContainText('取消 日刻 的授权？ [y/N]');
  await typeLine(page, 'y');
  await expect(log(page)).toContainText('已取消日刻的授权');
  expect(calls.find((c) => c.action === 'grants/revoke')).toEqual({ action: 'grants/revoke', app: 'daymark' });
  expect(calls.some((c) => c.action === 'session/password' || c.action === 'reauth/password')).toBe(false);
  await mode(page, 'cmd');
  await typeLine(page, 'app deny 2');
  await expect(log(page)).toContainText('已经取消授权了');

  await typeLine(page, 'app allow 2');
  await expect(log(page)).toContainText('sudo root reauth');
  await expect(log(page)).toContainText('重新授权要再验证');
  await mode(page, 'pick');
  await termIn(page).press('2');
  await typeLine(page, 'correct-horse');
  await expect(log(page)).toContainText('已重新授权日刻');
  expect(calls.some((c) => c.action === 'reauth/password')).toBe(true);
  expect(calls.find((c) => c.action === 'grants/add')).toEqual({ action: 'grants/add', app: 'daymark' });
  await mode(page, 'cmd');
  await typeLine(page, 'app allow 2');
  await expect(log(page)).toContainText('已经授权了');
  await typeLine(page, 'app allow 9');
  await expect(log(page)).toContainText('没有这个应用');
  await expect(log(page)).toContainText('先列出来：app');
});

test('有 reauth 票：app allow 直接 grants/add，不再问；旧地址 #acct=apps → 终端预填 app', async ({ page }) => {
  const g = grantHandlers({ prefs: true });
  const calls = await mockAccount(page, { status: STATUS({ session: SESSION(), reauth: REAUTH() }), handlers: g.h });
  await T.goPage(page, '/zh/#acct=apps');
  await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
  await expect(termIn(page)).toHaveValue('app');
  await expect(page).toHaveURL(/\/zh\/$/);
  await typeLine(page, 'app allow 3');
  await expect(log(page)).toContainText('已重新授权设置同步');
  expect(calls.some((c) => c.action === 'session/password' || c.action === 'reauth/password')).toBe(false);
});

test.describe('授权同意（奇趣 / 日刻的 sudo root）', () => {
  test('未登录 + 没授权：#acct&app=curio → 终端 sudo root（只签 session）→ [y] 允许 → 403 reauth → sudo root reauth → grants/add → 收起终端', async ({ page }) => {
    const g = grantHandlers({ curio: true });
    let signedIn = false;
    let ticket = null;
    const calls = await mockAccount(page, {
      status: () => STATUS({ session: signedIn ? SESSION() : null, reauth: ticket }),
      handlers: Object.assign({}, g.h, {
        'session/password': () => { signedIn = true; return [200, { ok: true }]; },
        'reauth/password': () => { ticket = REAUTH(); return [200, { ok: true }]; },
        /* 同服务端：grants/add 要挂在会话上的 reauth 票（NAMING-V2 Q1：登录不顺手签） */
        'grants/add': (b) => (ticket ? g.h['grants/add'](b) : [403, { ok: false, error: 'reauth' }]),
      }),
    });
    await T.goPage(page, '/zh/#acct&app=curio');
    const d = page.locator('#sgx-term');
    await expect(d).toHaveAttribute('open', '');
    await expect(log(page)).toContainText('sudo root');
    await expect(page.locator('#sgx-acct')).toBeHidden();
    await mode(page, 'pick');
    await termIn(page).press('2');
    await typeLine(page, 'correct-horse');
    await expect(log(page)).toContainText('允许奇趣使用你的账号？');
    expect(calls.some((c) => c.action === 'reauth/password')).toBe(false);
    await expect(log(page)).toContainText('添加、修改、删除奇趣里的收藏');
    await expect(log(page)).toContainText('批量导入书签另要验证账号');
    await expect(log(page)).toContainText('拒绝不写记录');
    /* 前面登录时的 [1] passkey [2] password 还留在输出里：只看最后一组 */
    await expect.poll(async () => (await picks(page).allTextContents()).slice(-2)).toEqual(['[y] 允许', '[n] 拒绝']);
    await mode(page, 'pick');
    await termIn(page).press('y');
    await expect(log(page)).toContainText('sudo root reauth');
    await mode(page, 'pick');
    await termIn(page).press('2');
    await typeLine(page, 'correct-horse');
    await expect(d).not.toHaveAttribute('open', '');
    expect(calls.filter((c) => c.action === 'reauth/password')).toHaveLength(1);
    expect(calls.filter((c) => c.action === 'grants/add').pop()).toEqual({ action: 'grants/add', app: 'curio' });
  });

  test('已登录 + 没授权：[n] 拒绝不写记录，收起终端', async ({ page }) => {
    const g = grantHandlers({ daymark: true });
    const calls = await mockAccount(page, { status: STATUS({ session: SESSION() }), handlers: g.h });
    await T.goPage(page, '/zh/#acct&app=daymark');
    const d = page.locator('#sgx-term');
    await expect(log(page)).toContainText('允许日刻使用你的账号？');
    await page.locator('#sgx-term [data-term-pick="n"]').click();
    await expect(d).not.toHaveAttribute('open', '');
    expect(calls.some((c) => c.action === 'grants/add')).toBe(false);
  });

  test('已登录 + 已授权：不问，直接收起', async ({ page }) => {
    const g = grantHandlers();
    const calls = await mockAccount(page, { status: STATUS({ session: SESSION() }), handlers: g.h });
    await T.goPage(page, '/zh/#acct&app=curio');
    await expect.poll(() => calls.some((c) => c.action === 'grants/list')).toBe(true);
    await expect(page.locator('#sgx-term')).not.toHaveAttribute('open', '');
    await expect(page.locator('#sgx-acct')).toBeHidden();
    expect(calls.some((c) => c.action === 'grants/add')).toBe(false);
  });
});
