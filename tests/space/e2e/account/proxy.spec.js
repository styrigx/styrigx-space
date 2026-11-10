/**
 * 账号终端 › 代理订阅 sub-*（P2，设计稿 v1.10 §8.1）：shell/account/proxy.js。后端 /api/account/proxy 全用替身。
 *
 * 覆盖：
 * - sub：公钥头尾、令牌有无、每个来源一行（名称 · 域名或文件 · 节点数 · 状态）
 * - sub-mv：名称大小写原样；确认时显示新旧路径（令牌遮挡）；y → proxy/mv
 * - sub-add 同名：显示新旧域名再确认；新链接试拉失败 → 「新链接拉取失败：…，未更换」
 * - 主页首屏终端（tty2）打 sub → 打开账号下拉并在那里跑
 */
const { test, expect } = require('@playwright/test');
const T = require('../helpers/account-term.cjs');

const { SESSION, STATUS, mockAccount, openTerm, log, typeLine, mode } = T;

test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(async ({ page }) => { await T.zh(page); });

const SOURCES = [
  { name: 'Linkcube', type: 'airport', enabled: true, host: 'sub.example.com', nodes: 3, ready: true, lastOkAt: 1, error: '', gen: 1 },
  { name: 'Cloady', type: 'file', enabled: false, host: '', nodes: 1, ready: true, lastOkAt: 1, error: '', gen: 1 },
];
const PSTATUS = { ok: true, pubkey: 'age1abcdef…uvwxyz', hasKey: true, hasLink: true, refreshing: false, sources: SOURCES };

test('sub：公钥头尾、令牌、每个来源一行', async ({ page }) => {
  await mockAccount(page, { status: STATUS({ session: SESSION() }), handlers: { 'proxy/status': [200, PSTATUS] } });
  await T.goPage(page);
  await openTerm(page);
  await typeLine(page, 'sub');
  await expect(log(page)).toContainText('age1abcdef…uvwxyz');
  await expect(log(page)).toContainText('已生成');
  await expect(log(page)).toContainText('Linkcube · sub.example.com · 3 个节点 · 开');
  await expect(log(page)).toContainText('Cloady · 文件 · 1 个节点 · 关');
  await mode(page, 'cmd');
});

test('sub-mv：名称大小写原样；确认显示新旧路径（令牌遮挡）；y → proxy/mv', async ({ page }) => {
  const calls = await mockAccount(page, { status: STATUS({ session: SESSION() }), handlers: { 'proxy/status': [200, PSTATUS], 'proxy/mv': [200, { ok: true }] } });
  await T.goPage(page);
  await openTerm(page);
  await typeLine(page, 'sub-mv Linkcube LinkCube2');
  await mode(page, 'pick');
  await expect(log(page)).toContainText('/s/••••/Linkcube → /s/••••/LinkCube2');
  await typeLine(page, 'y');
  await expect(log(page)).toContainText('已改名 Linkcube → LinkCube2');
  expect(calls.find((c) => c.action === 'proxy/mv')).toMatchObject({ from: 'Linkcube', to: 'LinkCube2' });
});

test('sub-add 同名：确认显示新旧域名；试拉失败 → 未更换', async ({ page }) => {
  const calls = await mockAccount(page, {
    status: STATUS({ session: SESSION() }),
    handlers: { 'proxy/status': [200, PSTATUS], 'proxy/add': [422, { ok: false, error: 'fetch', kept: true, oldHost: 'sub.example.com', host: 'new.example.org' }] },
  });
  await T.goPage(page);
  await openTerm(page);
  await typeLine(page, 'sub-add Linkcube');
  await mode(page, 'suburl');
  await expect(page.locator('#sgx-acct [data-at-in]')).toHaveAttribute('type', 'password');
  await typeLine(page, 'https://new.example.org/api?token=SECRET');
  await expect(log(page)).not.toContainText('SECRET');
  await expect(log(page)).toContainText('把 Linkcube 的链接从 sub.example.com 换成 new.example.org？');
  await typeLine(page, 'y');
  await expect(log(page)).toContainText('新链接拉取失败：拉取失败，未更换');
  expect(calls.find((c) => c.action === 'proxy/add')).toMatchObject({ name: 'Linkcube', url: 'https://new.example.org/api?token=SECRET' });
});

test('主页首屏终端（tty2）打 sub：打开账号下拉，在那里跑', async ({ page }) => {
  const calls = await mockAccount(page, { status: STATUS({ session: SESSION() }), handlers: { 'proxy/status': [200, PSTATUS] } });
  await T.goPage(page, '/zh/');
  await page.locator('#home-term-in').fill('sub');
  await page.locator('#home-term-in').press('Enter');
  await expect(page.locator('#sgx-acct')).toHaveAttribute('data-state', 'open');
  await expect(log(page)).toContainText('Linkcube · sub.example.com');
  expect(calls.some((c) => c.action === 'proxy/status')).toBe(true);
});
