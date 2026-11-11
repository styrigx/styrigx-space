/**
 * 账号 e2e 共用的小工具。S9 起账号卡片（头像 #sgx-acct）只展示，账号的流程都在全站终端 #sgx-term 的账号层（shell/account/cmd/layer.js）里。
 * v6 P4（定稿 v5.2 §十三 P4）起只有 v6 身份：openTerm 打开全站终端（顶栏 >_）；身份 = POST /api/identity whoami 替身（默认 root via styrigx），
 * v6 登录标记 cookie sgx-id=1 首帧就有（终端一挂就问 whoami）。旧的 /api/lock-session-check、GET /api/account、sgx-account-signed-in 都删了。
 *
 * 测试构建是静态服务器（没有网关）：/api/identity、/api/account/<入口> 等接口全用 page.route 替身；锁屏禁用（SGX_TEST_NO_LOCK）。
 */
const { expect } = require('@playwright/test');
const { blockExternalRequests } = require('./helpers');

const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

/**
 * v6 身份视图（同 workers/account/src/api/identity.js view()）：'root'（root via styrigx）/ 'styrigx'（站长，wheel + sudoers）/ 其他名字（无组普通用户）。
 * @param {string} [name]
 */
const V6_USER = (name = 'root') => {
  if (name === 'root') return { uid: 0, name: 'root', groups: [], root: true, rescue: false, via: 'styrigx', path: 'root via styrigx', owner: false, wheel: false, sudoers: false, layerExpiresAt: Date.now() + 3600000, idleMs: 0 };
  const owner = name === 'styrigx';
  const groups = owner ? ['wheel', 'sudoers', 'listen', 'ai', 'status', 'curio-write', 'daymark-write'] : [];
  return { uid: owner ? 1000 : 1001, name, groups, root: false, rescue: false, via: '', path: name, owner, wheel: owner, sudoers: owner, layerExpiresAt: Date.now() + 30 * 86400000, idleMs: 0 };
};

/**
 * v6 替身：POST /api/identity { action } → whoami 回 o.user（默认 root；null = 访客，不写登录标记），其他 action 按 handlers['identity/<action>']；
 * POST /api/account/<入口> { action } 按 handlers['<入口>/<action>'] 回（[状态码, JSON] 或 (body) => [状态码, JSON]）。
 * 记下的请求体里 action 写成 '<入口>/<action>'（比如 'devices/revoke'、'identity/passkey-delete'；whoami 不记）。
 * 没写的：devices/list、identity/passkey-list 回空列表，其余 400。
 * @param {import('@playwright/test').Page} page
 * @param {{user?: any, handlers?: Record<string, any>}} [o]
 * @returns {Promise<Array<any>>} 记录的 POST 请求体
 */
async function mockAccount(page, o = {}) {
  const calls = [];
  const user = o.user === undefined ? V6_USER('root') : o.user;
  if (user) await page.addInitScript(() => { try { document.cookie = 'sgx-id=1; Path=/'; } catch (e) {} });
  const defaults = {
    'devices/list': [200, { ok: true, devices: [] }],
    'identity/passkey-list': [200, { ok: true, passkeys: [] }],
  };
  const answer = async (route, key, body) => {
    calls.push(Object.assign({}, body, { action: key }));
    const h = (o.handlers || {})[key] || /** @type {any} */ (defaults)[key] || [400, { ok: false, error: 'action' }];
    const r = typeof h === 'function' ? h(body) : h;
    await route.fulfill(json(r[1], r[0]));
  };
  await page.route(/\/api\/identity\/?(\?.*)?$/, async (route) => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    if (body.action === 'whoami') { await route.fulfill(json({ ok: true, user: typeof user === 'function' ? user() : user })); return; }
    await answer(route, 'identity/' + body.action, body);
  });
  await page.route(/\/api\/account\/[a-z]+\/?(\?.*)?$/, async (route) => {
    const req = route.request();
    const entry = (new URL(req.url()).pathname.match(/^\/api\/account\/([a-z]+)/) || [])[1] || '';
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
    await answer(route, entry + '/' + body.action, body);
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
/**
 * 打开账号卡片（只展示）。v6 起有身份时点头像 = 终端预填下一步（定稿 §七 头像 = whoami），卡片走页面入口 [data-acct-open]（同 open ~/account）；
 * 这里插一个没名字的入口点它（两种身份都一样）。
 * @param {import('@playwright/test').Page} page
 */
async function openCard(page) {
  await page.evaluate(() => { const a = document.createElement('a'); a.href = '#'; a.setAttribute('data-acct-open', ''); a.id = 'e2e-acct-open'; a.textContent = 'account'; document.body.appendChild(a); });
  await page.locator('#e2e-acct-open').click();
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

module.exports = { json, V6_USER, mockAccount, zh, goPage, openTerm, openCard, log, termIn, ps, picks, hint, typeLine, mode, fakePasskey };
