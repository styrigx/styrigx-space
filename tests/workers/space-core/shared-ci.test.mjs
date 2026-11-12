/**
 * 共享 CI（.github/actions/*）：Hugo 版本与 extended 只在 setup-hugo 定义一处；主站工作流用本地 action；
 * 必需检查的 job 名不变。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const read = (p) => readFileSync(path.join(REPO, p), 'utf8');
const WORKFLOWS = readdirSync(path.join(REPO, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)).map((f) => '.github/workflows/' + f);
const ACTIONS = readdirSync(path.join(REPO, '.github/actions'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => '.github/actions/' + d.name + '/action.yml');
const HUGO_ACTION = '.github/actions/setup-hugo/action.yml';

test('Hugo 版本只在 setup-hugo 定义一次，且是 extended', () => {
  const all = [...WORKFLOWS, ...ACTIONS];
  const defs = all.flatMap((f) => [...read(f).matchAll(/HUGO_VERSION:\s*'(\d+\.\d+\.\d+)'/g)].map((m) => [f, m[1]]));
  assert.equal(defs.length, 1, JSON.stringify(defs));
  assert.equal(defs[0][0], HUGO_ACTION);
  const pick = yaml.load(read(HUGO_ACTION)).runs.steps.find((s) => s.id === 'pick');
  assert.equal(pick.env.HUGO_EXTENDED, 'true');
  /* 没有别处直接装 Hugo，也没有字面 hugo-version */
  for (const f of all) {
    if (f === HUGO_ACTION) continue;
    assert.doesNotMatch(read(f), /peaceiris\/actions-hugo|hugo-version:/, f);
  }
});

test('setup-hugo 把版本写进 $GITHUB_ENV（子站过渡期的 env.HUGO_VERSION 靠它覆盖），并核对装上的是这个版本', () => {
  const steps = yaml.load(read(HUGO_ACTION)).runs.steps;
  assert.match(steps[0].run, /HUGO_VERSION=\$HUGO_VERSION" >> "\$GITHUB_ENV"/);
  assert.match(steps.at(-1).run, /hugo version/);
  assert.match(steps.at(-1).run, /\+extended/);
});

test('composite action：外部 action 一律锁完整 SHA，run 步骤都写了 shell', () => {
  for (const f of ACTIONS) {
    const a = yaml.load(read(f));
    assert.equal(a.runs.using, 'composite', f);
    for (const s of a.runs.steps) {
      if (s.uses) assert.match(s.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, f + ': ' + s.uses);
      if (s.run) assert.ok(s.shell, f + ': ' + s.name);
    }
  }
});

test('主站工作流用本地共享 action；必需检查的 job 名（quality、passkey-e2e）和部署 job 名不变', () => {
  const wf = yaml.load(read('.github/workflows/deploy.yml'));
  for (const j of ['quality', 'passkey-e2e', 'build-and-deploy']) assert.ok(wf.jobs[j], j);
  const uses = (job) => wf.jobs[job].steps.map((s) => s.uses).filter(Boolean);
  /* 2026-11-04 CI 拆分：quality 是汇总作业，检查分在 6 个并行作业里 */
  const PARTS = ['unit', 'build', 'e2e-lock', 'e2e-sites', 'visual', 'lighthouse'];
  for (const j of PARTS) {
    assert.ok(wf.jobs[j], j);
    assert.ok(uses(j).includes('./.github/actions/setup-node-deps'), j);
  }
  for (const j of ['build', 'e2e-lock', 'visual', 'lighthouse']) assert.ok(uses(j).includes('./.github/actions/setup-hugo'), j);
  for (const j of ['e2e-lock', 'e2e-sites', 'visual']) {
    const s = wf.jobs[j].steps.find((x) => x.uses === './.github/actions/setup-playwright');
    assert.ok(s, j);
    assert.equal(s.with['cjk-fonts'], 'true', j + '：截图要 CJK 字体');
  }
  assert.ok(uses('passkey-e2e').includes('./.github/actions/setup-hugo'));
  /* 汇总作业：等全部 6 个，always() 跑，任何一个不是 success 就红 */
  const q = wf.jobs.quality;
  assert.deepEqual([...q.needs].sort(), [...PARTS].sort());
  assert.match(q.if, /always\(\)/);
  assert.match(q.steps.at(-1).run, /result !== "success"/);
  /* e2e 作业测 build 上传的那份产物，不自己重建生产构建 */
  for (const j of ['e2e-lock', 'e2e-sites']) assert.equal(wf.jobs[j].needs, 'build', j);
  const snap = yaml.load(read('.github/workflows/update-snapshots.yml'));
  const su = snap.jobs.update.steps.map((s) => s.uses).filter(Boolean);
  for (const a of ['setup-hugo', 'setup-node-deps', 'setup-playwright']) assert.ok(su.includes('./.github/actions/' + a), a);
});

test('visual 分 2 片：matrix.shard=[1,2]、fail-fast 关、带 CJK 字体、按片跑与按片传产物；quality 仍等 visual', () => {
  const wf = yaml.load(read('.github/workflows/deploy.yml'));
  const v = wf.jobs.visual;
  /* 作业名不改（matrix 显示为 visual (1)、visual (2)），quality 的 needs 仍写 visual */
  assert.equal(v.name, undefined, 'visual 作业不另起名');
  assert.deepEqual(v.strategy.matrix.shard, [1, 2]);
  assert.equal(v.strategy['fail-fast'], false);
  const pw = v.steps.find((s) => s.uses === './.github/actions/setup-playwright');
  assert.equal(pw.with['cjk-fonts'], 'true');
  const run = v.steps.find((s) => typeof s.run === 'string' && /npx playwright test --config=tests\/config\/playwright\.config\.js/.test(s.run));
  assert.ok(run, 'visual 的 Playwright 步骤');
  assert.ok(run.run.includes('--shard=${{ matrix.shard }}/2'), run.run);
  const up = v.steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/upload-artifact@'));
  assert.equal(up.with.name, 'visual-diff-${{ matrix.shard }}');
  /* 不用 continue-on-error 掩盖失败 */
  assert.equal(v['continue-on-error'], undefined);
  for (const s of v.steps) assert.equal(s['continue-on-error'], undefined, s.name);
  assert.ok(wf.jobs.quality.needs.includes('visual'));
  /* 本地复现某一片：ci-local.sh 的 visual 组认 VISUAL_SHARD */
  assert.match(read('space/scripts/ci-local.sh'), /VISUAL_SHARD[\s\S]*--shard=\$\{VISUAL_SHARD%\/2\}\/2/);
});

