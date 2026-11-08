/**
 * 账号终端 › 应用授权（G1–G7）+ 奇趣 / 日刻的授权同意（A17 / O6）。2026-11-08 账号 UI 改版：/account/apps/ 整页删除，
 * 改在头像下拉 #sgx-acct 的「应用授权」层（shell/account/grants.js）；旧地址 301 → 首页 #acct=apps。
 *
 * 覆盖：
 * - 主页「应用授权」右边 = 已授权个数；进层：$ grep 搜索（中英文名）、标签 全部 / 已授权 / 已取消授权（带数量）、一行一应用（scope · 说明、敏感操作、授权时间 · 设备）
 * - 开关：关 = grants/revoke（不用验证）；开 = 重新授权，没有 reauth 票先在终端里 sudo root reauth，再 grants/add；有票直接 grants/add
 * - 授权同意（[data-acct-open][data-acct-app] / #acct&app=curio）：登录后判授权，已授权直接关；没授权 → [y] grants/add / [n] 不写记录，选完关下拉
 * - 旧地址 #acct=apps：直接进应用授权层
 */
const { test, expect } = require('@playwright/test');
const T = require('../helpers/account-term.cjs');
const fx = require('../../../fixtures/app-grants.cjs');

const { SESSION, REAUTH, STATUS, mockAccount, openTerm, log, termIn, typeLine, mode, layer } = T;

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

test('主页「应用授权」= 已授权个数；进层：grep、三个标签带数量、一行一应用（scope · 说明 · 敏感操作 · 授权时间 · 设备）', async ({ page }) => {
  const g = grantHandlers({ wellbeing: true });
  await mockAccount(page, { status: STATUS({ session: SESSION() }), handlers: g.h });
  await T.goPage(page);
  const d = await openTerm(page);
  await layer(page, 'home');
  await expect(d.locator('[data-at-v="grants"] .sgx-pop-v')).toHaveText('4');
  await d.locator('[data-at-act="grants"]').click();
  await layer(page, 'grants');
  await expect(d.locator('.sgx-at-h')).toHaveText('应用授权');
  await expect(d.locator('.sgx-at-chip')).toHaveText(['全部 5', '已授权 4', '已取消授权 1']);
  await expect(d.locator('.sgx-at-app')).toHaveCount(5);
  const curio = d.locator('.sgx-at-app').first();
  await expect(curio).toContainText('奇趣');
  await expect(curio).toContainText('curio.write');
  await expect(curio).toContainText('批量导入书签另要验证账号');
  await expect(curio).toContainText('授权于 11-05 · Galaxy S25 Ultra');
  await expect(d.locator('.sgx-at-app').nth(4)).toContainText('已退出的设备');
  await expect(d.locator('.sgx-at-app.is-off')).toHaveCount(1);
  await expect(d.locator('.sgx-at-app.is-off')).toContainText('数字健康');

  /* 标签：已取消授权 → 只剩数字健康 */
  await d.locator('[data-at-act="filter:off"]').click();
  await expect(d.locator('[data-at-act="filter:off"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(d.locator('.sgx-at-app')).toHaveCount(1);
  await d.locator('[data-at-act="filter:all"]').click();
  /* grep：中文名、英文名都能搜；搜不到 → 没有符合条件的应用 */
  const grep = d.locator('[data-at-grep]');
  await grep.fill('日刻');
  await expect(d.locator('.sgx-at-app')).toHaveCount(1);
  await expect(d.locator('[data-at-grep]')).toBeFocused();
  await d.locator('[data-at-grep]').fill('avatar');
  await expect(d.locator('.sgx-at-app')).toHaveText([/头像/]);
  await d.locator('[data-at-grep]').fill('zzz');
  await expect(d.locator('[data-at-view]')).toContainText('没有符合条件的应用');
  await d.locator('[data-at-grep]').press('Escape');
  await expect(d.locator('.sgx-at-app')).toHaveCount(5);
  await expect(d).toBeVisible();
});

test('关 = grants/revoke（不用验证）；开 = 没 reauth 票先 sudo root reauth，再 grants/add', async ({ page }) => {
  const g = grantHandlers();
  let ticket = null;
  const calls = await mockAccount(page, {
    status: () => STATUS({ session: SESSION(), reauth: ticket }),
    handlers: Object.assign({}, g.h, { 'reauth/password': () => { ticket = REAUTH(); return [200, { ok: true }]; } }),
  });
  await T.goPage(page);
  const d = await openTerm(page);
  await typeLine(page, 'cd apps');
  await layer(page, 'grants');
  const sw = d.locator('[data-at-act="grant:daymark"]');
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect(log(page)).toContainText('已取消日刻的授权');
  await expect(d.locator('[data-at-act="grant:daymark"]')).toHaveAttribute('aria-checked', 'false');
  expect(calls.find((c) => c.action === 'grants/revoke')).toEqual({ action: 'grants/revoke', app: 'daymark' });
  expect(calls.some((c) => c.action === 'session/password')).toBe(false);

  await d.locator('[data-at-act="grant:daymark"]').click();
  await expect(log(page)).toContainText('sudo root reauth');
  await expect(log(page)).toContainText('重新授权要再验证');
  await termIn(page).press('2');
  await typeLine(page, 'correct-horse');
  await expect(log(page)).toContainText('已重新授权日刻');
  await expect(d.locator('[data-at-act="grant:daymark"]')).toHaveAttribute('aria-checked', 'true');
  expect(calls.some((c) => c.action === 'reauth/password')).toBe(true);
  expect(calls.find((c) => c.action === 'grants/add')).toEqual({ action: 'grants/add', app: 'daymark' });
});

test('有 reauth 票：重新授权直接 grants/add，不再问', async ({ page }) => {
  const g = grantHandlers({ prefs: true });
  const calls = await mockAccount(page, { status: STATUS({ session: SESSION(), reauth: REAUTH() }), handlers: g.h });
  await T.goPage(page, '/zh/#acct=apps');
  const d = page.locator('#sgx-acct');
  await layer(page, 'grants');
  await expect(page).toHaveURL(/\/zh\/$/);
  await d.locator('[data-at-act="grant:prefs"]').click();
  await expect(log(page)).toContainText('已重新授权设置同步');
  expect(calls.some((c) => c.action === 'session/password')).toBe(false);
});

test.describe('授权同意（奇趣 / 日刻的 sudo root）', () => {
  test('未登录 + 没授权：#acct&app=curio → sudo root（只签 session）→ [y] 允许 → 403 reauth → sudo root reauth → grants/add → 关下拉', async ({ page }) => {
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
    const d = page.locator('#sgx-acct');
    await expect(d).toHaveAttribute('data-state', 'open');
    await expect(d.locator('[data-at-head]')).toContainText('curio');
    await mode(page, 'pick');
    await termIn(page).press('2');
    await typeLine(page, 'correct-horse');
    await expect(log(page)).toContainText('允许奇趣使用你的账号？');
    expect(calls.some((c) => c.action === 'reauth/password')).toBe(false);
    await expect(log(page)).toContainText('添加、修改、删除奇趣里的收藏');
    await expect(log(page)).toContainText('批量导入书签另要验证账号');
    await expect(log(page)).toContainText('拒绝不写记录');
    await expect(log(page).locator('.sgx-at-l--opts').last().locator('[data-at-pick]')).toHaveText(['[y] 允许', '[n] 拒绝']);
    await termIn(page).press('y');
    await expect(log(page)).toContainText('sudo root reauth');
    await mode(page, 'pick');
    await termIn(page).press('2');
    await typeLine(page, 'correct-horse');
    await expect(d).toBeHidden();
    expect(calls.filter((c) => c.action === 'reauth/password')).toHaveLength(1);
    expect(calls.filter((c) => c.action === 'grants/add').pop()).toEqual({ action: 'grants/add', app: 'curio' });
  });

  test('已登录 + 没授权：[n] 拒绝不写记录，关下拉', async ({ page }) => {
    const g = grantHandlers({ daymark: true });
    const calls = await mockAccount(page, { status: STATUS({ session: SESSION() }), handlers: g.h });
    await T.goPage(page, '/zh/#acct&app=daymark');
    const d = page.locator('#sgx-acct');
    await expect(log(page)).toContainText('允许日刻使用你的账号？');
    await d.locator('[data-at-pick="n"]').click();
    await expect(d).toBeHidden();
    expect(calls.some((c) => c.action === 'grants/add')).toBe(false);
  });

  test('已登录 + 已授权：不问，直接关', async ({ page }) => {
    const g = grantHandlers();
    const calls = await mockAccount(page, { status: STATUS({ session: SESSION() }), handlers: g.h });
    await T.goPage(page, '/zh/#acct&app=curio');
    await expect.poll(() => calls.some((c) => c.action === 'grants/list')).toBe(true);
    await expect(page.locator('#sgx-acct')).toBeHidden();
    expect(calls.some((c) => c.action === 'grants/add')).toBe(false);
  });
});
