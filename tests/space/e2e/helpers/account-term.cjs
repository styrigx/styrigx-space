/**
 * 账号终端（头像下拉 #sgx-acct，2026-11-08 账号 UI 改版，shell/account/term.js）e2e 共用的小工具。
 *
 * 测试构建是静态服务器（没有网关）：/api/account 等接口全用 page.route 替身；锁屏禁用（SGX_TEST_NO_LOCK）。
 * 没有 /account/ 整页了：旧地址由 static/_redirects 301 到首页 #acct=<层>（静态服务器不跑 _redirects，这里直接开 #acct=…）。
 */
const { expect } = require('@playwright/test');
const { blockExternalRequests } = require('./helpers');

const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

/** 已登录账号会话（GET /api/account 的 session 段） */
const SESSION = (by = 'password', device = 'Galaxy S23 Ultra') => ({ by, device, authAt: Date.now() - 1000, expiresAt: Date.now() + 3600000 });
/** reauth 票（3 分钟） */
const REAUTH = () => ({ by: 'password', expiresAt: Date.now() + 170000 });
/** GET /api/account：已进门、两把钥匙都设了 */
const STATUS = (x = {}) => Object.assign({ ok: true, ready: true, password: true, passkey: true, session: null }, x);

/**
 * /api/account 替身：GET 回 status（可为函数），POST 按 action 回 handlers[action]（[状态码, JSON] 或 (body) => [状态码, JSON]）。
 * 没写的 action：grant-list / device-list / passkey-list 回空列表，其余 400。
 * @param {import('@playwright/test').Page} page
 * @param {{status?: any, handlers?: Record<string, any>}} o
 * @returns {Promise<Array<any>>} 记录的 POST 请求体
 */
async function mockAccount(page, o) {
  const calls = [];
  const defaults = {
    'grant-list': [200, { ok: true, grants: [] }],
    'device-list': [200, { ok: true, devices: [] }],
    'passkey-list': [200, { ok: true, keys: [] }],
    'reauth-clear': [200, { ok: true }],
  };
  await page.route('**/api/account', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      const st = typeof o.status === 'function' ? o.status() : o.status;
      await route.fulfill(json(st || { ok: false, error: 'session' }, st && st.ok === false ? 401 : 200));
      return;
    }
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
    calls.push(body);
    const h = (o.handlers || {})[body.action] || /** @type {any} */ (defaults)[body.action] || [400, { ok: false, error: 'action' }];
    const r = typeof h === 'function' ? h(body) : h;
    await route.fulfill(json(r[1], r[0]));
  });
  return calls;
}

/** 中文、挡外网 @param {import('@playwright/test').Page} page */
async function zh(page) {
  await blockExternalRequests(page);
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
}

/**
 * 进页面（默认 /zh/wild/）等顶栏就绪。
 * @param {import('@playwright/test').Page} page @param {string} [path]
 */
async function goPage(page, path = '/zh/wild/') {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-sgx-layout'));
}

/** 点头像打开账号终端，等终端骨架画好 @param {import('@playwright/test').Page} page */
async function openTerm(page) {
  await page.locator('#site-nav .sgx-tb-av').click();
  const d = page.locator('#sgx-acct');
  await expect(d).toHaveAttribute('data-state', 'open');
  await expect(d.locator('.sgx-at')).toBeVisible();
  return d;
}

/** 终端输出区 @param {import('@playwright/test').Page} page */
const log = (page) => page.locator('#sgx-acct [data-at-log]');
/** 输入行 @param {import('@playwright/test').Page} page */
const termIn = (page) => page.locator('#sgx-acct [data-at-in]');
/** 提示符 @param {import('@playwright/test').Page} page */
const ps = (page) => page.locator('#sgx-acct [data-at-ps]');

/**
 * 在输入行敲一行 + enter。
 * @param {import('@playwright/test').Page} page @param {string} s
 */
async function typeLine(page, s) {
  const i = termIn(page);
  await expect(i).toBeEnabled();
  await i.fill(s);
  await i.press('Enter');
}

/** 等终端进入某个输入模式 @param {import('@playwright/test').Page} page @param {string} m */
async function mode(page, m) {
  await expect(page.locator('#sgx-acct .sgx-at')).toHaveAttribute('data-at-mode', m);
}

/** 当前层（guest / home / profile / devices / keys / grants / reset / consent） @param {import('@playwright/test').Page} page @param {string} l */
async function layer(page, l) {
  await expect(page.locator('#sgx-acct .sgx-at')).toHaveAttribute('data-at-layer', l);
}

/**
 * 通行密钥替身：navigator.credentials.get 直接回一个假断言（或按 cancel 抛 NotAllowedError）。create 同理。
 * @param {import('@playwright/test').Page} page @param {{cancel?: boolean}} [o]
 */
async function fakePasskey(page, o = {}) {
  await page.addInitScript((cancel) => {
    const buf = (s) => new TextEncoder().encode(s).buffer;
    const fake = (kind) => ({
      id: 'Y3JlZA', rawId: buf('cred'), type: 'public-key', authenticatorAttachment: 'platform',
      response: kind === 'get'
        ? { clientDataJSON: buf('{}'), authenticatorData: buf('ad'), signature: buf('sig'), userHandle: buf('u') }
        : { clientDataJSON: buf('{}'), attestationObject: buf('att'), getTransports: () => ['internal'], getPublicKey: () => null, getPublicKeyAlgorithm: () => -7, getAuthenticatorData: () => buf('ad') },
      getClientExtensionResults: () => ({}),
      toJSON: () => ({ id: 'Y3JlZA', rawId: 'Y3JlZA', type: 'public-key', response: {} }),
    });
    if (!window.PublicKeyCredential) /** @type {any} */ (window).PublicKeyCredential = function () {};
    const cc = navigator.credentials;
    const deny = () => Promise.reject(new DOMException('cancel', 'NotAllowedError'));
    cc.get = (/** @type {any} */ opts) => (opts && opts.publicKey ? (cancel ? deny() : Promise.resolve(fake('get'))) : Promise.resolve(null));
    cc.create = (/** @type {any} */ opts) => (opts && opts.publicKey ? (cancel ? deny() : Promise.resolve(fake('create'))) : Promise.resolve(null));
  }, !!o.cancel);
}

module.exports = { json, SESSION, REAUTH, STATUS, mockAccount, zh, goPage, openTerm, log, termIn, ps, typeLine, mode, layer, fakePasskey };
