/**
 * 割接 2f 补测：v6 passkey ls 的行格式（Gray 11-11 16:18 / 16:2x：设备名一段先保留，行格式维持线上现状，待 Gray 定）——
 * `[n] <名字> · <密码管理器> · 创建 MM-DD · 上次使用 MM-DD`；provider 为空 → 不出那一段；没用过 → 「未使用」。
 * 字段来自服务端 passkey-list（workers/account/src/core/passkey.js passkeyView：name / provider / createdAt / lastUsedAt，经 identity-passkey.js v6PasskeyViews 带 n）；
 * 文案用账号层已有的键 account.keys.passkey.created / lastUsed / neverUsed / provider.*（sgx-shell-i18n zh / en），日期用 cmd/keys.js mmdd。
 * 运行：node --test tests/space/ui/shell/v6-passkey-ls-row.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { mountV6Direct } from '../../../../space/web/assets/js/shell/account/cmd/v6-direct.js';
import { mountKeys, mmdd } from '../../../../space/web/assets/js/shell/account/cmd/keys.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const acct = (lang) => yaml.load(readFileSync(path.join(REPO, 'space/web/data/sgx-shell-i18n/' + lang + '.yaml'), 'utf8')).account;
const settle = () => new Promise((r) => setTimeout(r, 0));
const strip = (s) => s.replace(/<[^>]+>/g, '');

function ctx(lang, keys) {
  const S = acct(lang);
  const t = (k) => k.split('.').reduce((o, p) => (o && typeof o === 'object' ? o[p] : undefined), S) || k;
  const tf = (k, m) => t(k).replace(/\{(\w+)\}/g, (_, x) => (m && x in m ? m[x] : _));
  const out = [];
  const sent = [];
  const C = {
    t, tf, esc: (s) => String(s), inReset: false, reauthExp: 0, status: { configured: { passkey: false } }, k: (x) => x,
    api: {
      v6keys: { passkeyList: () => { sent.push('v6.passkeyList'); return Promise.resolve({ s: 200, j: { ok: true, keys } }); } },
      keys: { passkeyList: () => { sent.push('old.passkeyList'); return Promise.resolve({ s: 200, j: { ok: true, keys } }); } }, reset: {},
      isErr: () => false, ERR: {}, errText: () => 'x',
    },
    out: (s) => out.push(strip(s)), err() {}, ok() {}, note: (k) => out.push('note:' + k),
    setMode() {}, toCmd() {}, apiErr() {}, netErr() {}, echo() {}, echoPick() {}, ask() {}, pick() {}, reauthLeft: () => 0, afterResetChange() {},
    withReauth() { out.push('withReauth'); }, authErr: () => true,
  };
  mountV6Direct(C, null);
  mountKeys(C);
  return { C, out, sent };
}

const T1 = new Date(2026, 10, 10, 12).getTime();
const T2 = new Date(2026, 10, 11, 9).getTime();
const KEYS = [
  { n: 1, credId: 'A', name: 'Samsung Galaxy S23U', provider: 'samsung-pass', createdAt: T1, lastUsedAt: T2 },
  { n: 2, credId: 'B', name: 'Pixel', provider: '', createdAt: T1, lastUsedAt: 0 },
];

test('mmdd：MM-DD（本地时区）', () => {
  assert.equal(mmdd(T1), '11-10');
  assert.equal(mmdd(0), '');
});

test('v6 passkey ls（中文）：[n] 名字 · 密码管理器 · 创建 MM-DD · 上次使用 MM-DD；provider 空不出那段；没用过 = 未使用', async () => {
  const a = ctx('zh', KEYS);
  a.C.passkeyList({ direct: true });
  await settle();
  assert.deepEqual(a.sent, ['v6.passkeyList']);
  assert.deepEqual(a.out, [
    '[1] Samsung Galaxy S23U · Samsung Pass · 创建 11-10 · 上次使用 11-11',
    '[2] Pixel · 创建 11-10 · 未使用',
  ]);
});

test('v6 passkey ls（英文）：同一格式，用 en 的已有键', async () => {
  const a = ctx('en', KEYS);
  a.C.passkeyList({ direct: true });
  await settle();
  assert.deepEqual(a.out, [
    '[1] Samsung Galaxy S23U · Samsung Pass · created 11-10 · last used 11-11',
    '[2] Pixel · created 11-10 · not used yet',
  ]);
});

test('v6 passkey ls：没有通行密钥 → keys.passkey.none 一行', async () => {
  const a = ctx('zh', []);
  a.C.passkeyList({ direct: true });
  await settle();
  assert.deepEqual(a.out, ['note:keys.passkey.none']);
});
