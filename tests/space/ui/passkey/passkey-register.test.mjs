/**
 * 通行密钥注册（auth/passkey-register.js，frontend-js #8）：锁屏凭证页和账号安全页共用的注册流程。
 * - 服务端拒绝注册时按服务端的错误码和 HTTP 状态出提示（锁屏页以前读不存在的 r.status，
 *   ReferenceError 被 catch 成「网络错误」，真正的原因永远看不到）
 * - 取消 / 已注册 / 不支持 / 鉴权失败交给页面 / 成功打开命名弹层，请求体格式
 * - 两页都只经这里注册，不再各自手写 credentials.create
 * 运行：node --test tests/space/ui/passkey/passkey-register.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const rd = (p) => readFileSync(join(root, p), 'utf8');

/** @type {any} */ let createImpl = null;
/** @type {any[]} */ const created = [];
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { credentials: { create: async (o) => { created.push(o); return createImpl(o); } } },
});
globalThis.window = /** @type {any} */ ({ PublicKeyCredential: function () {} });

const { registerPasskey, attestationToJSON, creationOptions, genPkPrefillName, cleanPasskeyName } =
  await import('../../../../space/web/assets/js/auth/passkey-register.js');

const B = (s) => new TextEncoder().encode(s).buffer;
const fakeCred = () => ({ id: 'cid-1', rawId: B('raw'), type: 'public-key', response: { clientDataJSON: B('cd'), attestationObject: B('ao') } });
const CH = { ok: true, cid: 'c1', challenge: 'AQID', rpId: 'styrigx.com', user: { id: 'dXNlcg', name: 'SpacePasskey', displayName: 'Sloan' }, excludeCredentials: [{ id: 'AAEC', type: 'public-key' }] };

function harness(over) {
  const log = { toasts: [], errText: [], registered: [], bodies: [], auth: 0 };
  const o = Object.assign({
    challenge: async () => ({ status: 200, json: CH }),
    register: async (body) => { log.bodies.push(body); return { status: 200, json: { ok: true, credId: 'cid-1' } }; },
    onAuthError: () => false,
    onRegistered: (id, prefill) => log.registered.push([id, prefill]),
    prefill: () => 'Android',
    errText: (code, status) => { log.errText.push([code, status]); return 'ERR:' + code + ':' + status; },
    toast: (m) => log.toasts.push(m),
    msg: { cancelled: 'CANCELLED', already: 'ALREADY', noSupport: 'NOSUPPORT', failed: 'FAILED', network: 'NETWORK' },
  }, over || {});
  return { o, log };
}

test('服务端拒绝注册：提示用服务端错误码 + HTTP 状态，不是「网络错误」（锁屏页 r.status 未定义的回归）', async () => {
  createImpl = async () => fakeCred();
  const { o, log } = harness({ register: async () => ({ status: 409, json: { ok: false, error: 'duplicate' } }) });
  await registerPasskey(o);
  assert.deepEqual(log.errText, [['duplicate', 409]]);
  assert.deepEqual(log.toasts, ['ERR:duplicate:409']);
  assert.ok(!log.toasts.includes('NETWORK'));
  assert.deepEqual(log.registered, []);
  /* 正文不是 JSON（json:null）也走服务端错误，带上状态 */
  const h2 = harness({ register: async () => ({ status: 500, json: null }) });
  await registerPasskey(h2.o);
  assert.deepEqual(h2.log.errText, [[null, 500]]);
});

test('成功：register 带 cid、预填名、attestation JSON；打开命名弹层（credId + 预填名）', async () => {
  createImpl = async () => fakeCred();
  const { o, log } = harness();
  await registerPasskey(o);
  assert.deepEqual(log.registered, [['cid-1', 'Android']]);
  assert.equal(log.bodies.length, 1);
  assert.deepEqual(log.bodies[0], { cid: 'c1', name: 'Android', credential: attestationToJSON(fakeCred()) });
  assert.deepEqual(log.bodies[0].credential, { id: 'cid-1', rawId: 'cmF3', type: 'public-key', response: { clientDataJSON: 'Y2Q', attestationObject: 'YW8' } });
  assert.deepEqual(log.toasts, []);
  /* 选项来自服务端：rp.id、用户、excludeCredentials、UV / resident 必须 */
  const pk = created[created.length - 1].publicKey;
  assert.equal(pk.rp.id, 'styrigx.com');
  assert.equal(pk.user.name, 'SpacePasskey');
  assert.equal(pk.excludeCredentials.length, 1);
  assert.deepEqual(pk.authenticatorSelection, { userVerification: 'required', residentKey: 'required' });
  assert.deepEqual(pk.pubKeyCredParams, [{ type: 'public-key', alg: -7 }]);
});

test('系统窗口的错误：取消 / 已注册 / 不支持 / 其他各一条提示，不调 register', async () => {
  for (const [name, want] of [['NotAllowedError', 'CANCELLED'], ['InvalidStateError', 'ALREADY'], ['NotSupportedError', 'NOSUPPORT'], ['UnknownError', 'FAILED']]) {
    createImpl = async () => { const e = new Error(name); e.name = name; throw e; };
    const { o, log } = harness();
    await registerPasskey(o);
    assert.deepEqual(log.toasts, [want], name);
    assert.equal(log.bodies.length, 0, name);
  }
});

test('鉴权失败交给页面处理（返回 true 不再提示）；challenge 被拒带码和状态；网络失败 → 网络错误', async () => {
  createImpl = async () => fakeCred();
  let seen = null;
  const a = harness({ challenge: async () => ({ status: 403, json: { ok: false, error: 'reauth' } }), onAuthError: (res) => { seen = res; return true; } });
  await registerPasskey(a.o);
  assert.deepEqual(seen, { status: 403, json: { ok: false, error: 'reauth' } });
  assert.deepEqual(a.log.toasts, []);
  const b = harness({ challenge: async () => ({ status: 503, json: { ok: false, error: 'server' } }) });
  await registerPasskey(b.o);
  assert.deepEqual(b.log.toasts, ['ERR:server:503']);
  const c = harness({ register: async () => { throw new TypeError('fetch failed'); } });
  await registerPasskey(c.o);
  assert.deepEqual(c.log.toasts, ['NETWORK']);
  /* 浏览器不支持 WebAuthn：直接提示，不请求 challenge */
  const pkc = globalThis.window.PublicKeyCredential;
  globalThis.window.PublicKeyCredential = undefined;
  let asked = false;
  const d = harness({ challenge: async () => { asked = true; return { status: 200, json: CH }; } });
  await registerPasskey(d.o);
  globalThis.window.PublicKeyCredential = pkc;
  assert.equal(asked, false);
  assert.deepEqual(d.log.toasts, ['NOSUPPORT']);
});

test('调用方放弃（stale，终端里 ^C，2026-11-09）：不开系统窗口 / 不提交注册 / 不提示；signal 交给系统窗口；不传时请求里没有 signal', async () => {
  /* 拿 challenge 前就放弃：不开系统窗口 */
  const before = created.length;
  const a = harness({ stale: () => true });
  createImpl = async () => fakeCred();
  await registerPasskey(a.o);
  assert.equal(created.length, before);
  assert.deepEqual(a.log.toasts, []);
  assert.deepEqual(a.log.bodies, []);
  /* 系统窗口开着时放弃：窗口回来的结果（成功也好、AbortError 也好）都不提交、不提示 */
  let stop = false;
  const ac = new AbortController();
  const b = harness({ stale: () => stop, signal: ac.signal });
  createImpl = async (o) => { assert.equal(o.signal, ac.signal); stop = true; return fakeCred(); };
  await registerPasskey(b.o);
  assert.deepEqual(b.log.bodies, []);
  assert.deepEqual(b.log.toasts, []);
  stop = false;
  const c = harness({ stale: () => stop, signal: ac.signal });
  createImpl = async () => { stop = true; throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  await registerPasskey(c.o);
  assert.deepEqual(c.log.toasts, []);
  /* 不传 stale / signal：照旧，请求里没有 signal 键 */
  const d = harness();
  createImpl = async (o) => { assert.ok(!('signal' in o)); return fakeCred(); };
  await registerPasskey(d.o);
  assert.equal(d.log.registered.length, 1);
});

test('creationOptions：服务端没给用户名时用页面兜底；预填名兜底 / 名字清理', () => {
  const pk = creationOptions({ challenge: 'AQID', rpId: 'x', user: { id: 'dXNlcg' } }, { name: 'SpacePasskey', displayName: 'Sloan Gray' });
  assert.equal(pk.user.name, 'SpacePasskey');
  assert.equal(pk.user.displayName, 'Sloan Gray');
  assert.equal(pk.rp.name, 'Styrigx');
  assert.equal(genPkPrefillName('Passkey'), 'Passkey');
  assert.equal(cleanPasskeyName('  a\u0000b\u007f  '), 'ab');
  assert.equal(cleanPasskeyName('x'.repeat(50)).length, 40);
});

test('账号 / 进站都只经 passkey-register.js 注册：不再手写 credentials.create / 命名弹层', () => {
  /* 2026-11-08：账号安全页删了，账号通行密钥在终端的账号层 shell/account/cmd/keys.js 里注册（命名在终端里问，不用命名弹层） */
  {
    const src = rd('space/web/assets/js/shell/account/cmd/keys.js');
    assert.ok(src.includes("from '../../../auth/passkey-register.js'"));
    assert.ok(src.includes('registerPasskey({'));
    assert.ok(!src.includes('navigator.credentials.create'), 'keys.js 不手写注册');
    assert.ok(src.includes("genPkPrefillName('')"), 'keys.js 预填名不拿界面文案兜底');
  }
  /* 进站 v3 L1：进站通行密钥在盾牌进站凭证层（shell/space/keys.js）和 reset 终端（shell/space/reset.js）注册；命名在终端里问（Q9），没有命名弹层；apps/security-lock.js 删了 */
  for (const f of ['space/web/assets/js/shell/space/keys.js', 'space/web/assets/js/shell/space/reset.js']) {
    const src = rd(f);
    assert.ok(src.includes("from '../../auth/passkey-register.js'"), f);
    assert.ok(src.includes('registerPasskey({') && !src.includes('createPkNameDialog'), f + ' 终端里问名字，不用命名弹层');
    assert.ok(!src.includes('navigator.credentials.create'), f + ' 不手写注册');
    assert.ok(!/function (openPkNameDlg|closePkNameDlg|genPkPrefillName)\b/.test(src), f + ' 不再各留一份命名弹层');
    assert.ok(src.includes("genPkPrefillName('')"), f + ' 预填名不拿界面文案兜底');
    assert.ok(!src.includes("genPkPrefillName(t("), f);
  }
  assert.ok(!existsSync(join(root, 'space/web/assets/js/apps/security-lock.js')), 'security-lock.js 已删');
  /* 全站只有这一处 credentials.create */
  const lib = rd('space/web/assets/js/auth/passkey-register.js');
  assert.ok(lib.includes('navigator.credentials.create'));
});
