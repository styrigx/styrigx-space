/**
 * 预览站（真实网关）E2E 的共享 helper：passkey.spec.js、account-challenge.spec.js 共用；
 * addVirtualAuth 也给本地 mock 的 spec（b1-12-guard.spec.js）用。
 *
 * 环境变量（CI 的 passkey-e2e job 注入；本地没配时整组跳过，CI 里缺了直接失败）：
 * - SGX_TEST_BASE：预览站地址（https://passkey-e2e.styrigx-space.pages.dev）
 * - SGX_TEST_ROOT_KEY：预览站的测试 RootKey（与预览的 SGX_ROOT_KEY 相同，绝不是生产值；CI 每次运行现生成，
 *   连同 SGX_PW_PEPPER 一起写进预览，不存 GitHub Secrets）
 * - SGX_TEST_CF_TOKEN / SGX_TEST_CF_ACCOUNT / SGX_TEST_PREVIEW_KV_ID：写预览 KV（重置开关、清限速计数）
 * - SGX_TEST_CF_API：只在模拟预览站（preview-emulator.cjs：本地，或 CI 里 pull_request 的运行）时设，把 Cloudflare REST 指到本机
 *
 * KV 配额：预览 KV 和生产网关共用整个账号每天 1000 次写 / 删 / 列（免费计划）。这里每一次 KV 操作都算数：
 * - 会话 / LockReauthTicket 缓存后先用只读接口确认（见 state），不再每个用例重新密码解锁 / root-auth；
 * - 重置开关键不删（签过的值在 D1 标了已用，见 resetTicketViaSwitch）。
 * 一次运行花多少可以用 preview-emulator.cjs 在本地量（/__kv/stats）。
 *
 * 预览站上的 cookie：
 * - 锁屏会话 sgx-lock-session 固定带 Domain=.styrigx.com，浏览器在 *.pages.dev 上不会存。
 *   api() 每次都把响应里的 sgx-lock-* cookie 按预览主机名重新写进 context（Max-Age=0 → 删掉），
 *   这样纪元推进后服务端重签的会话 / 票也能接着用。
 * - reauth / reset 票本来就只发主机（不带 Domain），照样写一遍，无副作用。
 *
 * 预览站用同一个 KV / D1。CI 每次开跑前删掉预览 KV 里「锁屏 / 账号已设置」的状态和按 IP 的失败计数
 * （scripts/kv-budget.mjs reset-preview；RootKey、pepper 每次都换，旧的密码哈希没用了），
 * 但 KV 删除传到边缘要时间、本地跑也不清，所以 helper 仍不假设起始状态：
 * - adminSession：先用本次运行设过的锁屏密码解锁；不行就拿 LockResetTicket（锁屏未设置时 root-auth
 *   purpose:lock-reset；已设置时写一个新的重置开关值，轮询 /api/lock-reset），设一个新密码再解锁。
 * - 根凭证正确时服务端会清掉本 IP 的失败计数，所以轮询重置开关不会把自己锁住。
 */
const { expect } = require('@playwright/test');

const BASE = (process.env.SGX_TEST_BASE || '').replace(/\/+$/, '');
const ROOT_KEY = process.env.SGX_TEST_ROOT_KEY || '';
const CF_TOKEN = process.env.SGX_TEST_CF_TOKEN || '';
const CF_ACCOUNT = process.env.SGX_TEST_CF_ACCOUNT || '';
const KV_ID = process.env.SGX_TEST_PREVIEW_KV_ID || '';
/* Cloudflare API 根地址：只有模拟预览站（preview-emulator.cjs；本地或 CI 的 PR 运行）时才改，真实预览不设 */
const CF_API = (process.env.SGX_TEST_CF_API || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');

const READY = !!(BASE && ROOT_KEY);
const HAS_CF = !!(CF_TOKEN && CF_ACCOUNT && KV_ID);
const ORIGIN = BASE ? new URL(BASE).origin : '';
const SECURE = ORIGIN.startsWith('https:');

const SESSION = 'sgx-lock-session';
const REAUTH = 'sgx-lock-reauth';
const RESET = 'sgx-lock-reset';
const ACCOUNT_SESSION = 'sgx-account-session';
const ACCOUNT_REAUTH = 'sgx-account-reauth';
const ACCOUNT_RESET = 'sgx-account-reset';
const TRACKED = [SESSION, REAUTH, RESET, ACCOUNT_SESSION, ACCOUNT_REAUTH, ACCOUNT_RESET];

/**
 * worker 进程内的缓存（测试失败换 worker 后丢失，adminSession 会走重置）：
 * - password：本次运行设过的锁屏密码
 * - session / reauth：服务端最近一次发下来的 admin 锁屏会话、LockReauthTicket 的值（absorbCookies 顺手记下）。
 *   每个用例是新的 context，以前每次都要重新密码解锁、重新 root-auth 进门；而网关每次密码解锁成功会删两个限速键、
 *   每次 root-auth 成功会写一条审计并删一个限速键（都算 KV 写 / 删配额）。所以 adminSession / lockReauth 先把缓存的值
 *   放回 context，用只读接口（lock-session-check / lock-reauth status，只有 KV 读）问服务端还认不认，认就直接用，
 *   不认（纪元推进、过期）才走原来的路。是不是有效由服务端判断，测试断言一条不少。
 */
const state = { password: '', session: '', reauth: '' };

function rand() {
  return Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

/**
 * 整组的前置检查：本地没配预览变量 → 跳过；CI 里没配 → 失败（不许整组静默跳过还算绿）。
 * @param {import('@playwright/test').TestType<any, any>} test
 */
function requirePreview(test) {
  if (process.env.CI) {
    test.beforeAll(() => {
      if (!READY) throw new Error('passkey-e2e 需要 SGX_TEST_BASE 与 SGX_TEST_ROOT_KEY（CI 里缺失视为失败）');
    });
  } else {
    test.skip(!READY, '需要 SGX_TEST_BASE 与 SGX_TEST_ROOT_KEY');
  }
}

/**
 * 单个用例要写预览 KV 时调用：本地没配 → 跳过；CI 里没配 → 失败。
 * @param {import('@playwright/test').TestType<any, any>} test
 */
function requireCf(test) {
  if (HAS_CF) return;
  if (process.env.CI) throw new Error('需要 SGX_TEST_CF_TOKEN / SGX_TEST_CF_ACCOUNT / SGX_TEST_PREVIEW_KV_ID');
  test.skip(true, '需要 SGX_TEST_CF_TOKEN / SGX_TEST_CF_ACCOUNT / SGX_TEST_PREVIEW_KV_ID');
}

/**
 * CDP 虚拟认证器。uv=true：带用户验证且已验证（服务端注册和解锁都要求 UV=1）；
 * uv=false：没有用户验证能力（authData 的 UV 位为 0）。
 * @param {import('@playwright/test').Page} page
 * @param {{uv?: boolean}} [opts]
 */
async function addVirtualAuth(page, opts) {
  const uv = !!(opts && opts.uv);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: uv,
      isUserVerified: uv,
      automaticPresenceSimulation: true,
    },
  });
  return {
    cdp,
    authenticatorId,
    remove: async () => {
      try { await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }); } catch (e) {}
    },
  };
}

/**
 * 响应里某个 cookie 的整行 Set-Cookie（没有 → ''）。
 * @param {import('@playwright/test').APIResponse} resp
 * @param {string} name
 */
function setCookieLine(resp, name) {
  for (const h of resp.headersArray()) {
    if (h.name.toLowerCase() === 'set-cookie' && h.value.startsWith(name + '=')) return h.value;
  }
  return '';
}

/** @param {string} line */
function cookieValue(line) {
  const pair = (line || '').split(';')[0];
  return pair.split('=').slice(1).join('=');
}

/**
 * 把响应里的 sgx-lock-* / sgx-account-* cookie 按预览主机写进 context（见文件头）。
 * @param {import('@playwright/test').BrowserContext} context
 * @param {import('@playwright/test').APIResponse} resp
 */
async function absorbCookies(context, resp) {
  for (const h of resp.headersArray()) {
    if (h.name.toLowerCase() !== 'set-cookie') continue;
    const parts = h.value.split(';').map((s) => s.trim());
    const name = parts[0].split('=')[0];
    if (TRACKED.indexOf(name) === -1) continue;
    const value = cookieValue(h.value);
    const attrs = parts.slice(1).map((s) => s.toLowerCase());
    if (!value || attrs.indexOf('max-age=0') !== -1) {
      await context.clearCookies({ name });
      continue;
    }
    if (name === SESSION) state.session = value;
    if (name === REAUTH) state.reauth = value;
    const ss = attrs.find((a) => a.startsWith('samesite='));
    await context.addCookies([{
      name,
      value,
      url: ORIGIN + '/',
      httpOnly: true,
      secure: SECURE,
      sameSite: ss && ss.endsWith('strict') ? 'Strict' : 'Lax',
    }]);
  }
}

/**
 * 同源 POST JSON（带 Origin；cookie 用页面 context 的），并吸收响应 cookie。
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 * @param {object} data
 */
async function api(page, path, data) {
  const resp = await page.request.post(BASE + path, { headers: { Origin: ORIGIN }, data: data || {} });
  await absorbCookies(page.context(), resp);
  let json = null;
  try { json = await resp.json(); } catch (e) {}
  return { status: resp.status(), json, resp };
}

/**
 * 同源 GET JSON（cookie 用页面 context 的）。
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 */
async function apiGet(page, path) {
  const resp = await page.request.get(BASE + path, { maxRedirects: 0 });
  let json = null;
  try { json = await resp.json(); } catch (e) {}
  return { status: resp.status(), json, resp };
}

/* ---------- 预览 KV（Cloudflare REST，只用预览命名空间） ---------- */
function kvUrl(key) {
  return `${CF_API}/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${KV_ID}/values/${encodeURIComponent(key)}`;
}
async function kvPut(key, value) {
  const r = await fetch(kvUrl(key), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'text/plain' },
    body: value,
  });
  if (!r.ok) throw new Error('KV put failed: ' + r.status);
}
async function kvDel(key) {
  await fetch(kvUrl(key), { method: 'DELETE', headers: { Authorization: `Bearer ${CF_TOKEN}` } });
}
/** 删掉某前缀下的所有键（清根凭证限速计数用） */
async function kvDelPrefix(prefix) {
  const u = `${CF_API}/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${KV_ID}/keys?prefix=${encodeURIComponent(prefix)}`;
  const r = await fetch(u, { headers: { Authorization: `Bearer ${CF_TOKEN}` } });
  if (!r.ok) return;
  const j = await r.json();
  for (const k of (j && j.result) || []) await kvDel(k.name);
}

/**
 * 用重置开关拿 LockResetTicket：写一个新开关值（1 个 KV 写），轮询 /api/lock-reset verify 直到签票
 * （KV 写入到边缘读到可能要几十秒）。每次轮询根凭证都正确，服务端先清本 IP 的失败计数，不会自锁。
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<import('@playwright/test').APIResponse>} 签票的那次响应
 */
async function resetTicketViaSwitch(page) {
  const value = 'e2e-' + rand();
  await kvPut('lock-reset-switch', value);
  let hit = null;
  await expect.poll(async () => {
    const r = await api(page, '/api/lock-reset', { action: 'verify', rootKey: ROOT_KEY });
    if (r.status === 200 && r.json && r.json.ok && !r.json.needAccount) {
      hit = r.resp;
      return 'ticket';
    }
    return r.status + ' ' + JSON.stringify(r.json);
  }, { message: '重置开关签 LockResetTicket', timeout: 90000, intervals: [3000, 10000, 15000, 20000] }).toBe('ticket');
  /* 不再删开关键（以前 finally 里 kvDel，每次 1 个 KV 删除）：签过票的值在 D1 里标了已用，永不再生效；
     下次要用时 kvPut 直接覆盖成新值；万一没签成（轮询超时），这个值也只对本次运行现生成的预览 RootKey 有用，
     24 小时后自动过期。lock-reset-switch.js：已用 / 过期的值永不重新生效。 */
  return /** @type {any} */ (hit);
}

/**
 * 拿 LockResetTicket（写进 context）：锁屏未设置 → root-auth purpose:lock-reset；已设置 → 重置开关。
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').TestType<any, any>} test
 */
async function lockResetTicket(page, test) {
  const r = await api(page, '/api/root-auth', { key: ROOT_KEY, purpose: 'lock-reset' });
  if (r.status === 200 && r.json && r.json.ok) return 'root-auth';
  /* 锁屏已设置时 root-auth 的 lock-reset 是假入口，固定 401 */
  expect(r.status, 'root-auth lock-reset: ' + JSON.stringify(r.json)).toBe(401);
  requireCf(test);
  await resetTicketViaSwitch(page);
  return 'switch';
}

/**
 * 锁屏密码解锁（带少量重试：刚写入的密码在 KV 里可能还没读到）。
 * @param {import('@playwright/test').Page} page
 * @param {string} password
 */
async function unlockWithPassword(page, password) {
  let r = null;
  for (let i = 0; i < 3; i++) {
    r = await api(page, '/api/lock-password', { action: 'verify', password });
    if (r.json && r.json.ok) return r;
    if (r.status === 429) break;
    await page.waitForTimeout(2000);
  }
  return /** @type {any} */ (r);
}

/**
 * 让页面 context 拿到 admin 锁屏会话（sgx-lock-session，按预览主机写入）。返回当前锁屏密码。
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').TestType<any, any>} test
 */
async function adminSession(page, test) {
  if (state.password && state.session && await reuseCookie(page, SESSION, state.session, async () => {
    const c = await apiGet(page, '/api/lock-session-check');
    return c.status === 200;
  })) {
    return state.password;
  }
  if (state.password) {
    const r = await api(page, '/api/lock-password', { action: 'verify', password: state.password });
    if (r.json && r.json.ok) return state.password;
    state.password = '';
  }
  await lockResetTicket(page, test);
  const pw = 'e2e-pw-' + rand();
  let r = await api(page, '/api/lock-password', { action: 'set', password: pw });
  if (r.json && r.json.error === 'exists') {
    r = await api(page, '/api/lock-password', { action: 'change', password: pw });
  }
  expect(r.json && r.json.ok, 'LockResetTicket 设锁屏密码: ' + JSON.stringify(r.json)).toBe(true);
  state.password = pw;
  await page.context().clearCookies({ name: RESET });
  r = await unlockWithPassword(page, pw);
  expect(r.json && r.json.ok, '锁屏密码解锁: ' + JSON.stringify(r.json)).toBe(true);
  const cookies = await page.context().cookies(ORIGIN);
  expect(cookies.some((c) => c.name === SESSION), '解锁后 context 里有 sgx-lock-session').toBe(true);
  return pw;
}

/**
 * 把缓存的 cookie 值放回 context，用只读接口确认服务端还认；不认就从 context 里拿掉并返回 false。
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} value
 * @param {() => Promise<boolean>} stillValid
 */
async function reuseCookie(page, name, value, stillValid) {
  await page.context().addCookies([{
    name, value, url: ORIGIN + '/', httpOnly: true, secure: SECURE, sameSite: name === REAUTH ? 'Strict' : 'Lax',
  }]);
  if (await stillValid()) return true;
  await page.context().clearCookies({ name });
  return false;
}

/** 记下本次运行改过的锁屏密码（change / 删后重设时调用） */
function rememberPassword(pw) {
  state.password = pw || '';
}

/**
 * 进锁屏凭证的门：root-auth purpose:lock-reauth → LockReauthTicket（要 admin 会话）。
 * @param {import('@playwright/test').Page} page
 */
async function lockReauth(page) {
  if (state.reauth && await reuseCookie(page, REAUTH, state.reauth, async () => {
    const st = await api(page, '/api/lock-reauth', { action: 'status' });
    return !!(st.json && st.json.ok && st.json.valid && st.json.ticket === 'lock-reauth');
  })) {
    return;
  }
  const r = await api(page, '/api/root-auth', { key: ROOT_KEY, purpose: 'lock-reauth' });
  expect(r.json && r.json.ok, 'root-auth lock-reauth: ' + JSON.stringify(r.json)).toBe(true);
}

/** @param {import('@playwright/test').Page} page */
async function currentCookie(page, name) {
  const c = (await page.context().cookies(ORIGIN)).find((x) => x.name === name);
  return c ? c.value : '';
}

/**
 * 让页面停在预览站同源的轻量页面上（WebAuthn 的 rpId 必须与页面同源）。
 * @param {import('@playwright/test').Page} page
 */
async function onOrigin(page) {
  if (!page.url().startsWith(ORIGIN + '/')) await page.goto(BASE + '/robots.txt');
}

/**
 * 页面里跑 navigator.credentials.create，用服务端下发的 challenge 注册一把锁屏通行密钥。
 * 非常驻凭据（residentKey: discouraged）：同一个虚拟认证器上可以并存多把。
 * @param {import('@playwright/test').Page} page
 * @param {{name?: string, uv?: boolean}} [opts]
 */
async function registerPasskey(page, opts) {
  const o = opts || {};
  await onOrigin(page);
  const ch = await api(page, '/api/lock-passkey', { action: 'challenge', type: 'register' });
  expect(ch.json && ch.json.ok, 'register challenge: ' + JSON.stringify(ch.json)).toBe(true);
  const credential = await page.evaluate(async ({ ch, uv }) => {
    const dec = (s) => {
      const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
      const u = new Uint8Array(b.length);
      for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
      return u.buffer;
    };
    const enc = (buf) => {
      const u = new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };
    const c = /** @type {any} */ (await navigator.credentials.create({
      publicKey: {
        challenge: dec(ch.challenge),
        rp: { id: ch.rpId, name: (ch.rp && ch.rp.name) || 'Styrigx' },
        user: { id: dec(ch.user.id), name: ch.user.name, displayName: ch.user.displayName },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { residentKey: 'discouraged', userVerification: uv ? 'required' : 'discouraged' },
        attestation: 'none',
        timeout: 20000,
      },
    }));
    return {
      id: c.id,
      rawId: enc(c.rawId),
      type: c.type,
      response: { clientDataJSON: enc(c.response.clientDataJSON), attestationObject: enc(c.response.attestationObject) },
    };
  }, { ch: ch.json, uv: o.uv !== false });
  const body = { action: 'register', cid: ch.json.cid, credential };
  if (o.name) body.name = o.name;
  return await api(page, '/api/lock-passkey', body);
}

/**
 * 用某一把锁屏通行密钥做一次断言（navigator.credentials.get，只允许这一把）。
 * @param {import('@playwright/test').Page} page
 * @param {string} credId
 * @param {{reauth?: boolean}} [opts]
 */
async function assertPasskey(page, credId, opts) {
  await onOrigin(page);
  const ch = await api(page, '/api/lock-passkey', { action: 'challenge', type: 'auth' });
  expect(ch.json && ch.json.ok, 'auth challenge: ' + JSON.stringify(ch.json)).toBe(true);
  const credential = await page.evaluate(async ({ ch, credId }) => {
    const dec = (s) => {
      const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
      const u = new Uint8Array(b.length);
      for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
      return u.buffer;
    };
    const enc = (buf) => {
      const u = new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };
    const c = /** @type {any} */ (await navigator.credentials.get({
      publicKey: {
        challenge: dec(ch.challenge),
        rpId: ch.rpId,
        allowCredentials: [{ type: 'public-key', id: dec(credId) }],
        userVerification: 'required',
        timeout: 20000,
      },
    }));
    return {
      id: c.id,
      rawId: enc(c.rawId),
      type: c.type,
      response: {
        authenticatorData: enc(c.response.authenticatorData),
        clientDataJSON: enc(c.response.clientDataJSON),
        signature: enc(c.response.signature),
        userHandle: c.response.userHandle ? enc(c.response.userHandle) : null,
      },
    };
  }, { ch: ch.json, credId });
  const body = { action: 'auth', cid: ch.json.cid, credential };
  if (opts && opts.reauth) body.reauth = true;
  return await api(page, '/api/lock-passkey', body);
}

/**
 * 锁屏通行密钥列表（要 LockReauthTicket）。
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Array<{credId: string, name: string}>>}
 */
async function listPasskeys(page) {
  const r = await api(page, '/api/lock-passkey', { action: 'list' });
  expect(r.json && r.json.ok, 'passkey list: ' + JSON.stringify(r.json)).toBe(true);
  return r.json.keys || [];
}

/**
 * 删掉全部锁屏通行密钥（清理用；锁屏密码保留，所以不会碰到「最后一把钥匙」）。
 * @param {import('@playwright/test').Page} page
 */
async function deleteAllPasskeys(page) {
  const r = await api(page, '/api/lock-passkey', { action: 'list' });
  if (!r.json || !r.json.ok) return;
  for (const k of r.json.keys || []) {
    await api(page, '/api/lock-passkey', { action: 'delete', credId: k.credId });
  }
}

/** 锁屏会话 cookie 值里的纪元（by.role.epoch.exp.tempkeyId.sig） */
function cookieEpoch(line) {
  return parseInt(cookieValue(line).split('.')[2], 10);
}

module.exports = {
  BASE,
  ORIGIN,
  ROOT_KEY,
  READY,
  HAS_CF,
  SESSION,
  REAUTH,
  RESET,
  rand,
  requirePreview,
  requireCf,
  addVirtualAuth,
  setCookieLine,
  cookieValue,
  cookieEpoch,
  api,
  apiGet,
  kvPut,
  kvDel,
  kvDelPrefix,
  resetTicketViaSwitch,
  lockResetTicket,
  unlockWithPassword,
  adminSession,
  rememberPassword,
  lockReauth,
  currentCookie,
  onOrigin,
  registerPasskey,
  assertPasskey,
  listPasskeys,
  deleteAllPasskeys,
};
