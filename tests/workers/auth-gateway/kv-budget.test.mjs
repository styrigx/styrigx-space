/**
 * passkey-e2e 的预览状态：scripts/kv-budget.mjs（清预览 D1 只清干扰本次运行的表、每次运行估算）和 deploy.yml 里的接线。
 *
 * 2026-10-27 起网关认证状态全部在 D1 styrigx-auth-gateway(-preview)，不再绑定 KV：清预览只碰 D1，估算里 KV 操作全为 0。
 * PR 运行走本地模拟器（tests/web/e2e/preview-emulator.cjs），真实预览只在 main 的 push / 手动运行上跑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as budget from '../../../scripts/kv-budget.mjs';
import { REALM_LOCK } from '../../../workers/auth-gateway/functions/_kernel/realms.js';

const { PER_RUN_ESTIMATE, RESET_D1_TABLES, d1DatabaseId, previewD1Id } = budget;
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

test('kv-budget.mjs 只管 D1：不再导出 KV 清理（selectResetKeys / RESET_EXACT / RESET_PREFIXES），源码不调 KV REST', () => {
  for (const n of ['selectResetKeys', 'RESET_EXACT', 'RESET_PREFIXES']) assert.equal(budget[n], undefined, n);
  const src = readFileSync(path.join(REPO, 'scripts/kv-budget.mjs'), 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(src, /storage\/kv|kv\/namespaces/, '不调 KV REST');
  assert.match(src, /\/d1\/database\//);
});

test('清预览 D1：只清 passkey / password / attempt_limit（「是否已设置」和输错计数）；纪元、审计、重置开关等不清', () => {
  assert.deepEqual([...RESET_D1_TABLES], ['passkey', 'password', 'attempt_limit']);
  for (const t of ['epoch', 'kv_migration', 'lock_reset_switch', 'recovery_switch', 'user_handle', 'audit', 'challenge', 'tempkey', 'device']) {
    assert.ok(!RESET_D1_TABLES.includes(t), t + ' 不清');
  }
  /* 每张要清的表都真的在迁移里（不会清错表名） */
  const mig = ['0005_lock_account_state.sql', '0006_auth_state.sql']
    .map((f) => readFileSync(path.join(REPO, 'workers/auth-gateway/migrations', f), 'utf8')).join('\n');
  for (const t of RESET_D1_TABLES) assert.match(mig, new RegExp('CREATE TABLE IF NOT EXISTS ' + t + ' \\('), t);
});

test('清预览 D1：库 id 取 web/wrangler.toml 预览的 D1_LOCK_AUTH，和组合预览账号那一半的 D1_ACCOUNT_AUTH 同一个库，且不是正式库', () => {
  const pvToml = readFileSync(path.join(REPO, 'web/wrangler.toml'), 'utf8');
  const prodToml = readFileSync(path.join(REPO, 'workers/auth-gateway/wrangler.toml'), 'utf8');
  const pv = previewD1Id(REPO);
  assert.equal(pv, d1DatabaseId(pvToml, REALM_LOCK.d1Binding));
  assert.equal(pv, d1DatabaseId(pvToml, 'D1_ACCOUNT_AUTH'), '预览两个 D1 名字同一个库');
  assert.equal(d1DatabaseId(pvToml, 'D1_ROOT_AUTH'), '', 'D1_ROOT_AUTH 已删');
  assert.notEqual(pv, d1DatabaseId(prodToml, 'D1_LOCK_AUTH'));
  assert.equal(d1DatabaseId('[[d1_databases]]\nbinding = "X"\ndatabase_id = "ab-cd"\n', 'X'), 'ab-cd');
  assert.equal(d1DatabaseId('[[kv_namespaces]]\nbinding = "X"\nid = "abcd"\n', 'X'), '', '只认 d1_databases 块');
});

test('每次运行的估算：KV 操作全为 0（网关和测试都不碰 KV），D1 语句数有上限', () => {
  for (const t of ['read', 'write', 'delete', 'list']) assert.equal(PER_RUN_ESTIMATE[t], 0, t);
  assert.ok(PER_RUN_ESTIMATE.d1Statements > 0);
});

function passkeyJob() {
  const wf = yaml.load(readFileSync(path.join(REPO, '.github/workflows/deploy.yml'), 'utf8'));
  return wf.jobs['passkey-e2e'];
}

const NOT_PR = "github.event_name != 'pull_request'";
const ONLY_PR = "github.event_name == 'pull_request'";
const GATE = "steps.gate.outputs.run == 'true'";
const PREVIEW_RUN = 'Run WebAuthn E2E (SGX_TEST_SUITE=passkey)';
const EMU_START = 'Start local preview emulator (pull_request only)';
const EMU_RUN = 'Run WebAuthn E2E on local emulator (SGX_TEST_SUITE=passkey, pull_request only)';

test('deploy.yml：没有 KV 预算闸、不清 KV；清预览 D1 用 kv-budget.mjs，只在真实预览路上、且在部署预览 / 跑用例之前', () => {
  const job = passkeyJob();
  const names = job.steps.map((s) => s.name);
  const idx = (prefix) => names.findIndex((n) => n && n.startsWith(prefix));
  assert.equal(idx('KV budget guard'), -1);
  assert.equal(idx('Reset preview KV'), -1, '网关不再绑 KV，不清预览 KV');
  assert.ok(!job.steps.some((s) => s.run && /kv-budget\.mjs guard/.test(s.run)));
  const reset = idx('Reset preview D1');
  assert.ok(reset > 0);
  assert.equal(job.steps[reset].if, GATE + ' && ' + NOT_PR, 'PR 不清预览 D1');
  assert.ok(idx('Setup Node') < reset, 'node 要先装好');
  for (const later of ['Deploy to preview', PREVIEW_RUN]) {
    assert.ok(idx(later) > reset, later + ' 必须在清预览 D1 之后');
  }
  assert.match(job.steps[reset].run, /^node scripts\/kv-budget\.mjs reset-preview\s*$/);
});

test('deploy.yml：只改文档 / 样式才跳过；不再复用 PR 运行的结果（PR 测的是模拟器，不能顶替 main 上的真实预览）', () => {
  const job = passkeyJob();
  assert.deepEqual(job.permissions, { contents: 'read' }, '不再查 artifact / 别的运行，不要 actions: read');
  const scope = job.steps.find((s) => s.id === 'scope');
  const gate = job.steps.find((s) => s.id === 'gate');
  assert.ok(scope && gate);
  assert.ok(job.steps.indexOf(scope) < job.steps.indexOf(gate));
  assert.equal(job.steps.find((s) => s.id === 'reuse'), undefined);
  assert.ok(!job.steps.some((s) => s.id === 'tree' || (s.name && /passing-tree|Record the tree/.test(s.name))));
  assert.doesNotMatch(JSON.stringify(job), /passkey-e2e-ok-/);
  assert.deepEqual(Object.keys(gate.env).sort(), ['DOCS_ONLY', 'EVENT']);
  assert.equal(gate.env.DOCS_ONLY, '${{ steps.scope.outputs.docs_only }}');
  assert.match(gate.run, /if \[ "\$DOCS_ONLY" = true \]; then echo "run=false"/);
  assert.equal((gate.run.match(/run=false/g) || []).length, 1, '只有 docs_only 一种跳过');
  /* gate 之后到最后一个用例步骤：都只在 run == 'true' 时跑（Require Cloudflare secrets 另算，见下一条） */
  const names = job.steps.map((s) => s.name);
  const last = Math.max(names.indexOf(PREVIEW_RUN), names.indexOf(EMU_RUN));
  for (let i = job.steps.indexOf(gate) + 1; i <= last; i++) {
    const s = job.steps[i];
    if (s.name === 'Require Cloudflare secrets') continue;
    assert.ok(typeof s.if === 'string' && /^steps\.gate\.outputs\.run == 'true'( && .+)?$/.test(s.if), s.name + ': ' + s.if);
  }
  /* 生产私密变量守卫：main / 手动运行不跳（只改文档也查），PR 不碰 Cloudflare */
  const prodGuard = job.steps.find((s) => s.name && s.name.startsWith('Guard - no private vars'));
  assert.equal(prodGuard.if, NOT_PR);
  assert.ok(job.steps.indexOf(prodGuard) > last);
});

test('deploy.yml：PR → 本地模拟器（不用 Cloudflare secret、不部署预览、不清预览 D1）；main / 手动 → 真实预览', () => {
  const wf = yaml.load(readFileSync(path.join(REPO, '.github/workflows/deploy.yml'), 'utf8'));
  const job = wf.jobs['passkey-e2e'];
  /* 必需检查：job 名、触发条件、上游不变 */
  assert.ok(wf.on.push && wf.on.pull_request && 'workflow_dispatch' in wf.on);
  assert.equal(job.if, "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository");
  assert.equal(job.needs, 'quality');
  const step = (name) => {
    const s = job.steps.find((x) => x.name === name || (x.name && x.name.startsWith(name)));
    assert.ok(s, name);
    return s;
  };
  const pos = (name) => job.steps.indexOf(step(name));

  /* 任何用到 Cloudflare secret 的步骤都不在 PR 上跑 */
  const usesSecrets = job.steps.filter((s) => /secrets\./.test(JSON.stringify(s)));
  assert.ok(usesSecrets.length >= 6);
  for (const s of usesSecrets) assert.ok(String(s.if).includes(NOT_PR), s.name + ': ' + s.if);
  /* 真实预览那条路的步骤：只在 main / 手动运行 */
  for (const n of ['Require Cloudflare secrets', 'Reset preview D1', 'Bundle preview _worker.js',
    'Generate Ed25519 test key pairs', "Put this run's public keys", 'Set preview test secrets', 'Apply D1 migrations to preview',
    'Deploy to preview', PREVIEW_RUN, 'Guard - no private vars on Pages production']) {
    assert.ok(String(step(n).if).includes(NOT_PR), n);
  }
  /* 真实预览的用例步骤原样：读 web/wrangler.toml 的预览地址，用 Pages 部署 token */
  const pv = step(PREVIEW_RUN);
  assert.equal(pv.env.SGX_TEST_CF_TOKEN, '${{ secrets.STYRIGX_SPACE_PAGES_DEPLOY }}');
  assert.match(pv.run, /export SGX_TEST_BASE=/);
  assert.match(pv.run, /npx playwright test --config=tests\/config\/playwright\.config\.js/);
  assert.ok(pos('Deploy to preview') < pos(PREVIEW_RUN));

  /* 两条路共用：凭证生成、Hugo / 依赖 / 浏览器、CSS、建站 */
  for (const n of ['Setup Node', 'Generate preview test credentials', 'Setup Hugo', 'Install dependencies', 'Playwright Chromium', 'Build CSS', 'Build site']) {
    assert.equal(step(n).if, GATE, n);
  }
  assert.equal(step('Build site').run, 'hugo --minify -s web');

  /* PR：模拟器 */
  const start = step(EMU_START);
  const emu = step(EMU_RUN);
  for (const s of [start, emu]) {
    assert.equal(s.if, GATE + ' && ' + ONLY_PR, s.name);
    const txt = JSON.stringify(s);
    assert.doesNotMatch(txt, /secrets\./, s.name + ' 不许用 secret');
    assert.doesNotMatch(txt, /api\.cloudflare\.com|wrangler|kv-budget/, s.name + ' 不许碰 Cloudflare');
  }
  assert.ok(pos('Build site') < pos(EMU_START) && pos(EMU_START) < pos(EMU_RUN), '先建站、再起模拟器、再跑用例');
  assert.ok(pos('Generate preview test credentials') < pos(EMU_START));
  assert.match(start.run, /node -e "require\('node:sqlite'\)"/);
  assert.match(start.run, /node tests\/web\/e2e\/preview-emulator\.cjs --port 8788 --admin-key "\$PREVIEW_TEST_ADMIN_KEY" --account-root-key "\$PREVIEW_TEST_ACCOUNT_ROOT_KEY" --pepper "\$PREVIEW_TEST_PW_PEPPER" > "\$log" 2>&1 &/);
  assert.match(start.run, /curl -fsS -o \/dev\/null http:\/\/127\.0\.0\.1:8788\/__kv\/stats/, '等它就绪');
  assert.match(start.run, /exit 1\s*$/, '超时就红');
  /* 用例变量按 preview-emulator.cjs 文件头；端口和起模拟器的一致 */
  assert.deepEqual(emu.env, {
    SGX_TEST_SUITE: 'passkey',
    SGX_TEST_BASE: 'http://localhost:8788',
    SGX_TEST_ADMIN_KEY: '${{ env.PREVIEW_TEST_ADMIN_KEY }}',
    SGX_TEST_ACCOUNT_ROOT_KEY: '${{ env.PREVIEW_TEST_ACCOUNT_ROOT_KEY }}',
    SGX_TEST_CF_API: 'http://127.0.0.1:8788/client/v4',
    SGX_TEST_CF_TOKEN: 'x',
    SGX_TEST_CF_ACCOUNT: 'x',
    SGX_TEST_PREVIEW_D1_ID: 'local',
    CI: '1',
  });
  assert.match(emu.run, /^npx playwright test --config=tests\/config\/playwright\.config\.js$/m);
  const header = readFileSync(path.join(REPO, 'tests/web/e2e/preview-emulator.cjs'), 'utf8').slice(0, 3000);
  for (const v of ['SGX_TEST_BASE=http://localhost:8788', 'SGX_TEST_CF_API=http://127.0.0.1:8788/client/v4', 'SGX_TEST_PREVIEW_D1_ID=local']) {
    assert.ok(header.includes(v), '模拟器文件头写的运行方式：' + v);
  }

  /* 真实预览排队用的共享并发组只给 main / 手动运行；PR 不排进去 */
  assert.match(job.concurrency.group, /github\.event_name == 'pull_request' && format\('passkey-e2e-emulator-\{0\}', github\.ref\) \|\| 'passkey-e2e-preview'/);
  assert.equal(job.concurrency['cancel-in-progress'], false);
  /* 失败时上传的东西：原来的测试结果 + 模拟器日志 */
  const up = step('Upload test artifacts on failure');
  assert.equal(up.if, 'failure()');
  for (const p of ['test-results/', 'playwright-report/', 'emulator-log/']) assert.ok(up.with.path.includes(p), p);
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
