/**
 * 割接（v6 cutover）前端：访客入口改成 su（定稿 §七），su 的密码提示同 Linux su。
 * - 访客头像点了预填「su 」（不再是死按钮）；盾牌、上锁的地方（sgx:sudo）、旧锁屏地址 ?entry=1 / #sec 同一行 GUEST_LINE；
 *   ?entry=sudo 照旧直接跑旧的 sudo styrigx（旧入口 P4 删）；v6 已登录点盾牌不预填 su
 * - su root / su <用户> 的提示是「Password:」；sudo 才是「[sudo] password for <自己>:」
 * - 访客入口文案：状态页锁卡按钮 su、lockedHint、AI 窗口锁着的提示
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
  const js = rd('space/web/assets/shell/js/shell/topbar-panel.js');
  assert.match(js, /export const GUEST_LINE = 'su ';/);
  const prefills = [...js.matchAll(/view\.prefill\(([A-Z_]+)\)/g)].map((m) => m[1]);
  assert.ok(prefills.length >= 3, String(prefills));
  /* P4-3：盾牌徽章按身份预填（shieldCmd：访客 GUEST_LINE、站长 su root、普通用户 / root exit；定稿 v5.5 §七） */
  assert.match(js, /if \(t === 'webmaster'\) return 'su root';\s*if \(t === 'user' \|\| t === 'root'\) return 'exit';\s*return t === 'guest' \|\| !who \|\| who\.get\(\) === 'nobody' \? GUEST_LINE : '';/);
  assert.deepEqual([...new Set(prefills)], ['GUEST_LINE']);
  assert.equal([...js.matchAll(/\bSUDO_LINE\b/g)].length, 0, 'SUDO_LINE 删了');
  assert.match(js, /showTerm\(function \(\) \{ view\.prefill\(GUEST_LINE\); \}\);/, '?entry=… 一律预填 su ');
});

test('头像 = whoami（定稿 v5.5 §七）：访客 → su ；站长 / root → 账号页（不预填）；访客头像不 aria-disabled，普通用户头像 aria-disabled（只作装饰）', () => {
  const js = rd('space/web/assets/shell/js/shell/topbar-panel.js');
  assert.match(js, /if \(!u\) return avGuest\(\) \? GUEST_LINE : '';\s*return '';/);
  assert.match(js, /if \(avDecor\(\)\) acctBtn\.setAttribute\('aria-disabled', 'true'\);\s*else acctBtn\.removeAttribute\('aria-disabled'\);/);
  assert.match(js, /if \(avDecor\(\)\) \{ e\.preventDefault\(\); e\.stopImmediatePropagation\(\); return; \}/);
  /* 盾牌：按徽章档预填，输入行有字不覆盖 */
  assert.match(js, /const c = shieldCmd\(tierOf\(\)\);\s*if \(c && !view\.input\.value\) view\.prefill\(c\);/);
});

test('su 的密码提示 = 「Password:」（su root 也是，输的是 root 的凭据）；sudo = 「[sudo] password for <自己>:」', () => {
  const js = rd('space/web/assets/shell/js/shell/identity/layer.js');
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

test('访客入口文案跟 su：状态页锁卡按钮、lockedHint、AI 窗口锁着的提示；不再写 sudo styrigx', () => {
  const st = rd('space/web/layouts/_default/status.html');
  assert.match(st, /<button type="button" class="st-btn trm-cmdbtn" data-st="sudo" translate="no">su<\/button>/);
  assert.match(rd('space/web/data/i18n/en.yaml'), /\n {2}lockedHint: visible after su\n/);
  assert.match(rd('space/web/data/i18n/zh.yaml'), /\n {2}lockedHint: su 登录后可见\n/);
  const zh = yaml('space/web/data/sgx-shell-i18n/zh.yaml');
  const en = yaml('space/web/data/sgx-shell-i18n/en.yaml');
  assert.match(zh, /\n {2}unauthorized: 登录后才能问：su\n {2}locked: 已上锁，su 登录后可用\n/);
  assert.match(en, /\n {2}unauthorized: "Gray AI opens after you sign in: su"\n {2}locked: Locked\. Sign in with su to use Gray AI\n/);
  const ai = rd('space/web/assets/shell/js/shell/ai-panel.js');
  assert.match(ai, /unauthorized: "Gray AI opens after you sign in: su",/);
  assert.doesNotMatch(ai.slice(ai.indexOf('unauthorized:'), ai.indexOf('cooldown:')), /sudo styrigx/);
});
