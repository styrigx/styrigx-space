/**
 * passkey-e2e 的 KV 配额：scripts/kv-budget.mjs（清预览 KV 只删干扰键、每次运行估算）和 deploy.yml 里的接线。
 *
 * 背景：免费计划的 KV 写 / 删 / 列各 1000 次、按整个账号每个 UTC 日算，预览 KV 和生产网关共用；
 * 2026-10-25 四次 passkey-e2e 用掉了全账号约 84% 的非读操作。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  selectResetKeys, RESET_EXACT, RESET_PREFIXES, PER_RUN_ESTIMATE,
} from '../../../scripts/kv-budget.mjs';
import { REALM_LOCK, REALM_ACCOUNT, REALM_ROOT, LOCK_EPOCH_KEY, ACCOUNT_EPOCH_KEY } from '../../../workers/auth-gateway/functions/_kernel/realms.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

test('清预览 KV：删「已设置」状态和按 IP 的失败计数 / 冷却', () => {
  const del = [
    'lock-password', 'lock-configured', 'lock-passkey-index', 'lock-passkey:AbCdEf123456',
    'account-password', 'account-configured', 'account-passkey-index', 'account-passkey:ZyXw98765432',
    'root-fail:203.0.113.7', 'lock-password-fail:2001:db8:0:0', 'lock-password-cooldown:203.0.113.7',
    'account-password-fail:203.0.113.7', 'account-password-cooldown:203.0.113.7', 'lock-tempkey-fail:203.0.113.7',
  ];
  const keep = [
    LOCK_EPOCH_KEY, ACCOUNT_EPOCH_KEY, 'lock-user-id', 'account-user-id',
    'root-audit:1792948408903:sig6b6tj', 'root-fail-global', 'lock-password-fail-global', 'account-password-fail-global',
    'lock-tempkey-fail-global', 'lock-passkey-challenge:vlCE79kMLp6zn6jAXWoZQg', 'account-passkey-challenge:x',
    'lock-reset-challenge:x', 'lock-reset-switch', 'lock-tempkey:abc', 'lock-tempkey-code:h', 'lock-tempkey-revoked:abc',
    'account-device:d1', 'account-device-revoked:d1',
  ];
  const got = selectResetKeys([...del, ...keep].map((name) => ({ name, expiration: 1 })));
  assert.deepEqual(got.sort(), del.slice().sort());
  assert.deepEqual(selectResetKeys([]), []);
  assert.deepEqual(selectResetKeys([{}, null, { name: '' }]), []);
});

test('清预览 KV：键名全部取自 realms.js（改名时跟着走），前缀都以冒号结尾、不吞掉别的键', () => {
  for (const k of [REALM_LOCK.kv.password, REALM_LOCK.kv.configured, REALM_LOCK.kv.passkeyIndex,
    REALM_ACCOUNT.kv.password, REALM_ACCOUNT.kv.configured, REALM_ACCOUNT.kv.passkeyIndex]) {
    assert.ok(RESET_EXACT.includes(k), k);
  }
  assert.ok(RESET_PREFIXES.includes(REALM_ROOT.kv.failPrefix));
  for (const p of RESET_PREFIXES) {
    assert.ok(typeof p === 'string' && p.endsWith(':'), p);
  }
  /* 通行密钥记录前缀不能顺带删掉 challenge（lock-passkey: vs lock-passkey-challenge:） */
  assert.ok(!REALM_LOCK.kv.passkeyChallengePrefix.startsWith(REALM_LOCK.kv.passkeyPrefix));
  assert.ok(!REALM_ACCOUNT.kv.passkeyChallengePrefix.startsWith(REALM_ACCOUNT.kv.passkeyPrefix));
  /* 纪元不删（旧会话 / 票是旧钥匙签的，验签先失败） */
  assert.ok(!RESET_EXACT.includes(LOCK_EPOCH_KEY) && !RESET_EXACT.includes(ACCOUNT_EPOCH_KEY));
});

test('每次运行的估算覆盖本地模拟器实测（写 87、删 47、列 9、读 549）', () => {
  for (const t of ['read', 'write', 'delete', 'list']) assert.ok(PER_RUN_ESTIMATE[t] > 0, t);
  assert.ok(PER_RUN_ESTIMATE.write >= 87 && PER_RUN_ESTIMATE.delete >= 47 && PER_RUN_ESTIMATE.list >= 9 && PER_RUN_ESTIMATE.read >= 549);
});

function passkeyJob() {
  const wf = yaml.load(readFileSync(path.join(REPO, '.github/workflows/deploy.yml'), 'utf8'));
  return wf.jobs['passkey-e2e'];
}

test('deploy.yml：没有 KV 预算闸；清预览 KV 用 kv-budget.mjs，且在部署预览 / 跑用例之前', () => {
  const job = passkeyJob();
  const names = job.steps.map((s) => s.name);
  const idx = (prefix) => names.findIndex((n) => n && n.startsWith(prefix));
  assert.equal(idx('KV budget guard'), -1);
  assert.ok(!job.steps.some((s) => s.run && /kv-budget\.mjs guard/.test(s.run)));
  const reset = idx('Reset preview KV');
  assert.ok(reset > 0);
  assert.ok(idx('Setup Node') < reset, 'node 要先装好');
  for (const later of ['Deploy to preview', 'Run WebAuthn E2E']) {
    assert.ok(idx(later) > reset, later + ' 必须在清预览 KV 之后');
  }
  assert.match(job.steps[reset].run, /node scripts\/kv-budget\.mjs reset-preview "\$kv"/);
  /* 生产 KV id 断言还在 */
  assert.match(job.steps[reset].run, /preview KV id must not be the production gateway KV/);
});

test('deploy.yml：同一棵树已通过的 PR 运行、或只改文档 / 样式才跳过；跳过时只跳 KV / 预览相关步骤', () => {
  const job = passkeyJob();
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read' });
  const scope = job.steps.find((s) => s.id === 'scope');
  const reuse = job.steps.find((s) => s.id === 'reuse');
  const gate = job.steps.find((s) => s.id === 'gate');
  assert.ok(scope && reuse && gate);
  assert.ok(job.steps.indexOf(scope) < job.steps.indexOf(reuse) && job.steps.indexOf(reuse) < job.steps.indexOf(gate));
  assert.match(reuse.run, /"\$EVENT" != "push"/, '只有 push 才可能跳过');
  assert.match(reuse.run, /head_repository_id.*repository_id/, 'fork 的运行不认');
  assert.match(reuse.run, /"pull_request"/);
  assert.match(reuse.run, /\.github\/workflows\/deploy\.yml/);
  assert.match(reuse.run, /Run WebAuthn E2E \(SGX_TEST_SUITE=passkey\)/);
  assert.match(reuse.run, /\|\| echo "hit=false"/, 'API 出错照常跑');
  assert.equal(reuse.if, "steps.scope.outputs.docs_only != 'true'");
  assert.equal(gate.env.DOCS_ONLY, '${{ steps.scope.outputs.docs_only }}');
  assert.equal(gate.env.REUSE_HIT, '${{ steps.reuse.outputs.hit }}');
  const names = job.steps.map((s) => s.name);
  const run = names.indexOf('Run WebAuthn E2E (SGX_TEST_SUITE=passkey)');
  assert.ok(run > 0);
  /* E2E 步骤名被 reuse 用来核对，改名要两边一起改 */
  for (let i = job.steps.indexOf(gate) + 1; i <= run; i++) {
    const s = job.steps[i];
    if (s.name === 'Require Cloudflare secrets') continue;
    assert.ok(typeof s.if === 'string' && /^steps\.gate\.outputs\.run == 'true'( && .+)?$/.test(s.if), s.name + ': ' + s.if);
  }
  /* 生产私密变量守卫不跳 */
  const prodGuard = job.steps.find((s) => s.name && s.name.startsWith('Guard - no private vars'));
  assert.equal(prodGuard.if, undefined);
  /* 真跑过并通过的 PR 运行才记下自己测的树（只改文档 / 样式而跳过的不记） */
  const up = job.steps.find((s) => s.name && s.name.startsWith('Upload passing-tree marker'));
  assert.equal(up.if, "success() && github.event_name == 'pull_request' && steps.gate.outputs.run == 'true'");
  assert.equal(up.with.name, 'passkey-e2e-ok-${{ steps.tree.outputs.tree }}');
  assert.ok(job.steps.indexOf(up) > job.steps.indexOf(prodGuard));
});

test('deploy.yml：passkey-e2e 的路径过滤是 denylist，做在步骤层，拿不准一律照跑', () => {
  const wf = yaml.load(readFileSync(path.join(REPO, '.github/workflows/deploy.yml'), 'utf8'));
  /* 不用 workflow 级 paths（会让必需检查一直挂着） */
  for (const ev of ['push', 'pull_request']) assert.equal((wf.on[ev] || {}).paths, undefined, ev);
  for (const ev of ['push', 'pull_request']) assert.equal((wf.on[ev] || {})['paths-ignore'], undefined, ev);
  const scope = wf.jobs['passkey-e2e'].steps.find((s) => s.id === 'scope');
  assert.equal(scope['continue-on-error'], true, '本步意外出错也照跑');
  const sh = scope.run;
  assert.match(sh, /pull_request\) a="\$PR_BASE"; b="\$PR_HEAD"/);
  assert.match(sh, /push\) a="\$PUSH_BEFORE"; b="\$PUSH_AFTER"/);
  assert.match(sh, /\*\) verdict false "event/, '其他事件照跑');
  assert.match(sh, /zero='\^0\+\$'/, 'before 全零照跑');
  assert.match(sh, /git merge-base "\$a" "\$b"/, 'PR 比 base...head');
  assert.match(sh, /\[ -n "\$changes" \] \|\| verdict false/, '空 diff 照跑');
  /* 照跑名单在跳过规则之前 */
  const always = sh.indexOf('.github/* | package.json | package-lock.json | web/shared/* | web/assets/js/* | */_kernel/*)');
  assert.ok(always > 0 && always < sh.indexOf('*.md | *.css)'));
  assert.match(sh, /\[ "\$st" = M \] \|\| \[ "\$st" = A \] \|\| verdict false/, '删除照跑');
  assert.match(sh, /\*\) verdict false "\$f: run"/, '其余任何文件照跑');
  assert.match(sh, /verdict true/);
  /* 依赖 passkey-e2e 的部署 job：跳过用例时照常部署，上游失败 / 取消不部署 */
  for (const [name, j] of Object.entries(wf.jobs)) {
    const needs = [].concat(j.needs || []);
    if (!needs.includes('passkey-e2e')) continue;
    assert.match(String(j.if), /^\$\{\{ !failure\(\) && !cancelled\(\) && github\.ref == 'refs\/heads\/main'/, name);
  }
});

test('测试 helper：不再删重置开关键；会话 / 进门票先用只读接口复用', () => {
  const helpers = readFileSync(path.join(REPO, 'tests/web/e2e/preview-helpers.cjs'), 'utf8');
  const spec = readFileSync(path.join(REPO, 'tests/web/e2e/passkey.spec.js'), 'utf8');
  assert.doesNotMatch(helpers, /kvDel\('lock-reset-switch'\)/);
  assert.doesNotMatch(spec, /kvDel\('lock-reset-switch'\)/);
  assert.match(helpers, /\/api\/lock-session-check/);
  assert.match(helpers, /action: 'status'/);
});
