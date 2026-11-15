/**
 * 账号 › 代理订阅 sub 指令（v3.1）：shell/account/proxy.js，在全站终端 #sgx-term 的账号层里跑。后端 /api/account/proxy 全用替身。
 *
 * 覆盖：
 * - sub：公钥头尾、令牌状态、每个来源一行（名称 · 域名或文件 · 节点数 · 状态）
 * - sub show [名称]：v6 root 直接印令牌和地址（各带复制）；给了名称只印那一个；随时可重印
 * - sub token reset（S9）：已有令牌先 y/N；换新后印新地址；单 sub token 给用法
 * - sub mv：名称大小写原样；确认时显示新旧路径（令牌遮挡）；y → proxy/mv
 * - sub add 同名：显示新旧域名再确认；新链接试拉失败 → 「新链接拉取失败：…，未更换」
 */
const { test, expect } = require('@playwright/test');
const T = require('../helpers/account-term.cjs');

const { mockAccount, openTerm, log, typeLine, mode } = T;

test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(async ({ page }) => { await T.zh(page); });

const SOURCES = [
  { name: 'Linkcube', type: 'airport', enabled: true, host: 'sub.example.com', nodes: 3, unmatched: 1, ready: true, lastOkAt: 1, error: '', gen: 1 },
  { name: 'Cloady', type: 'file', enabled: false, host: '', nodes: 1, ready: true, lastOkAt: 1, error: '', gen: 1 },
];
const PSTATUS = { ok: true, pubkey: 'age1abcdef…uvwxyz', hasKey: true, token: 'sealed', refreshing: false, sources: SOURCES };

test('sub：公钥头尾、令牌、每个来源一行', async ({ page }) => {
  await mockAccount(page, { handlers: { 'proxy/status': [200, PSTATUS] } });
  await T.goPage(page);
  await openTerm(page);
  await typeLine(page, 'sub');
  await expect(log(page)).toContainText('age1abcdef…uvwxyz');
  await expect(log(page)).toContainText('已生成 · 地址用 sub show');
  await expect(log(page)).toContainText('Linkcube · sub.example.com · 3 个节点 · 未匹配 1 · 启用');
  await expect(log(page)).toContainText('Cloady · 文件 · 1 个节点 · 停用');
  await mode(page, 'cmd');
});

const TK = 'T'.repeat(43);
const BASE = 'https://proxy.styrigx.com/s/';

test('sub show：v6 root 直接印令牌和全部地址；sub show <名称> 只印那一个；可以反复印', async ({ page }) => {
  const calls = await mockAccount(page, {
    handlers: { 'proxy/status': [200, PSTATUS], 'proxy/show': [200, { ok: true, token: TK, base: BASE }] },
  });
  await T.goPage(page);
  await openTerm(page);
  await typeLine(page, 'sub show');
  await expect(log(page)).toContainText(BASE + TK + '/Linkcube');
  await expect(log(page)).toContainText(BASE + TK + '/Cloady');
  await mode(page, 'cmd');
  await typeLine(page, 'clear');
  await typeLine(page, 'sub show Cloady');
  await expect(log(page)).toContainText(BASE + TK + '/Cloady');
  await expect(log(page)).not.toContainText(BASE + TK + '/Linkcube');
  expect(calls.filter((c) => c.action === 'proxy/show').length).toBe(2);
  await typeLine(page, 'sub show Nope');
  await expect(log(page)).toContainText('没有这个来源：Nope');
});

test('sub token reset：已有令牌先 y/N；y → proxy/token，印新地址；单 sub token 只给用法', async ({ page }) => {
  const calls = await mockAccount(page, {
    handlers: { 'proxy/status': [200, PSTATUS], 'proxy/token': [200, { ok: true, token: TK, base: BASE }] },
  });
  await T.goPage(page);
  await openTerm(page);
  await typeLine(page, 'sub token');
  await expect(log(page)).toContainText('用法：sub token reset');
  expect(calls.some((c) => c.action === 'proxy/token')).toBe(false);
  await typeLine(page, 'sub token reset');
  await mode(page, 'pick');
  await expect(log(page)).toContainText('换新后全部 2 个来源的旧链接立即失效');
  await typeLine(page, 'y');
  await expect(log(page)).toContainText('已换新令牌');
  await expect(log(page)).toContainText(BASE + TK + '/Linkcube');
  expect(calls.some((c) => c.action === 'proxy/token')).toBe(true);
});

test('sub mv：名称大小写原样；确认显示新旧路径（令牌遮挡）；y → proxy/mv', async ({ page }) => {
  const calls = await mockAccount(page, { handlers: { 'proxy/status': [200, PSTATUS], 'proxy/mv': [200, { ok: true }] } });
  await T.goPage(page);
  await openTerm(page);
  await typeLine(page, 'sub mv Linkcube LinkCube2');
  await mode(page, 'pick');
  await expect(log(page)).toContainText('/s/••••/Linkcube → /s/••••/LinkCube2');
  await typeLine(page, 'y');
  await expect(log(page)).toContainText('已改名 Linkcube → LinkCube2');
  expect(calls.find((c) => c.action === 'proxy/mv')).toMatchObject({ from: 'Linkcube', to: 'LinkCube2' });
});

test('sub add 同名：确认显示新旧域名；试拉失败 → 未更换', async ({ page }) => {
  const calls = await mockAccount(page, {
    handlers: { 'proxy/status': [200, PSTATUS], 'proxy/add': [422, { ok: false, error: 'fetch', kept: true, oldHost: 'sub.example.com', host: 'new.example.org' }] },
  });
  await T.goPage(page);
  await openTerm(page);
  await typeLine(page, 'sub add Linkcube');
  await mode(page, 'suburl');
  await expect(T.termIn(page)).toHaveAttribute('type', 'password');
  await typeLine(page, 'https://new.example.org/api?token=SECRET');
  await expect(log(page)).not.toContainText('SECRET');
  await expect(log(page)).toContainText('把 Linkcube 的链接从 sub.example.com 换成 new.example.org？');
  await typeLine(page, 'y');
  await expect(log(page)).toContainText('新链接拉取失败：拉取失败，未更换');
  expect(calls.find((c) => c.action === 'proxy/add')).toMatchObject({ name: 'Linkcube', url: 'https://new.example.org/api?token=SECRET' });
});

test('sub on | off <名称>（v1.13，enable / disable 改回 on / off）：proxy/on、proxy/off；sub enable 不再认', async ({ page }) => {
  const calls = await mockAccount(page, {
    handlers: { 'proxy/status': [200, PSTATUS], 'proxy/on': [200, { ok: true }], 'proxy/off': [200, { ok: true }] },
  });
  await T.goPage(page);
  await openTerm(page);
  await typeLine(page, 'sub off Linkcube');
  await expect(log(page)).toContainText('Linkcube 已停用');
  await mode(page, 'cmd');
  await typeLine(page, 'sub on Cloady');
  await expect(log(page)).toContainText('Cloady 已启用');
  await mode(page, 'cmd');
  expect(calls.filter((c) => c.action === 'proxy/off' || c.action === 'proxy/on')).toEqual([
    { action: 'proxy/off', name: 'Linkcube' },
    { action: 'proxy/on', name: 'Cloady' },
  ]);
  await typeLine(page, 'clear');
  await typeLine(page, 'sub enable Cloady');
  await expect(log(page)).toContainText('sub on <name> | sub off <name>');
  expect(calls.filter((c) => c.action === 'proxy/on')).toHaveLength(1);
});

test('sub update / map / fp（v1.13）：proxy/update、map、map_set、map_rm、map_ls、fp', async ({ page }) => {
  const calls = await mockAccount(page, {
    handlers: {
      'proxy/status': [200, PSTATUS],
      'proxy/update': [200, { ok: true, refresh: { ok: true, sources: [{ name: 'Linkcube', ok: true, nodes: 3 }] } }],
      'proxy/map': [200, { ok: true, flags: [{ word: '港', code: 'HK', flag: '🇭🇰' }], drop: ['剩余', '到期'] }],
      'proxy/map_set': [200, { ok: true, word: '狮城', code: 'SG', flag: '🇸🇬', changed: false, refresh: { ok: true, sources: [] } }],
      'proxy/map_rm': [422, { ok: false, error: 'not-found' }],
      'proxy/map_ls': [200, { ok: true, names: ['未知节点 9'] }],
      'proxy/fp': [200, { ok: true, fp: 'chrome' }],
    },
  });
  await T.goPage(page);
  await openTerm(page);
  await typeLine(page, 'sub update Linkcube');
  await expect(log(page)).toContainText('已拉取 Linkcube');
  await mode(page, 'cmd');
  await typeLine(page, 'sub map');
  await expect(log(page)).toContainText('港 → 🇭🇰 HK');
  await expect(log(page)).toContainText('丢弃 剩余 到期');
  await mode(page, 'cmd');
  await typeLine(page, 'sub map 狮城 SGP');
  await expect(log(page)).toContainText('已加映射 狮城 → 🇸🇬 SG');
  await mode(page, 'cmd');
  await typeLine(page, 'sub map rm 狮城');
  await expect(log(page)).toContainText('没有这个源词：狮城');
  await mode(page, 'cmd');
  await typeLine(page, 'sub map ls Linkcube');
  await expect(log(page)).toContainText('未知节点 9');
  await mode(page, 'cmd');
  await typeLine(page, 'sub fp');
  await expect(log(page)).toContainText('指纹 chrome');
  await mode(page, 'cmd');
  await typeLine(page, 'sub map 狮城 S1');
  await expect(log(page)).toContainText('目标词不是国家码');
  expect(calls.filter((c) => c.action !== 'proxy/status').map((c) => c.action)).toEqual(['proxy/update', 'proxy/map', 'proxy/map_set', 'proxy/map_rm', 'proxy/map_ls', 'proxy/fp']);
  expect(calls.find((c) => c.action === 'proxy/map_set')).toMatchObject({ word: '狮城', code: 'SGP' });
});
