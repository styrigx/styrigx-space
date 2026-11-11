/**
 * 预览站（真实网关 + 账号 Worker，组合入口 preview-worker.js）E2E 的共享 helper：passkey.spec.js、account-passkey.spec.js 共用。
 *
 * 环境变量（CI 的 passkey-e2e job 注入；本地没配时整组跳过，CI 里缺了直接失败）：
 * - SGX_TEST_BASE：预览站地址（https://passkey-e2e.styrigx-space.pages.dev，或 PR 运行的本地模拟器）
 * - SGX_TEST_CF_TOKEN / SGX_TEST_CF_ACCOUNT / SGX_TEST_PREVIEW_D1_ID：写预览 D1（D1 REST query；requireCf）
 * - SGX_TEST_CF_API：只在模拟预览站（preview-emulator.cjs：本地，或 CI 里 pull_request 的运行）时设，把 Cloudflare REST 指到本机
 *
 * v6 P4（定稿 v5.3 §十三 P4 行）：进站会话、锁侧复验 / 重置票、旧账号会话、恢复钥匙随后端删旧删除；
 * 测试进站凭证 SGX_TEST_SPACE_KEY、测试恢复密钥 SGX_TEST_RECOVERY_KEY 和围绕它们的 helper（adminSession、lockReauth、
 * lockResetTicket、registerPasskey …）一并拿掉。
 */
const BASE = (process.env.SGX_TEST_BASE || '').replace(/\/+$/, '');
const CF_TOKEN = process.env.SGX_TEST_CF_TOKEN || '';
const CF_ACCOUNT = process.env.SGX_TEST_CF_ACCOUNT || '';
const D1_ID = process.env.SGX_TEST_PREVIEW_D1_ID || '';
/* Cloudflare API 根地址：只有模拟预览站（preview-emulator.cjs；本地或 CI 的 PR 运行）时才改，真实预览不设 */
const CF_API = (process.env.SGX_TEST_CF_API || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');

const READY = !!BASE;
const HAS_CF = !!(CF_TOKEN && CF_ACCOUNT && D1_ID);
const ORIGIN = BASE ? new URL(BASE).origin : '';

/** 写状态的用例的单条超时（D1 强一致，留着当上限） */
const KV_TEST_TIMEOUT = 240000;

function rand() {
  return Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

/**
 * 整组的前置检查：本地没配预览地址 → 跳过；CI 里没配 → 失败（不许整组静默跳过还算绿）。
 * @param {import('@playwright/test').TestType<any, any>} test
 */
function requirePreview(test) {
  if (process.env.CI) {
    test.beforeAll(() => {
      if (!READY) throw new Error('passkey-e2e 需要 SGX_TEST_BASE（CI 里缺失视为失败）');
    });
  } else {
    test.skip(!READY, '需要 SGX_TEST_BASE');
  }
}

/**
 * 单个用例要写预览 D1 时调用：本地没配 → 跳过；CI 里没配 → 失败。
 * @param {import('@playwright/test').TestType<any, any>} test
 */
function requireCf(test) {
  if (HAS_CF) return;
  if (process.env.CI) throw new Error('需要 SGX_TEST_CF_TOKEN / SGX_TEST_CF_ACCOUNT / SGX_TEST_PREVIEW_D1_ID');
  test.skip(true, '需要 SGX_TEST_CF_TOKEN / SGX_TEST_CF_ACCOUNT / SGX_TEST_PREVIEW_D1_ID');
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

/* ---------- 预览 D1（Cloudflare D1 REST query，只用预览测试库 styrigx-test-preview，库 id 由 SGX_TEST_PREVIEW_D1_ID 给） ---------- */
/** @param {string} sql @param {any[]} [params] */
async function d1Query(sql, params) {
  const r = await fetch(`${CF_API}/accounts/${CF_ACCOUNT}/d1/database/${D1_ID}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: sql, params: params || [] }),
  });
  if (!r.ok) throw new Error('D1 query failed: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  return (j && j.result && j.result[0]) || {};
}

module.exports = {
  BASE,
  ORIGIN,
  READY,
  HAS_CF,
  KV_TEST_TIMEOUT,
  rand,
  requirePreview,
  requireCf,
  addVirtualAuth,
  setCookieLine,
  cookieValue,
  apiGet,
  d1Query,
};
