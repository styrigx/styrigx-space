/**
 * 共享 CI（.github/actions/*）：Hugo 版本与 extended 只在 setup-hugo 定义一处；主站工作流用本地 action；
 * Renovate 预设只从这一处认 Hugo，并认子站对 styrigx-space 共享 action 的固定 tag / SHA 引用；必需检查的 job 名不变。
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
  assert.ok(uses('quality').includes('./.github/actions/setup-hugo'));
  assert.ok(uses('quality').includes('./.github/actions/setup-node-deps'));
  assert.ok(uses('quality').includes('./.github/actions/setup-playwright'));
  assert.ok(uses('passkey-e2e').includes('./.github/actions/setup-hugo'));
  const q = wf.jobs.quality.steps.find((s) => s.uses === './.github/actions/setup-playwright');
  assert.equal(q.with['cjk-fonts'], 'true', '视觉回归要 CJK 字体');
  const snap = yaml.load(read('.github/workflows/update-snapshots.yml'));
  const su = snap.jobs.update.steps.map((s) => s.uses).filter(Boolean);
  for (const a of ['setup-hugo', 'setup-node-deps', 'setup-playwright']) assert.ok(su.includes('./.github/actions/' + a), a);
});

test('Renovate 预设：Hugo 只从 setup-hugo 认；子站对 styrigx-space 的 tag / SHA 引用两种写法都认', () => {
  const preset = JSON.parse(read('.github/renovate-preset.json'));
  const hugo = preset.customManagers.find((m) => m.depNameTemplate === 'gohugoio/hugo');
  assert.deepEqual(hugo.managerFilePatterns, ['/(^|/)\\.github/actions/setup-hugo/action\\.ya?ml$/']);
  const hits = hugo.matchStrings.flatMap((s) => [...read(HUGO_ACTION).matchAll(new RegExp(s, 'g'))]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].groups.currentValue, yaml.load(read(HUGO_ACTION)).runs.steps[0].env.HUGO_VERSION);

  const ci = preset.customManagers.find((m) => m.datasourceTemplate === 'github-tags');
  const re = new RegExp(ci.matchStrings[0]);
  const tag = re.exec('        uses: styrigx/styrigx-space/.github/actions/setup-hugo@v1.0.0');
  assert.equal(tag.groups.depName, 'styrigx/styrigx-space');
  assert.equal(tag.groups.currentValue, 'v1.0.0');
  assert.equal(tag.groups.currentDigest, undefined);
  const sha = re.exec("        uses: styrigx/styrigx-space/.github/actions/setup-playwright@0123456789abcdef0123456789abcdef01234567 # v1.2.3");
  assert.equal(sha.groups.currentDigest, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(sha.groups.currentValue, 'v1.2.3');
  assert.equal(re.exec('        uses: styrigx/styrigx-space/.github/actions/setup-hugo@main'), null, '不跟 main');
  /* 同一条引用只归 regex manager：github-actions manager 对它关掉 */
  const off = preset.packageRules.find((r) => (r.matchManagers || []).includes('github-actions') && (r.matchDepNames || []).includes('styrigx/styrigx-space'));
  assert.equal(off.enabled, false);
});
