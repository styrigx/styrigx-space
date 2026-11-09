/**
 * 认证入口修正测试（space）。
 *
 * 覆盖：
 * 1. 锁屏按锁屏凭证配置显示入口（临时钥匙 / 通行密钥 / 密码 / 无法登录？），不含进站凭证
 * 2. 安全页 DOM 结构对所有进门的人一致（无角色条件渲染）
 * 3. space-auth lock-reauth 要先进门（任何 by，含临时钥匙）；进门后走真比对（计数、审计），没进门 401 session 不比对
 * 4. 锁屏凭证弹层四种配置下按钮正确（未设置/仅通行密钥/仅密码/两者都有）
 * 5. 三类通行密钥注册 options 的 name/displayName 正确
 *    （owner→AccountKey，lock→LockKey，app→<aud小写>key；displayName 一律 Sloan Gray）
 *
 * 运行：node --test tests/kernel/auth-entry.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testLockSession } from './_tickets.mjs';
import { makeKV, genKeyPair, postReq, authD1For } from '../_harness.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* 测试用 Ed25519 密钥 */
let TEST_PRIV_PEM = '';
let TEST_PUB_PEM = '';
async function genTestKeys() {
  ({ priv: TEST_PRIV_PEM, pub: TEST_PUB_PEM } = await genKeyPair());
}
await genTestKeys();

function baseEnv(kv, overrides) {
  return Object.assign({
    D1_LOCK_AUTH: authD1For(kv),
    SGX_LOCK_SPACE_KEY: 'test-root-key-12345',
    SGX_LOCK_PRIVATE: TEST_PRIV_PEM,
    SGX_LOCK_PUBLIC: TEST_PUB_PEM,
    SGX_PW_PEPPER: 'test-pepper',
    SGX_RP_ID: 'test.example.com',
    SGX_ORIGIN: 'https://test.example.com',
  }, overrides || {});
}

/*
 * 「已配置」= D1 里真有凭证（layers.js realCredentialPresence）；旧 KV 标记 lock-configured / account-configured 不再算数。
 * configuredKV({ lock, account })：一份 kv（只当 authD1For 的钥匙），对应 D1 里写好锁屏 / 账号密码。
 */
const { makePasswordRecord: mkPw } = await import(REPO + '/workers/auth-gateway/src/core/password.js');
const LOCK_PW_REC = await mkPw('lock-pass-1', 'test-pepper');
const ACCOUNT_PW_REC = await mkPw('account-pass-1', 'test-pepper');
function configuredKV(o) {
  const kv = makeKV();
  const db = authD1For(kv);
  if (o && o.lock) db.putPassword('lock', LOCK_PW_REC);
  if (o && o.account) db.putPassword('account', ACCOUNT_PW_REC);
  return kv;
}
/** 网关对 D1 发过的写（纪元起步行 INSERT OR IGNORE INTO epoch 不算：那是读纪元的一部分） */
function d1Writes(db) {
  return db.calls.filter((sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql) && !/INSERT OR IGNORE INTO epoch/i.test(sql));
}
/** 进站凭证限速 / 审计行（realm = 'lock'） */
const spaceRows = (db) => ({
  attempts: db.raw.prepare("SELECT * FROM attempt_limit WHERE realm = 'lock'").all(),
  audits: db.raw.prepare("SELECT * FROM audit WHERE realm = 'lock'").all(),
});

/* ============ 1. 锁屏入口按配置显示（补充定稿七.1） ============ */

test('认证入口（L1 sudo styrigx）：锁屏能列哪些方式按 /api/lock-entry；只列已配置的密码 / 通行密钥，临时钥匙一直在；读失败按都设了；reset = sudo styrigx reset', async () => {
  const cmds = await import(REPO + '/space/web/assets/js/shell/space/commands.js');
  const paths = fs.readFileSync(path.join(REPO, 'space/web/assets/js/shell/space/paths.js'), 'utf8');
  const api = fs.readFileSync(path.join(REPO, 'space/web/assets/js/shell/space/api.js'), 'utf8');
  /* 配置以服务端 /api/lock-entry 为准，读失败按都设了（fail closed） */
  assert.ok(paths.includes("entry: '/api/lock-entry'"));
  assert.match(api, /export function entryConfig\(\)[\s\S]*?return \{ password: true, passkey: true \};/);
  assert.deepEqual(cmds.availableKinds({ password: true, passkey: false }, true, true), ['password', 'tempkey']);
  assert.deepEqual(cmds.availableKinds({ password: false, passkey: true }, true, true), ['passkey', 'tempkey']);
  assert.deepEqual(cmds.availableKinds({ password: false, passkey: true }, false, true), ['tempkey'], '本机不支持通行密钥不列');
  assert.deepEqual(cmds.availableKinds(null, true, true), ['passkey', 'password', 'tempkey'], '读不到按都设了');
  assert.deepEqual(cmds.availableKinds(null, true, false), ['passkey', 'password'], 'reauth 不给临时钥匙');
  /* 命令：sudo styrigx [passkey|password|tempkey]、sudo styrigx reset；旧别名一律不认 */
  assert.deepEqual(cmds.parseEntryCmd('sudo styrigx'), { cmd: 'session' });
  for (const k of ['passkey', 'password', 'tempkey']) assert.deepEqual(cmds.parseEntryCmd('sudo styrigx ' + k), { cmd: 'session', arg: k });
  assert.deepEqual(cmds.parseEntryCmd('sudo styrigx reset'), { cmd: 'reset' });
  for (const old of ['reset', 'forgot', 'password', 'pk', 'tempkey', 'sudo spacekey', 'sudo reset', 'cd ..']) {
    assert.deepEqual(cmds.parseEntryCmd(old), { cmd: 'unknown' }, old);
  }
  /* 启动站（什么都没设）也只走 sudo styrigx reset → /api/lock-reset，不再走 /api/space-auth lock-reset；root-session 早删了 */
  const dir = path.join(REPO, 'space/web/assets/js/shell/space');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!src.includes("purpose: 'lock-reset'") && !src.includes('/api/space-auth'), f + ' 不走 space-auth');
    assert.ok(!src.includes('root-session') && !src.includes('exchangeRootSession'), f);
    assert.ok(!src.includes('sgx-mopt-') && !src.includes('function openMk'), f + ' 没有方式弹层');
  }
  assert.equal(fs.existsSync(path.join(REPO, 'space/web/assets/js/shell/lock.js')), false, '旧锁屏 lock.js 已删');
});

/* ============ 2. 安全页 DOM 一致 ============ */


/* ============ 3. 认证入口：临时钥匙进门也走真比对（v1 的假入口已删） ============ */

const setCk = (res) => (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || '']);

test('认证入口：锁屏未设置时 lock-reset 提交错误进站凭证 → 401 auth，走真比对：计 space-limit、写审计；固定最小延迟', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/src/api/space-auth.js');
  const kv = configuredKV({});
  const env = baseEnv(kv);
  const req = postReq('https://test.example.com/api/space-auth', { key: 'wrong-key', purpose: 'lock-reset' });
  const t0 = Date.now();
  const res = await onRequestPost({ request: req, env });
  const dt = Date.now() - t0;
  assert.equal(res.status, 401);
  assert.equal(await res.text(), JSON.stringify({ ok: false, error: 'auth' }));
  const db = authD1For(kv);
  const rows = spaceRows(db);
  const sk = rows.attempts.filter((r) => r.kind === 'spacekey');
  assert.equal(sk.filter((r) => r.bucket !== '*').length, 1, '真失败计入 space-limit（kind=spacekey，单 IP 一行）');
  assert.equal(sk.filter((r) => r.bucket !== '*')[0].count, 1);
  assert.equal(sk.filter((r) => r.bucket === '*').length, 1, '也计入全局窗口');
  assert.equal(rows.audits.length, 1, '真路径写一行审计');
  assert.equal(setCk(res).filter((c) => c.startsWith('sgx-lock-reset=') && !c.startsWith('sgx-lock-reset=;')).length, 0, '失败不签票');
  assert.ok(dt >= 180, '应有固定最小延迟，实际 ' + dt + 'ms');
});

test('认证入口（v3 L1）：lock-reauth 已删——提交正确 / 错误进站凭证响应逐字节相同（400 purpose），不比对、不写 D1', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/src/api/space-auth.js');
  const kv1 = configuredKV({ lock: true });
  const kv2 = configuredKV({ lock: true });
  const res1 = await onRequestPost({ request: postReq('https://test.example.com/api/space-auth', { key: 'test-root-key-12345', purpose: 'lock-reauth' }), env: baseEnv(kv1) });
  const res2 = await onRequestPost({ request: postReq('https://test.example.com/api/space-auth', { key: 'wrong-key', purpose: 'lock-reauth' }), env: baseEnv(kv2) });
  assert.equal(res1.status, 400);
  assert.equal(res2.status, 400);
  const b1 = await res1.text();
  assert.equal(b1, await res2.text());
  assert.equal(b1, JSON.stringify({ ok: false, error: 'purpose' }));
  for (const kv of [kv1, kv2]) {
    const db = authD1For(kv);
    assert.deepEqual(d1Writes(db), [], '不写 D1');
    assert.deepEqual(spaceRows(db).attempts, [], '不计数');
  }
});

/* ============ 4. 管理凭证弹层按钮 ============ */

/* 账号体系：/api/account 账号拆分 PR3 起在账号 Worker（GET 的四种配置见 tests/workers/account/account-identity.test.mjs），网关只转发 */
test('行为：网关里没有 /api/account 的实现（不在路由表、文件已删），只在转发表里转给 ACCOUNT', async () => {
  const { API_ROUTES } = await import(REPO + '/workers/auth-gateway/src/router.js');
  const { matchForwarding } = await import(REPO + '/workers/auth-gateway/src/router.js');
  assert.equal(API_ROUTES.has('/api/account'), false);
  assert.equal(fs.existsSync(REPO + 'workers/auth-gateway/src/api/account.js'), false);
  assert.equal(matchForwarding('/api/account').binding, 'ACCOUNT');
});

test('认证入口：重置锁屏 status 始终可用（不暴露锁屏凭证是否配置）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/src/api/lock-reset.js');
  /* owner 未配置 */
  const kv = configuredKV({ lock: true });
  const env = baseEnv(kv);
  const st = postReq('https://test.example.com/api/lock-reset', { action: 'status' });
  const stRes = await onRequestPost({ request: st, env });
  const stBody = await stRes.json();
  assert.equal(stBody.ok, true);
  assert.equal(stBody.available, true, 'status 应始终返回可用');
});

test('认证入口（L1）：reset 终端不再有「重置不可用」，进 reset 不先调 status（恢复钥匙那一行直接出来）', () => {
  for (const f of ['reset.js', 'entry.js']) {
    const src = fs.readFileSync(path.join(REPO, 'space/web/assets/js/shell/space', f), 'utf8');
    assert.ok(!src.includes('重置锁屏不可用') && !src.includes('Reset is not available'), f);
  }
  const api = fs.readFileSync(path.join(REPO, 'space/web/assets/js/shell/space/api.js'), 'utf8');
  assert.ok(!/API\.reset, \{ action: 'status'/.test(api), '前端不调 lock-reset status');
});

/* ============ 5. 通行密钥命名 ============ */


/* ============ 7. 补充定稿七：锁屏入口按配置 ============ */

test('补充七：/api/lock-entry 四种配置返回正确', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/src/api/lock-entry.js');
  const get = (url, env) => new Request(url, { method: 'GET' });

  /* 都没设置 */
  let kv = makeKV({});
  let res = await onRequestGet({ request: get('https://test.example.com/api/lock-entry'), env: baseEnv(kv) });
  let j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.passkey, false, '无凭据时 passkey 应为 false');
  assert.equal(j.password, false, '无凭据时 password 应为 false');

  /* 仅密码 */
  kv = makeKV({ 'lock-password': JSON.stringify({ hash: 'h', salt: 's' }) });
  res = await onRequestGet({ request: get('https://test.example.com/api/lock-entry'), env: baseEnv(kv) });
  j = await res.json();
  assert.equal(j.passkey, false);
  assert.equal(j.password, true);

  /* 仅通行密钥 */
  kv = makeKV({
    'lock-passkey-index': JSON.stringify(['cid1']),
    'lock-passkey:cid1': JSON.stringify({ credId: 'cid1' }),
  });
  res = await onRequestGet({ request: get('https://test.example.com/api/lock-entry'), env: baseEnv(kv) });
  j = await res.json();
  assert.equal(j.passkey, true);
  assert.equal(j.password, false);

  /* 两者都有 */
  kv = makeKV({
    'lock-password': JSON.stringify({ hash: 'h', salt: 's' }),
    'lock-passkey-index': JSON.stringify(['cid1']),
    'lock-passkey:cid1': JSON.stringify({ credId: 'cid1' }),
  });
  res = await onRequestGet({ request: get('https://test.example.com/api/lock-entry'), env: baseEnv(kv) });
  j = await res.json();
  assert.equal(j.passkey, true);
  assert.equal(j.password, true);

  /* 非 lock 类凭据不应算作锁屏通行密钥 */
  kv = makeKV({
    'account-passkey-index': JSON.stringify(['cid9']),
    'account-passkey:cid9': JSON.stringify({ credId: 'cid9' }),
  });
  res = await onRequestGet({ request: get('https://test.example.com/api/lock-entry'), env: baseEnv(kv) });
  j = await res.json();
  /* 账号通行密钥不算锁屏凭证（账号拆分 PR3：网关不读账号的行，也不再有 resetOnly / accountConfigured） */
  assert.deepEqual(j, { ok: true, passkey: false, password: false }, '账号通行密钥不应算锁屏通行密钥');
});

test('补充七：/api/lock-entry 读取失败按已配置处理（不暴露进站凭证入口）', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/src/api/lock-entry.js');
  const kv = makeKV();
  authD1For(kv).failOn = () => true; /* D1 全挂 */
  const res = await onRequestGet({
    request: new Request('https://test.example.com/api/lock-entry', { method: 'GET' }),
    env: baseEnv(kv),
  });
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.passkey, true, '读取失败 passkey 应按已配置处理');
  assert.equal(j.password, true, '读取失败 password 应按已配置处理');
  assert.equal('resetOnly' in j, false, '不再返回 resetOnly');
  /* 只有凭证表读失败（纪元等正常）同样按已配置 */
  const kv2 = makeKV();
  authD1For(kv2).failOn = (sql) => /FROM (password|passkey)\b/.test(sql);
  const j2 = await (await onRequestGet({ request: new Request('https://test.example.com/api/lock-entry', { method: 'GET' }), env: baseEnv(kv2) })).json();
  assert.equal(j2.passkey, true);
  assert.equal(j2.password, true);
  /* 没绑 D1：同样按已配置 */
  const env3 = baseEnv(makeKV());
  delete env3.D1_LOCK_AUTH;
  const j3 = await (await onRequestGet({ request: new Request('https://test.example.com/api/lock-entry', { method: 'GET' }), env: env3 })).json();
  assert.equal(j3.passkey, true);
  assert.equal(j3.password, true);
});

/* 复审 §2：lock-entry 和 space-auth 必须用同一个口径判断「锁屏已配置」，否则 lock-entry 显示进站凭证入口、
   space-auth 却判已配置 → 假入口 401，直接锁死。D1 之后口径只有一个：D1 里的真实凭证（KV 标记不再存在，
   导入脚本也不导）。没有真实凭证时两边一致：lock-entry 显示进站凭证入口，space-auth lock-reset 走真路径能签票；
   有真实凭证时两边一致：不显示入口，space-auth 无会话 → 假入口 401。 */
test('行为：/api/lock-entry 与 space-auth 对「锁屏已配置」口径一致（不会显示入口却被假入口锁死）', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/src/api/lock-entry.js');
  const { onRequestPost: spaceAuth } = await import(REPO + '/workers/auth-gateway/src/api/space-auth.js');
  const entry = async (kv) => (await onRequestGet({ request: new Request('https://test.example.com/api/lock-entry', { method: 'GET' }), env: baseEnv(kv) })).json();
  /* 无真实凭证（旧 KV 标记只在 KV 里，不算）→ 显示进站凭证入口，且 space-auth 真路径可用 */
  const kv = makeKV({ 'lock-configured': '1' });
  const j = await entry(kv);
  assert.equal(j.ok, true);
  assert.equal(j.passkey, false);
  assert.equal(j.password, false);
  const r = await spaceAuth({ request: postReq('https://test.example.com/api/space-auth', { key: 'test-root-key-12345', purpose: 'lock-reset' }), env: baseEnv(kv) });
  assert.equal(r.status, 200, '显示了进站凭证入口，space-auth 就必须走真路径');
  /* 有真实锁屏凭证 → 不显示进站凭证入口；space-auth 无会话走假入口 */
  const kv2 = configuredKV({ lock: true });
  const j2 = await entry(kv2);
  assert.equal(j2.password, true);
  const r2 = await spaceAuth({ request: postReq('https://test.example.com/api/space-auth', { key: 'test-root-key-12345', purpose: 'lock-reset' }), env: baseEnv(kv2) });
  assert.equal(r2.status, 401);
  assert.deepEqual(await r2.json(), { ok: false, error: 'auth' });
});

test('补充七：进门会话缺 purpose → 400 purpose，不比对、不写存储', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/src/api/space-auth.js');
  const kv = configuredKV({ lock: true });
  const env = baseEnv(kv);
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'tempkey');
  for (const key of ['whatever', '', 'test-root-key-12345']) {
    const req = postReq('https://test.example.com/api/space-auth', { key }, { 'Cookie': 'sgx-lock-session=' + sessCv });
    const res = await onRequestPost({ request: req, env });
    assert.equal(res.status, 400, JSON.stringify(key));
    assert.equal(await res.text(), JSON.stringify({ ok: false, error: 'purpose' }));
  }
  const db = authD1For(kv);
  assert.deepEqual(d1Writes(db), [], '缺 purpose 不应写 D1');
  assert.deepEqual(spaceRows(db).attempts, [], '不应有 space-limit 计数');
});

/* ============ 审查意见 9 项：行为测试 ============ */

test('行为（L1）：lockreset 锁屏凭证未配置也一样——恢复钥匙对就签 reset 票（启动站不再走 space-auth lock-reset）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/src/api/lock-reset.js');
  const kv = makeKV({});
  const env = baseEnv(kv);
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', spaceKey: 'test-root-key-12345',
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(await res.text()), { ok: true });
  assert.match(res.headers.get('Set-Cookie') || '', /sgx-lock-reset=space\./);
});
test('行为：lockreset 记失败计数写 D1 出错 → 503', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/src/api/lock-reset.js');
  /* attempt_limit 的 UPSERT 抛错 */
  const kv = makeKV({});
  authD1For(kv).failOn = (sql) => /^\s*INSERT INTO attempt_limit/i.test(sql);
  const env = baseEnv(kv);
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', spaceKey: 'wrong-key',
  });
  const res = await onRequestPost({ request: req, env });
  /* 进站凭证错误 → 记失败计数 → D1 写抛错 → 503（fail closed） */
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, error: 'server' });
});

test('行为（v3 L1）：进门会话（含临时钥匙进门）下 space-auth lock-reauth → 400 purpose，正确恢复钥匙也不签 LockReauthTicket（reauth 只认解锁密码 / 通行密钥）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/src/api/space-auth.js');
  for (const by of ['tempkey', 'password']) {
    const kv = configuredKV({ lock: true });
    const sessCv = await testLockSession(TEST_PRIV_PEM, 0, by);
    const req = postReq('https://test.example.com/api/space-auth', { key: 'test-root-key-12345', purpose: 'lock-reauth' }, { 'Cookie': 'sgx-lock-session=' + sessCv });
    const res = await onRequestPost({ request: req, env: baseEnv(kv) });
    assert.equal(res.status, 400, by);
    assert.deepEqual(await res.json(), { ok: false, error: 'purpose' });
    assert.ok(!setCk(res).some((c) => c.startsWith('sgx-lock-reauth=')), by + '：不签 reauth 票');
    assert.deepEqual(spaceRows(authD1For(kv)).audits, [], by + '：不写审计');
  }
});

test('行为：锁屏未配置 + 临时钥匙 cookie：lock-reset 走真路径（by=space）；lock-reauth → 400 purpose', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/src/api/space-auth.js');
  const env = baseEnv(makeKV({}));
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'tempkey');
  const ok = await onRequestPost({ request: postReq('https://test.example.com/api/space-auth', { key: 'test-root-key-12345', purpose: 'lock-reset' }, { 'Cookie': 'sgx-lock-session=' + sessCv }), env });
  assert.equal(ok.status, 200);
  assert.ok(setCk(ok).some((c) => c.startsWith('sgx-lock-reset=space.')), 'lock-reset：by=space');
  const no = await onRequestPost({ request: postReq('https://test.example.com/api/space-auth', { key: 'test-root-key-12345', purpose: 'lock-reauth' }, { 'Cookie': 'sgx-lock-session=' + sessCv }), env });
  assert.equal(no.status, 400);
  assert.ok(!setCk(no).some((c) => c.startsWith('sgx-lock-reauth=')), 'lock-reauth：不签票');
});

/* ============ 复审 §1：lockreset 票据页注入 lockreset 状态 ============ */

test('行为：injectSessionState 注入 lockreset 状态（瘦身 + noindex，与 locked 一致）', async () => {
  const { injectSessionState } = await import(REPO + '/workers/auth-gateway/src/gate.js');
  const html = '<html><head></head><body><!-- SGX-DESKTOP-START --><div>desktop</div><!-- SGX-DESKTOP-END --><p>lock page</p></body></html>';
  const res = new Response(html, { headers: { 'Content-Type': 'text/html' } });
  const out = await injectSessionState(res, 'lock-reset', null);
  const text = await out.text();
  assert.ok(text.includes('data-sgx-lock-session="lock-reset"'), '应注入 lockreset 状态');
  assert.ok(!text.includes('desktop'), 'lockreset 页应瘦身（不下发桌面内容）');
  assert.equal(out.headers.get('X-Robots-Tag'), 'noindex', 'lockreset 页不应被收录');
});

test('行为：injectSessionState locked 状态保持不变', async () => {
  const { injectSessionState } = await import(REPO + '/workers/auth-gateway/src/gate.js');
  const html = '<html><head></head><body><p>home</p></body></html>';
  const res = new Response(html, { headers: { 'Content-Type': 'text/html' } });
  const out = await injectSessionState(res, 'locked', null);
  const text = await out.text();
  assert.ok(text.includes('data-sgx-lock-session="locked"'), '应注入 locked 状态');
});

/* ============ /api/lock-credentials：只读锁屏凭证状态 ============
   背景：security-lock.js refreshStatus 曾用 /api/owner-status 显示锁屏密码
   「已设置/未设置」和删除按钮，但 owner-status 读的是 account-password +
   class=owner 通行密钥（且要求 进门会话），导致：
   - 只设了账号密码 → 锁屏页误显示「已设置」
   - 只设了锁屏密码 → 误显示「未设置」且没有删除按钮
   - lockreset 页无会话 → owner-status 返回 401
   本接口读 lock-password + class=lock，进门会话或 keys/lockreset 票据可读。 */

function getReq(url, headers) {
  return new Request(url, { method: 'GET', headers: headers || {} });
}

test('行为：/api/lock-credentials 无鉴权 → 401', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/src/api/lock-credentials.js');
  const kv = makeKV({});
  const env = baseEnv(kv);
  const res = await onRequestGet({ request: getReq('https://test.example.com/api/lock-credentials'), env });
  assert.equal(res.status, 401, '无会话无票据应 401');
});

test('行为：/api/lock-credentials 临时钥匙进门的会话 → 200（进门即可，只读两个布尔）', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/src/api/lock-credentials.js');
  const kv = makeKV({});
  const env = baseEnv(kv);
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'tempkey');
  const res = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-credentials', { 'Cookie': 'sgx-lock-session=' + sessCv }),
    env,
  });
  assert.equal(res.status, 200, '进门会话应 200');
  const j = await res.json();
  assert.equal(j.ok, true);
});

test('行为：只有账号密码时 /api/lock-credentials 返回 password:false（锁屏页显示「未设置」正确）', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/src/api/lock-credentials.js');
  const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/src/core/lock-session.js');
  /* 只有 account-password，无 lock-password，无通行密钥 */
  const kv = makeKV({
    'account-password': JSON.stringify({ hash: 'owner-hash' }),
  });
  const env = baseEnv(kv);
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'password');
  const res = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-credentials', { 'Cookie': 'sgx-lock-session=' + sessCv }),
    env,
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(await res.text());
  assert.equal(body.ok, true);
  assert.equal(body.password, false, '只有账号密码时锁屏密码应为 false（旧接口误报 true）');
  assert.equal(body.passkey, false);
});

test('行为：只有锁屏密码时 /api/lock-credentials 返回 password:true（锁屏页显示「已设置」正确）', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/src/api/lock-credentials.js');
  const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/src/core/lock-session.js');
  /* 只有 lock-password，无 account-password，无通行密钥 */
  const kv = makeKV({
    'lock-password': JSON.stringify({ hash: 'lock-hash' }),
  });
  const env = baseEnv(kv);
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'password');
  const res = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-credentials', { 'Cookie': 'sgx-lock-session=' + sessCv }),
    env,
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(await res.text());
  assert.equal(body.ok, true);
  assert.equal(body.password, true, '只有锁屏密码时应为 true（旧接口误报 false）');
  assert.equal(body.passkey, false);
});

test('行为：/api/lock-credentials 只看 class=lock 通行密钥', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/src/api/lock-credentials.js');
  const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/src/core/lock-session.js');
  /* 只有 owner 类通行密钥 */
  const kv1 = makeKV({
    'account-passkey-index': JSON.stringify(['o1']),
    'account-passkey:o1': JSON.stringify({ credId: 'o1', publicKey: 'x' }),
  });
  const env1 = baseEnv(kv1);
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'password');
  const res1 = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-credentials', { 'Cookie': 'sgx-lock-session=' + sessCv }),
    env: env1,
  });
  const body1 = JSON.parse(await res1.text());
  assert.equal(body1.passkey, false, '只有 owner 类时 passkey 应为 false');
  /* 加上 lock 类通行密钥 */
  const kv2 = makeKV({
    'lock-passkey-index': JSON.stringify(['l1']),
    'account-passkey-index': JSON.stringify(['o1']),
    'account-passkey:o1': JSON.stringify({ credId: 'o1', publicKey: 'x' }),
    'lock-passkey:l1': JSON.stringify({ credId: 'l1', publicKey: 'y' }),
  });
  const env2 = baseEnv(kv2);
  const res2 = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-credentials', { 'Cookie': 'sgx-lock-session=' + sessCv }),
    env: env2,
  });
  const body2 = JSON.parse(await res2.text());
  assert.equal(body2.passkey, true, '有 lock 类时 passkey 应为 true');
});




test('行为：/api/lock-credentials 读锁屏密码失败（D1）→ 503（fail closed，不按未设置退回）', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/src/api/lock-credentials.js');
  const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/src/core/lock-session.js');
  const kv = makeKV();
  /* 会话校验的纪元读取正常，只有密码表的读取失败 */
  authD1For(kv).failOn = (sql) => /FROM password/.test(sql);
  const env = baseEnv(kv);
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'password');
  const res = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-credentials', { 'Cookie': 'sgx-lock-session=' + sessCv }),
    env,
  });
  assert.equal(res.status, 503, '读失败应 503');
});

test('行为：/api/lock-credentials 未绑 D1_LOCK_AUTH → 500', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/src/api/lock-credentials.js');
  const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/src/core/lock-session.js');
  const env = baseEnv(makeKV({}));
  delete env.D1_LOCK_AUTH;
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'password');
  const res = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-credentials', { 'Cookie': 'sgx-lock-session=' + sessCv }),
    env,
  });
  assert.equal(res.status, 500, '未绑 D1 应 500 config');
});
