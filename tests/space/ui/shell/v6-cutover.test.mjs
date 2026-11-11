/**
 * 割接（v6 cutover）前端：访客入口改成 su（定稿 §七），su 的密码提示同 Linux su。
 * - 访客头像点了预填「su 」（不再是死按钮）；盾牌、上锁的地方（sgx:sudo）、旧锁屏地址 ?entry=1 / #sec 同一行 GUEST_LINE；
 *   ?entry=sudo 照旧直接跑旧的 sudo styrigx（旧入口 P4 删）；v6 已登录点盾牌不预填 su
 * - su root / su <用户> 的提示是「Password:」；sudo 才是「[sudo] password for <自己>:」
 * - 访客入口文案：旷野锁卡按钮 su、lockedHint、AI 窗口锁着的提示
 * 运行：node --test tests/space/ui/shell/v6-cutover.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const rd = (p) => readFileSync(path.join(REPO, p), 'utf8');
const yaml = (p) => rd(p);

test('访客入口预填 GUEST_LINE = 「su 」；所有 prefill 都用它；v6 P4：SUDO_LINE（?entry=sudo 直接跑 sudo styrigx）删了', () => {
  const js = rd('space/web/assets/js/shell/topbar-panel.js');
  assert.match(js, /export const GUEST_LINE = 'su ';/);
  const prefills = [...js.matchAll(/view\.prefill\(([A-Z_]+)\)/g)].map((m) => m[1]);
  assert.ok(prefills.length >= 4, String(prefills));
  assert.deepEqual([...new Set(prefills)], ['GUEST_LINE']);
  assert.equal([...js.matchAll(/\bSUDO_LINE\b/g)].length, 0, 'SUDO_LINE 删了');
  assert.match(js, /showTerm\(function \(\) \{ view\.prefill\(GUEST_LINE\); \}\);/, '?entry=… 一律预填 su ');
});

test('头像 = whoami（定稿 §七 58–61）：访客 → su ；已登录（普通用户 / root）→ 账号卡片（不预填）；访客头像不再 aria-disabled', () => {
  const js = rd('space/web/assets/js/shell/topbar-panel.js');
  assert.match(js, /if \(!u\) return avGuest\(\) \? GUEST_LINE : '';\s*return '';/);
  assert.doesNotMatch(js, /setAttribute\('aria-disabled', 'true'\)/);
  /* 盾牌：v6 已登录（u:<名>）不预填 su （要换人先 exit） */
  assert.match(js, /if \(!view\.input\.value && x\.indexOf\('u:'\) !== 0\) view\.prefill\(GUEST_LINE\);/);
});

test('su 的密码提示 = 「Password:」（su root 也是，输的是 root 的凭据）；sudo = 「[sudo] password for <自己>:」', () => {
  const js = rd('space/web/assets/js/shell/identity/layer.js');
  const su = js.slice(js.indexOf('C.cmdSu = function'), js.indexOf('/* ---------- ', js.indexOf('C.cmdSu = function') + 10));
  assert.ok(su.length > 100);
  assert.doesNotMatch(su, /pwFor/, 'su 不再用 [sudo] password for');
  assert.equal([...su.matchAll(/proofOf\(t\('pwPrompt'\), 'su-challenge'/g)].length, 2, 'su root 与 su <用户>');
  assert.match(js, /proofOf\(t\('pwFor', \{ u: u\.name \}\), 'sudo-challenge'/, 'sudo 输自己的凭据');
  for (const l of ['en', 'zh']) {
    const y = yaml('space/web/data/sgx-shell-i18n/' + l + '.yaml');
    assert.match(y, /\n {2}pwPrompt: "Password:"\n/, l);
    assert.match(y, /\n {2}pwFor: "\[sudo\] password for \{u\}:"\n/, l);
  }
});

test('访客入口文案跟 su：旷野锁卡按钮、lockedHint、AI 窗口锁着的提示；不再写 sudo styrigx', () => {
  const wild = rd('space/web/layouts/_default/wild.html');
  assert.match(wild, /<button type="button" class="st-btn wild-cmdbtn" data-st="sudo" translate="no">su<\/button>/);
  assert.match(rd('space/web/data/i18n/en.yaml'), /\n {2}lockedHint: visible after su\n/);
  assert.match(rd('space/web/data/i18n/zh.yaml'), /\n {2}lockedHint: su 登录后可见\n/);
  const zh = yaml('space/web/data/sgx-shell-i18n/zh.yaml');
  const en = yaml('space/web/data/sgx-shell-i18n/en.yaml');
  assert.match(zh, /\n {2}unauthorized: 登录后才能问：su\n {2}locked: 已上锁，su 登录后可用\n/);
  assert.match(en, /\n {2}unauthorized: "Gray AI opens after you sign in: su"\n {2}locked: Locked\. Sign in with su to use Gray AI\n/);
  const ai = rd('space/web/assets/js/shell/ai-panel.js');
  assert.match(ai, /unauthorized: "Gray AI opens after you sign in: su",/);
  assert.doesNotMatch(ai.slice(ai.indexOf('unauthorized:'), ai.indexOf('cooldown:')), /sudo styrigx/);
});
