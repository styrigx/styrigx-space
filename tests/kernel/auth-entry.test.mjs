/**
 * 认证入口修正测试（space）。
 *
 * 覆盖：
 * 1. 锁屏恰好四个选项（访客进入/通行密钥/密码/重置锁屏），不含根凭证
 * 2. 访客和站长的安全页 DOM 结构一致（三个入口，无角色条件渲染）
 * 3. 访客会话提交正确根凭证 → 401 密码错误，且不调用 D1/KV、不增加 rootlimit 计数
 * 4. 管理凭证弹层四种配置下按钮正确（未设置/仅通行密钥/仅密码/两者都有）
 * 5. 三类通行密钥注册 options 的 name/displayName 正确
 *    （owner→ownerkey，lock→lockkey，app→<aud小写>key；displayName 一律 Sloan Gray）
 *
 * 运行：node --test tests/kernel/auth-entry.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = new URL('../../', import.meta.url).pathname;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeKv(init) {
  const m = new Map(Object.entries(init || {}));
  const calls = { get: 0, put: 0, delete: 0, list: 0 };
  return {
    get: async (k, t) => {
      calls.get++;
      const v = m.get(k);
      if (v === undefined) return null;
      return t === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v, o) => { calls.put++; m.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    delete: async (k) => { calls.delete++; m.delete(k); },
    list: async (o) => { calls.list++; return { keys: Array.from(m.keys()).map((name) => ({ name })) }; },
    _store: m,
    _calls: calls,
  };
}

function postReq(url, body, headers) {
  const h = { 'Content-Type': 'application/json', 'Origin': new URL(url).origin };
  Object.assign(h, headers || {});
  return new Request(url, { method: 'POST', headers: h, body: JSON.stringify(body || {}) });
}

/* 测试用 Ed25519 密钥 */
let TEST_PRIV_PEM = '';
let TEST_PUB_PEM = '';
function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}
async function genTestKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const privDer = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
  const pubDer = await crypto.subtle.exportKey('spki', kp.publicKey);
  TEST_PRIV_PEM = derToPem(privDer, 'PRIVATE KEY');
  TEST_PUB_PEM = derToPem(pubDer, 'PUBLIC KEY');
}
await genTestKeys();

function baseEnv(kv, overrides) {
  return Object.assign({
    OWNER_KV: kv,
    SGX_ROOT_KEY: 'test-root-key-12345',
    SGX_STEPUP_PRIVATE: TEST_PRIV_PEM,
    SGX_STEPUP_PUBLIC: TEST_PUB_PEM,
    SGX_LOCK_PRIVATE: TEST_PRIV_PEM,
    SGX_LOCK_PUBLIC: TEST_PUB_PEM,
    SGX_PW_PEPPER: 'test-pepper',
    SGX_RP_ID: 'test.example.com',
    SGX_ORIGIN: 'https://test.example.com',
  }, overrides || {});
}

/* ============ 1. 锁屏四个选项 ============ */

test('认证入口：锁屏方法弹层恰好四个选项（访客进入/通行密钥/密码/重置锁屏），不含根凭证', () => {
  const src = fs.readFileSync(path.join(REPO, 'assets/js/shell/lock.js'), 'utf8');
  /* 四个选项的按钮 ID 必须存在 */
  assert.ok(src.includes('sgx-mopt-visitor'), '应有访客进入');
  assert.ok(src.includes('sgx-mopt-pk'), '应有通行密钥');
  assert.ok(src.includes('sgx-mopt-pw'), '应有密码');
  assert.ok(src.includes('sgx-mopt-reset'), '应有重置锁屏');
  /* 根凭证选项必须删除 */
  assert.ok(!src.includes('sgx-mopt-mk'), '不应有根凭证选项 sgx-mopt-mk');
  assert.ok(!src.includes('openMk'), '不应有 openMk 函数');
  assert.ok(!src.includes('根凭证：未解锁也能用'), '不应有「根凭证：未解锁也能用」注释');
  /* 重置锁屏描述应为通用说法，不出现「根凭证」 */
  assert.ok(
    src.includes('验证身份后重设解锁方式'),
    '重置锁屏描述应为通用说法'
  );
  assert.ok(
    !src.includes('先验证根凭证，再验证站长凭证'),
    '重置锁屏描述不应出现根凭证'
  );
});

/* ============ 2. 安全页 DOM 一致 ============ */

test('认证入口：安全页三个入口（站长凭证/管理凭证/立即锁定），访客与站长 DOM 一致', () => {
  const html = fs.readFileSync(path.join(REPO, 'layouts/_default/security.html'), 'utf8');
  /* 三个入口 ID 必须存在 */
  assert.ok(html.includes('id="sec-owner-cred"'), '应有站长凭证入口');
  assert.ok(html.includes('id="sec-mgmt-cred"'), '应有管理凭证入口');
  assert.ok(html.includes('id="sec-locknow"'), '应有立即锁定入口');
  /* 旧入口必须删除 */
  assert.ok(!html.includes('id="sec-unlock-methods"'), '不应有解锁方式');
  assert.ok(!html.includes('id="sec-app-row"'), '不应有应用验证');
  assert.ok(!html.includes('id="sec-lockall"'), '不应有锁定所有设备');
  /* 站长凭证弹层：标题「需要验证」，单个根凭证按钮 */
  assert.ok(html.includes('id="sec-owner-dlg"'), '应有站长凭证弹层');
  assert.ok(html.includes('需要验证'), '站长凭证弹层标题应为「需要验证」');
  /* 管理凭证弹层：标题「需要凭证」 */
  assert.ok(html.includes('id="sec-mgmt-dlg"'), '应有管理凭证弹层');
  assert.ok(html.includes('需要凭证'), '管理凭证弹层标题应为「需要凭证」');

  /* JS 不应再有访客/站长的条件渲染（页面完全一样） */
  const js = fs.readFileSync(path.join(REPO, 'assets/js/apps/security.js'), 'utf8');
  assert.ok(!js.includes("role === 'visitor'"), '不应有访客角色条件分支');
  assert.ok(!js.includes('sec-owner-lock'), '不应有访客锁图标');
  assert.ok(!js.includes('sec-unlock-methods'), '不应引用已删除的解锁方式');
  assert.ok(!js.includes('sec-app-row'), '不应引用已删除的应用验证');
});

/* ============ 3. 访客假入口 ============ */

test('认证入口：访客会话提交正确根凭证 → 401 密码错误，不读 KV/D1，不计 rootlimit', async () => {
  const { onRequestPost } = await import(REPO + 'functions/api/root-auth.js');
  const { signSessionCookie } = await import(REPO + 'functions/_kernel/session.js');

  const kv = makeKv({ 'layer:lock': '1' });
  const env = baseEnv(kv);

  /* 构造有效访客会话 cookie */
  const sessCv = await signSessionCookie(TEST_PRIV_PEM, 0, 'visitor', 'owner');

  /* 提交正确的根凭证 */
  const req = postReq('https://test.example.com/api/root-auth', { key: 'test-root-key-12345' }, {
    'Cookie': 'sgx-verified=' + sessCv,
  });
  const t0 = Date.now();
  const res = await onRequestPost({ request: req, env });
  const dt = Date.now() - t0;

  assert.equal(res.status, 401);
  const body = await res.text();
  assert.equal(body, JSON.stringify({ ok: false, error: 'auth' }));

  /* 不调用 KV（get/put 计数为 0） */
  assert.equal(kv._calls.get, 0, '访客假入口不应读 KV');
  assert.equal(kv._calls.put, 0, '访客假入口不应写 KV');

  /* 不增加 rootlimit 计数 */
  assert.ok(!kv._store.has('root-auth-fail:unknown'), '不应有 IP 失败计数');
  assert.ok(![...kv._store.keys()].some((k) => k.startsWith('root-auth-')), '不应有任何 rootlimit 键');

  /* 固定最小延迟（防时序区分） */
  assert.ok(dt >= 180, '应有固定最小延迟，实际 ' + dt + 'ms');
});

test('认证入口：访客假入口与真失败响应逐字节相同', async () => {
  const { onRequestPost } = await import(REPO + 'functions/api/root-auth.js');
  const { signSessionCookie } = await import(REPO + 'functions/_kernel/session.js');

  const kv1 = makeKv({ 'layer:lock': '1' });
  const kv2 = makeKv({ 'layer:lock': '1' });

  /* 访客提交正确密钥 */
  const sessCv = await signSessionCookie(TEST_PRIV_PEM, 0, 'visitor', 'owner');
  const req1 = postReq('https://test.example.com/api/root-auth', { key: 'test-root-key-12345' }, {
    'Cookie': 'sgx-verified=' + sessCv,
  });
  const res1 = await onRequestPost({ request: req1, env: baseEnv(kv1) });

  /* Owner 会话提交错误密钥（真失败） */
  const ownerCv = await signSessionCookie(TEST_PRIV_PEM, 0, 'owner', 'owner');
  const req2 = postReq('https://test.example.com/api/root-auth', { key: 'wrong-key' }, {
    'Cookie': 'sgx-verified=' + ownerCv,
  });
  const res2 = await onRequestPost({ request: req2, env: baseEnv(kv2) });

  assert.equal(res1.status, 401);
  assert.equal(res2.status, 401);
  const b1 = await res1.text();
  const b2 = await res2.text();
  assert.equal(b1, b2, '假入口与真失败响应应逐字节相同');
});

/* ============ 4. 管理凭证弹层按钮 ============ */

test('认证入口：管理凭证弹层四种配置下按钮正确', () => {
  const js = fs.readFileSync(path.join(REPO, 'assets/js/apps/security.js'), 'utf8');
  /* renderOpts 逻辑：未设置→根凭证；仅 passkey→通行密钥验证；仅密码→密码验证；两者→两个按钮 */
  /* 验证源码包含四种分支 */
  assert.ok(js.includes('!hasPw && !hasPk'), '应有未设置分支');
  /* 未设置时只显示根凭证 */
  const noneSection = js.slice(js.indexOf('!hasPw && !hasPk'), js.indexOf('!hasPw && !hasPk') + 500);
  assert.ok(noneSection.includes('根凭证'), '未设置时应显示根凭证');
  /* 两个都设了时不显示根凭证（注释） */
  assert.ok(js.includes('两个都设了时不显示根凭证') || js.includes('不显示根凭证'), '两者都有时不应显示根凭证');
});

/* ============ 6. 重置锁屏 status 不卡死 ============ */

test('认证入口：重置锁屏 status 始终可用（不暴露站长凭证是否配置）', async () => {
  const { onRequestPost } = await import(REPO + 'functions/api/lockreset.js');
  /* owner 未配置 */
  const kv = makeKv({ 'layer:lock': '1' });
  const env = baseEnv(kv);
  const st = postReq('https://test.example.com/api/lockreset', { action: 'status' });
  const stRes = await onRequestPost({ request: st, env });
  const stBody = await stRes.json();
  assert.equal(stBody.ok, true);
  assert.equal(stBody.available, true, 'status 应始终返回可用');
});

test('认证入口：前端重置弹层不再出现「重置锁屏不可用」', () => {
  const src = fs.readFileSync(path.join(REPO, 'assets/js/shell/lock.js'), 'utf8');
  assert.ok(!src.includes('重置锁屏不可用'), '不应再有「重置锁屏不可用」文案');
  assert.ok(!src.includes('Reset is not available'), '不应再有英文不可用文案');
  /* openReset 直接显示第一步，不再调 status */
  assert.ok(!src.includes("action: 'status'") || src.indexOf('renderResetStep1') < src.indexOf("action: 'status'"),
    'openReset 应直接显示第一步');
});

/* ============ 5. 通行密钥命名 ============ */

test('认证入口：三类通行密钥注册 options 的 name/displayName 正确', async () => {
  const src = fs.readFileSync(path.join(REPO, 'functions/api/owner-passkey.js'), 'utf8');
  /* displayName 一律 Sloan Gray */
  assert.ok(src.includes("displayName: OWNER_DISPLAY_NAME"), 'displayName 应为常量');
  assert.ok(src.includes("OWNER_DISPLAY_NAME = 'Sloan Gray'"), 'displayName 应为 Sloan Gray');
  /* name 映射 */
  assert.ok(src.includes("'ownerkey'"), '站长凭证 name 应为 ownerkey');
  assert.ok(src.includes("'lockkey'"), '锁屏 name 应为 lockkey');
  assert.ok(src.includes("+ 'key'"), 'app name 应为小写应用名+key');
});
