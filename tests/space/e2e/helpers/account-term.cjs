/**
 * 账号 e2e 共用的小工具。S9 起账号卡片（头像 #sgx-acct）只展示，账号的流程都在全站终端 #sgx-term 的账号层（shell/account/cmd/layer.js）里：
 * openTerm 打开全站终端（顶栏 >_），log / termIn / ps / mode 都指向它；身份：/api/lock-session-check 替身回已进站（styrigx），
 * 账号登录标记 cookie 首帧就有，账号层一加载就问 GET /api/account（有 session → root@account）。
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
/** GET /api/account：已进门、两把钥匙都设了（字段同 workers/account/src/api/account/status.js） */
const STATUS = (x = {}) => Object.assign({ ok: true, signing: true, configured: { password: true, passkey: true }, session: null }, x);

/**
 * /api/account 替身：GET /api/account 回 status（可为函数）；POST /api/account/<入口> { action } 按 handlers['<入口>/<action>'] 回
 * （[状态码, JSON] 或 (body) => [状态码, JSON]）。记下的请求体里 action 写成 '<入口>/<action>'（比如 'session/password'）。
 * 没写的：grants/list、devices/list、keys/passkey-list、reset/passkey-list 回空列表，reauth/end、reset/end 回 ok，其余 400。
 * @param {import('@playwright/test').Page} page
 * @param {{status?: any, handlers?: Record<string, any>}} o
 * @returns {Promise<Array<any>>} 记录的 POST 请求体
 */
async function mockAccount(page, o) {
  const calls = [];
  /* 进站会话（终端身份 styrigx；账号会话由 GET /api/account 决定 root） */
  await page.route('**/api/lock-session-check**', (r) => r.fulfill(json({ ok: true, by: 'password' })));
  await page.addInitScript(() => { try { document.cookie = 'sgx-account-signed-in=1; Path=/'; } catch (e) {} });
  const defaults = {
    'grants/list': [200, { ok: true, grants: [] }],
    'devices/list': [200, { ok: true, devices: [] }],
    'keys/passkey-list': [200, { ok: true, keys: [] }],
    'reset/passkey-list': [200, { ok: true, keys: [] }],
    'reauth/end': [200, { ok: true }],
    'reset/end': [200, { ok: true }],
  };
  await page.route(/\/api\/account(\/[a-z]+)?\/?(\?.*)?$/, async (route) => {
    const req = route.request();
    const entry = (new URL(req.url()).pathname.match(/^\/api\/account\/([a-z]+)/) || [])[1] || '';
    if (req.method() === 'GET' && !entry) {
      const st = typeof o.status === 'function' ? o.status() : o.status;
      await route.fulfill(json(st || { ok: false, error: 'session' }, st && st.ok === false ? 401 : 200));
      return;
    }
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
    const key = entry + '/' + body.action;
    calls.push(Object.assign({}, body, { action: key }));
    const h = (o.handlers || {})[key] || /** @type {any} */ (defaults)[key] || [400, { ok: false, error: 'action' }];
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

/** 打开全站终端（顶栏 >_），等身份问完（提示符不是 nobody） @param {import('@playwright/test').Page} page */
async function openTerm(page) {
  await page.locator('#site-nav .sgx-tb-term').click();
  const d = page.locator('#sgx-term');
  await expect(d).toHaveAttribute('open', '');
  await expect(page.locator('#sgx-term [data-term-ps]')).not.toHaveText(/^nobody/);
  return d;
}
/** 点头像打开账号卡片（只展示） @param {import('@playwright/test').Page} page */
async function openCard(page) {
  await page.locator('#site-nav .sgx-tb-av').click();
  const d = page.locator('#sgx-acct');
  await expect(d).toHaveAttribute('data-state', 'open');
  await expect(d.locator('.sgx-at')).toBeVisible();
  return d;
}

/** 终端输出区 @param {import('@playwright/test').Page} page */
const log = (page) => page.locator('#sgx-term [data-term-out]');
/** 输入行 @param {import('@playwright/test').Page} page */
const termIn = (page) => page.locator('#sgx-term-in');
/** 提示符 @param {import('@playwright/test').Page} page */
const ps = (page) => page.locator('#sgx-term [data-term-ps]');
/** 选项按钮 @param {import('@playwright/test').Page} page */
const picks = (page) => page.locator('#sgx-term [data-term-pick]');
/** 输入行下面的注释 + 触屏 ^C @param {import('@playwright/test').Page} page */
const hint = (page) => page.locator('#sgx-term [data-term-hint]');

/**
 * 在输入行敲一行 + enter。
 * @param {import('@playwright/test').Page} page @param {string} s
 */
async function typeLine(page, s) {
  const i = termIn(page);
  await expect(i).toBeEditable();
  await i.fill(s);
  await i.press('Enter');
}

/** 等终端进入某个输入模式 @param {import('@playwright/test').Page} page @param {string} m */
async function mode(page, m) {
  await expect(page.locator('#sgx-term [data-term-form]')).toHaveAttribute('data-mode', m);
}

/**
 * 通行密钥替身：navigator.credentials.get 直接回一个假断言（或按 cancel 抛 NotAllowedError）。create 同理。
 * @param {import('@playwright/test').Page} page @param {{cancel?: boolean}} [o]
 */
/**
 * 假的 WebAuthn：默认立即成功；cancel → NotAllowedError（用户取消系统窗口）；hang → 系统窗口一直开着，直到调用方 abort（signal）→ AbortError。
 * window.__pkWaiting：系统窗口（hang）开过几次；window.__pkAborted：被 abort 过几次。
 */
async function fakePasskey(page, o = {}) {
  await page.addInitScript(({ cancel, hang }) => {
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
    /** @type {any} */ (window).__pkAborted = 0;
    /** @type {any} */ (window).__pkWaiting = 0;
    const wait = (/** @type {any} */ opts) => new Promise((res, rej) => {
      /** @type {any} */ (window).__pkWaiting++;
      if (opts && opts.signal) opts.signal.addEventListener('abort', () => { /** @type {any} */ (window).__pkAborted++; rej(new DOMException('aborted', 'AbortError')); });
    });
    const answer = (/** @type {any} */ opts, kind) => (hang ? wait(opts) : cancel ? deny() : Promise.resolve(fake(kind)));
    cc.get = (/** @type {any} */ opts) => (opts && opts.publicKey ? answer(opts, 'get') : Promise.resolve(null));
    cc.create = (/** @type {any} */ opts) => (opts && opts.publicKey ? answer(opts, 'create') : Promise.resolve(null));
  }, { cancel: !!o.cancel, hang: !!o.hang });
}

module.exports = { json, SESSION, REAUTH, STATUS, mockAccount, zh, goPage, openTerm, openCard, log, termIn, ps, picks, hint, typeLine, mode, fakePasskey };
