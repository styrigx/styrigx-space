/* 语言清理（2026-11-07）：锁屏通行密钥的 D1 记录不存显示文案。
   provider 存密码管理器 id，没起名 name 存空；旧库里的中文显示名读时归一（不迁移），前端按页面语言渲染。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providerOf, normalizeProvider, normalizePasskeyName } from '../../../workers/space-core/src/core/passkey-store.js';
import * as acct from '../../../workers/account/src/core/passkey.js';

const CJK = /[\u3400-\u9fff\uff00-\uffef]/;

test('providerOf → 中性 id（不含任何语言的显示文案）', () => {
  assert.equal(providerOf('EA9B8D66-4D01-1D21-3CE4-B6B48CB575D4'), 'google-password-manager');
  assert.equal(providerOf('53414d53-554e-4700-0000-000000000000'), 'samsung-pass');
  assert.equal(providerOf('00000000-0000-0000-0000-000000000000'), '');
  for (const g of ['ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4', 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd', 'dd4ec289-e01d-41c9-bb89-70fa845d4bf2', 'd3452668-01fd-4c12-926c-83a4204853aa']) {
    assert.match(providerOf(g), /^[a-z0-9-]+$/);
  }
});

test('旧库兼容：中文 provider 显示名 → id；旧默认名 → 空；用户自起的名字原样', () => {
  assert.equal(normalizeProvider('Google 密码管理器'), 'google-password-manager');
  assert.equal(normalizeProvider('iCloud 钥匙串'), 'icloud-keychain');
  assert.equal(normalizeProvider('apple-passwords'), 'apple-passwords');
  assert.equal(normalizeProvider('随便什么'), '');
  assert.equal(normalizePasskeyName('通行密钥'), '');
  assert.equal(normalizePasskeyName('Microsoft 密码管理器'), '');
  assert.equal(normalizePasskeyName(''), '');
  assert.equal(normalizePasskeyName('我的手机'), '我的手机', '个人信息类：原样');
});

test('网关与账号 Worker 两份 AAGUID 映射同值（各自一份，不互相 import）；账号那边旧显示名已由 0005 迁移改好，代码不再归一', () => {
  for (const g of ['53414d53-554e-4700-0000-000000000000', 'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4', 'bada5566-a7aa-401f-bd96-45619a55120d']) {
    assert.equal(acct.providerOf(g), providerOf(g));
  }
  assert.equal(acct.normalizePasskeyName, undefined);
  assert.equal(acct.providerId('samsung-pass'), 'samsung-pass');
  assert.equal(acct.providerId('Samsung Pass'), '');
});

test('源码：注册 / 存储不再写中文默认名', () => {
  for (const f of ['workers/space-core/src/api/lock-passkey.js', 'workers/space-core/src/core/passkey-store.js']) {
    const src = readFileSync(new URL('../../../' + f, import.meta.url), 'utf8');
    assert.ok(!/name:\s*[^\n]*'通行密钥'/.test(src), f);
    const i = src.indexOf('const AAGUID_PROVIDERS');
    if (i >= 0) assert.ok(!CJK.test(src.slice(i, src.indexOf('};', i))), f + '：AAGUID 映射只存 id');
  }
});
