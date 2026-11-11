/**
 * main 部署的自动回滚：space/scripts/deploy-rollback.mjs（记线上版本 / 部署后核对 / 回滚）和 deploy.yml 里的接线。
 * （放在 tests/workers/space-core/ 下，同 kv-budget.test.mjs：CI 的单元测试 glob 已经包含这个目录。）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  parseDeploymentStatus, pagesCanonicalId, isSafeId, parseArgs,
  workerSnapshot, workerVerify, workerRollback, pollLive, pagesSnapshot, pagesRollback,
  workerNameFromToml, floorFor, checkFloor, versionAboveFloor,
} from '../../../space/scripts/deploy-rollback.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const V1 = '11111111-aaaa-4bbb-8ccc-000000000001';
const V2 = '22222222-aaaa-4bbb-8ccc-000000000002';
/** 测试里轮询不真等 */
const W = { attempts: 4, intervalMs: 0, sleep: () => {} };
const status = (/** @type {Array<[string, number]>} */ vs) => JSON.stringify({ id: 'dep', versions: vs.map(([version_id, percentage]) => ({ version_id, percentage })) });

/** 安静地跑（脚本往 stdout 打 ::notice:: 等），收集输出 */
function quiet(fn) {
  const w = process.stdout.write;
  let out = '';
  process.stdout.write = (/** @type {any} */ s) => { out += s; return true; };
  const saved = process.env.GITHUB_OUTPUT;
  delete process.env.GITHUB_OUTPUT;
  const done = () => { process.stdout.write = w; if (saved !== undefined) process.env.GITHUB_OUTPUT = saved; };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then((v) => { done(); return { r: v, out }; }, (e) => { done(); throw e; });
    done();
    return { r, out };
  } catch (e) { done(); throw e; }
}

test('parseDeploymentStatus：单版本 100% → id；前面混着提示行也能解析', () => {
  assert.deepEqual(parseDeploymentStatus(status([[V1, 100]])), { versionId: V1, reason: 'ok' });
  assert.equal(parseDeploymentStatus('npm warn exec ...\n' + status([[V1, 100]])).versionId, V1);
});

test('parseDeploymentStatus：灰度 / 空 / 坏 JSON / 怪 id → null（不替它挑回滚目标）', () => {
  assert.equal(parseDeploymentStatus(status([[V1, 50], [V2, 50]])).versionId, null);
  assert.equal(parseDeploymentStatus(status([[V1, 90]])).versionId, null);
  assert.equal(parseDeploymentStatus(status([])).versionId, null);
  assert.equal(parseDeploymentStatus('').versionId, null);
  assert.equal(parseDeploymentStatus('{oops').versionId, null);
  assert.equal(parseDeploymentStatus(status([['x; rm -rf /', 100]])).versionId, null);
});

test('pagesCanonicalId / isSafeId / parseArgs', () => {
  assert.equal(pagesCanonicalId({ canonical_deployment: { id: 'abcdef12-3456' } }), 'abcdef12-3456');
  assert.equal(pagesCanonicalId({ canonical_deployment: null }), null);
  assert.equal(pagesCanonicalId(null), null);
  assert.ok(isSafeId(V1));
  assert.ok(!isSafeId('../x'));
  assert.ok(!isSafeId(''));
  assert.deepEqual(parseArgs(['--to', V1, '--previous', '']), { to: V1, previous: '' });
  assert.throws(() => parseArgs(['--to']));
  assert.throws(() => parseArgs(['stray']));
});

/** 假 wrangler：deployments status 依次回 states，rollback 记下调用 */
function fakeWrangler(/** @type {Array<string|null>} */ states, rollbackStatus = 0) {
  const calls = [];
  let i = 0;
  const run = (/** @type {string[]} */ args) => {
    calls.push(args);
    if (args[0] === 'deployments') {
      const s = states[Math.min(i++, states.length - 1)];
      return s === null ? { status: 1, stdout: '', stderr: 'The Worker x has no deployments.' } : { status: 0, stdout: status([[s, 100]]), stderr: '' };
    }
    if (args[0] === 'rollback') return { status: rollbackStatus, stdout: 'ok\n', stderr: rollbackStatus ? 'boom' : '' };
    throw new Error('unexpected ' + args.join(' '));
  };
  return { run, calls };
}

test('worker-snapshot：有线上版本 → 记下；第一次部署（还没有）→ 空 + warning，不抛', () => {
  assert.equal(quiet(() => workerSnapshot({ run: fakeWrangler([V1]).run })).r, V1);
  const { r, out } = quiet(() => workerSnapshot({ run: fakeWrangler([null]).run }));
  assert.equal(r, '');
  assert.match(out, /::warning::no rollback target recorded/);
  assert.match(out, /^version=$/m);
});

test('worker-rollback：线上还是记下的版本（上传就失败）→ 不回滚', () => {
  const f = fakeWrangler([V1]);
  assert.equal(quiet(() => workerRollback({ to: V1, run: f.run, wait: W })).r, 0);
  assert.ok(!f.calls.some((c) => c[0] === 'rollback'));
});

test('worker-rollback：线上是新版本 → wrangler rollback <id> --message … --yes，再核对', () => {
  const f = fakeWrangler([V2, V1]);
  assert.equal(quiet(() => workerRollback({ to: V1, run: f.run, message: 'auto-rollback: test', wait: W })).r, 0);
  const rb = f.calls.find((c) => c[0] === 'rollback');
  assert.deepEqual(rb, ['rollback', V1, '--message', 'auto-rollback: test', '--yes']);
});

test('worker-rollback：rollback 失败 / 回滚后线上不是目标 → 退出码 1；目标不是 id → 1，不调 wrangler', () => {
  assert.equal(quiet(() => workerRollback({ to: V1, run: fakeWrangler([V2], 1).run, wait: W })).r, 1);
  assert.equal(quiet(() => workerRollback({ to: V1, run: fakeWrangler([V2, V2]).run, wait: W })).r, 1);
  const f = fakeWrangler([V2]);
  assert.equal(quiet(() => workerRollback({ to: '--force', run: f.run, wait: W })).r, 1);
  assert.equal(f.calls.length, 0);
});

/** 版本详情（wrangler versions view --json） */
const details = (/** @type {string[]} */ names, created = '2026-10-28T02:00:00Z') => JSON.stringify({
  id: V1, metadata: { created_on: created }, resources: { bindings: names.map((name) => ({ type: 'd1', name })) },
});
const FLOORS = { 'gw': { requireBindings: ['D1_SPACE', 'D1_ACCOUNT_AUTH'] }, 'dated': { notBefore: '2026-10-28T00:00:00Z' } };
/** 假 wrangler，带 versions view：details 按版本 id 回 */
function fakeWranglerWithView(/** @type {Array<string|null>} */ states, /** @type {Record<string, string|null>} */ views) {
  const base = fakeWrangler(states);
  const run = (/** @type {string[]} */ args) => {
    if (args[0] === 'versions' && args[1] === 'view') {
      base.calls.push(args);
      const d = views[args[2]];
      return d == null ? { status: 1, stdout: '', stderr: 'not found' } : { status: 0, stdout: 'banner\n' + d, stderr: '' };
    }
    return base.run(args);
  };
  return { run, calls: base.calls };
}

test('回滚下限：workerNameFromToml 只认顶层 name', () => {
  assert.equal(workerNameFromToml('# c\nname = "styrigx-auth-gateway"\nmain = "x"\n[env.preview]\nname = "other"\n'), 'styrigx-auth-gateway');
  assert.equal(workerNameFromToml('[vars]\nname = "x"\n'), '');
  assert.equal(workerNameFromToml(''), '');
});

test('回滚下限：floor 文件里网关、账号、status 的绑定名和 wrangler.toml 对得上（P4-2b：网关、status 要 AI_SERVICE）', () => {
  const gwToml = readFileSync(path.join(REPO, 'workers/space-core/wrangler.toml'), 'utf8');
  const acToml = readFileSync(path.join(REPO, 'workers/account/wrangler.toml'), 'utf8');
  const stToml = readFileSync(path.join(REPO, 'workers/status/wrangler.toml'), 'utf8');
  const gw = floorFor(workerNameFromToml(gwToml));
  const ac = floorFor(workerNameFromToml(acToml));
  const st = floorFor(workerNameFromToml(stToml));
  /* 账号拆分 PR3：网关要有转发绑定 ACCOUNT，账号要有账号库 D1_ACCOUNT（命名 v2：自动回滚不退过 0005 换表那一版）。
     P2-3 放宽：不再要求进站凭证的绑定名（P2-3 之前的版本绑的是旧名，P2-3 部署失败时要能回到它） */
  /* 进站 v3 L2：键 styrigx-space-core；v5 收尾删了 SGX_SPACE_TEMPKEY_PEPPER 绑定，不再要求；v6 P4 进站签发删除，不再要求 SGX_SPACE_RECOVERY_KEY（本 Worker 不绑 Secrets Store） */
  assert.equal(workerNameFromToml(gwToml), 'styrigx-space-core');
  assert.deepEqual(gw && gw.requireBindings, ['D1_SPACE', 'ACCOUNT', 'AI_SERVICE']);
  assert.equal(floorFor('styrigx-auth-gateway'), null, '旧网关名不再有下限（新 Worker 从零开始）');
  assert.deepEqual(ac && ac.requireBindings, ['D1_ACCOUNT']);
  assert.deepEqual(st && st.requireBindings, ['AI_SERVICE']);
  /* 进站 v3 L3（旧库 styrigx-space-gateway 删了）：网关 / status / ai 不退到 L2b 切库之前的版本（它们绑着已删的旧库 / 旧 KV） */
  for (const n of ['styrigx-status', 'styrigx-ai']) assert.equal(floorFor(n) && floorFor(n).notBefore, '2026-11-09T04:16:00Z', n);
  /* v5 删临时钥匙（#387）：space-core 不退到迁移 0002 之前的版本（INSERT 还写已删的 share_link.key_id） */
  assert.equal(floorFor('styrigx-space-core') && floorFor('styrigx-space-core').notBefore, '2026-11-10T13:35:00Z');
  // 要求的绑定当前 wrangler.toml 里确实有（否则每次部署都记不到目标）
  for (const [toml, f] of [[gwToml, gw], [acToml, ac], [stToml, st]]) {
    for (const n of /** @type {any} */ (f).requireBindings || []) assert.match(toml, new RegExp('^binding = "' + n + '"$', 'm'));
  }
  assert.equal(floorFor('styrigx-chat'), null);
  assert.equal(floorFor('$comment'), null);
});

test('回滚下限：bindings 里的服务绑定 / Secrets Store 绑定也按名字认（拆分前的网关版本没有 ACCOUNT、P2-3 之前绑的是旧名 → 不满足）', () => {
  /* 这里只看绑定名（版本时间是假的）；notBefore 另测：L2b 切库之前创建的版本绑定齐全也不合格 */
  const full = floorFor('styrigx-space-core');
  const gw = { ...full, notBefore: undefined };
  const v = (list) => JSON.stringify({ id: V1, metadata: { created_on: 'Fri 2026-10-30 8:00 AM CST (UTC+08:00)' }, resources: { bindings: list } });
  const after = [{ type: 'd1', name: 'D1_SPACE' }, { type: 'service', name: 'ACCOUNT' }, { type: 'service', name: 'ACCOUNT_VERIFIER' }, { type: 'secrets_store_secret', name: 'SGX_SPACE_RECOVERY_KEY' }, { type: 'service', name: 'AI_SERVICE' }];
  assert.equal(checkFloor(v(after), gw).ok, true);
  /* v5 收尾：还绑着临时钥匙 pepper 的版本（删绑定之前）照样合格 */
  assert.equal(checkFloor(v([...after, { type: 'secrets_store_secret', name: 'SGX_SPACE_TEMPKEY_PEPPER' }]), gw).ok, true);
  /* P4-2b：P4-1 之前（没有 AI_SERVICE）的网关版本不再是合格的回滚目标 */
  assert.match(checkFloor(v(after.filter((b) => b.name !== 'AI_SERVICE')), gw).reason, /missing binding\(s\) AI_SERVICE$/);
  const before = [{ type: 'd1', name: 'D1_SPACE' }, { type: 'd1', name: 'D1_ACCOUNT_AUTH' }, { type: 'd1', name: 'D1_ROOT_AUTH' }, { type: 'secrets_store_secret', name: 'SGX_ROOT_KEY' }];
  assert.match(checkFloor(v(before), gw).reason, /missing binding\(s\) ACCOUNT, AI_SERVICE$/);
  /* v6 P4：不再要求 SGX_SPACE_RECOVERY_KEY（进站签发删除，本 Worker 不绑 Secrets Store）：不带它的版本绑定名上合格（版本时间另由 notBefore 管） */
  assert.equal(checkFloor(v(after.filter((b) => b.name !== 'SGX_SPACE_RECOVERY_KEY')), gw).ok, true);
  /* 进站 v3 L3：L2b 切库之前（D1_SPACE 指向已删的旧库）的版本绑定齐全也不合格 */
  assert.match(checkFloor(v(after), full).reason, /^created /);
  const at = (iso) => JSON.stringify({ id: V1, metadata: { created_on: iso }, resources: { bindings: after } });
  assert.equal(checkFloor(at('2026-11-09T04:15:59Z'), full).ok, false);
  /* v5 删临时钥匙（#387）：L2b 之后、0002 迁移之前的版本也不合格 */
  assert.equal(checkFloor(at('2026-11-09T04:22:00Z'), full).ok, false);
  assert.equal(checkFloor(at('2026-11-10T13:34:00Z'), full).ok, false);
  assert.equal(checkFloor(at('2026-11-10T13:36:00Z'), full).ok, true);
});

test('回滚下限：checkFloor 缺绑定 / 太早 / 坏 JSON → 不满足', () => {
  assert.equal(checkFloor(details(['D1_SPACE', 'D1_ACCOUNT_AUTH', 'X']), FLOORS.gw).ok, true);
  assert.match(checkFloor(details(['D1_SPACE']), FLOORS.gw).reason, /missing binding\(s\) D1_ACCOUNT_AUTH/);
  assert.equal(checkFloor(details([], '2026-10-27T23:59:59Z'), FLOORS.dated).ok, false);
  assert.equal(checkFloor(details([], '2026-10-28T00:00:00Z'), FLOORS.dated).ok, true);
  assert.equal(checkFloor('{oops', FLOORS.gw).ok, false);
  assert.equal(checkFloor('{}', FLOORS.gw).ok, false);
});

test('回滚下限：没有下限的 Worker 不查详情；查不到详情 → 不允许', () => {
  const f = fakeWranglerWithView([V1], {});
  assert.equal(versionAboveFloor(V1, { run: f.run, name: 'styrigx-chat', floors: FLOORS }).ok, true);
  assert.equal(f.calls.length, 0);
  assert.equal(versionAboveFloor(V1, { run: f.run, name: 'gw', floors: FLOORS }).ok, false);
});

test('worker-snapshot：线上版本低于下限（KV 时代）→ 记成空 + warning，这次失败不自动回滚', () => {
  const old = fakeWranglerWithView([V1], { [V1]: details(['KV_LOCK_DOOR', 'KV_ACCOUNT_LOGIN', 'D1_LOCK_RESET']) });
  const { r, out } = quiet(() => workerSnapshot({ run: old.run, name: 'gw', floors: FLOORS }));
  assert.equal(r, '');
  assert.match(out, /::warning::no rollback target recorded \(live version .* below rollback floor of gw: missing binding/);
  assert.match(out, /^version=$/m);
  const ok = fakeWranglerWithView([V1], { [V1]: details(['D1_SPACE', 'D1_ACCOUNT_AUTH']) });
  assert.equal(quiet(() => workerSnapshot({ run: ok.run, name: 'gw', floors: FLOORS })).r, V1);
});

test('worker-rollback：目标低于下限 → 退出码 1，不调 wrangler rollback', () => {
  const f = fakeWranglerWithView([V2], { [V1]: details(['KV_LOCK_DOOR']) });
  const { r, out } = quiet(() => workerRollback({ to: V1, run: f.run, name: 'gw', floors: FLOORS, wait: W }));
  assert.equal(r, 1);
  assert.match(out, /::error::not rolling back to/);
  assert.ok(!f.calls.some((c) => c[0] === 'rollback'));
  const g = fakeWranglerWithView([V2, V1], { [V1]: details(['D1_SPACE', 'D1_ACCOUNT_AUTH']) });
  assert.equal(quiet(() => workerRollback({ to: V1, run: g.run, name: 'gw', floors: FLOORS, wait: W })).r, 0);
  assert.ok(g.calls.some((c) => c[0] === 'rollback'));
});

test('worker-verify：新版本 100% → 0；还是旧版本 / 拿不到 → 1；第一次部署（没有 previous）只要有版本就行', () => {
  assert.equal(quiet(() => workerVerify({ previous: V1, run: fakeWrangler([V2]).run, wait: W })).r, 0);
  assert.equal(quiet(() => workerVerify({ previous: V1, run: fakeWrangler([V1]).run, wait: W })).r, 1);
  assert.equal(quiet(() => workerVerify({ previous: '', run: fakeWrangler([null]).run, wait: W })).r, 1);
  assert.equal(quiet(() => workerVerify({ previous: '', run: fakeWrangler([V2]).run, wait: W })).r, 0);
});

/** 假 Cloudflare API：GET 项目回 canonical 序列，POST rollback 记下 */
function fakeCf(/** @type {Array<string|null>} */ canon, { postOk = true } = {}) {
  const calls = [];
  let i = 0;
  const f = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push([init.method, url, init.headers.Authorization]);
    if (init.method === 'GET') {
      const c = canon[Math.min(i++, canon.length - 1)];
      return new Response(JSON.stringify({ success: true, result: { name: 'styrigx-space', canonical_deployment: c ? { id: c } : null } }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: postOk, result: {} }), { status: postOk ? 200 : 403 });
  };
  return { fetch: /** @type {any} */ (f), calls };
}

test('pages-snapshot / pages-rollback：记下 canonical；变了才 POST …/deployments/<id>/rollback 并核对', async () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct';
  process.env.CLOUDFLARE_API_TOKEN = 'tok';
  process.env.CF_API_BASE = 'https://cf.test/client/v4';
  try {
    const D1 = 'aaaaaaaa-1111', D2 = 'bbbbbbbb-2222';
    assert.equal((await quiet(() => pagesSnapshot({ project: 'styrigx-space', fetch: fakeCf([D1]).fetch }))).r, D1);
    assert.equal((await quiet(() => pagesSnapshot({ project: 'styrigx-space', fetch: fakeCf([null]).fetch }))).r, '');

    const same = fakeCf([D1]);
    assert.equal((await quiet(() => pagesRollback({ project: 'styrigx-space', to: D1, fetch: same.fetch }))).r, 0);
    assert.ok(!same.calls.some((c) => c[0] === 'POST'));

    const moved = fakeCf([D2, D1]);
    const sleep = async () => {};
    assert.equal((await quiet(() => pagesRollback({ project: 'styrigx-space', to: D1, fetch: moved.fetch, sleep }))).r, 0);
    const post = moved.calls.find((c) => c[0] === 'POST');
    assert.equal(post[1], 'https://cf.test/client/v4/accounts/acct/pages/projects/styrigx-space/deployments/' + D1 + '/rollback');
    assert.equal(post[2], 'Bearer tok');

    assert.equal((await quiet(() => pagesRollback({ project: 'styrigx-space', to: D1, fetch: fakeCf([D2], { postOk: false }).fetch, sleep }))).r, 1);
    assert.equal((await quiet(() => pagesRollback({ project: 'styrigx-space', to: D1, fetch: fakeCf([D2, D2]).fetch, sleep }))).r, 1);
    await assert.rejects(() => pagesRollback({ project: '../x', to: D1, fetch: fakeCf([D2]).fetch, sleep }));
  } finally {
    delete process.env.CLOUDFLARE_ACCOUNT_ID; delete process.env.CLOUDFLARE_API_TOKEN; delete process.env.CF_API_BASE;
  }
});

test('GITHUB_OUTPUT：worker-snapshot 写 version=<id>', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sgx-rb-'));
  const out = path.join(dir, 'out');
  const w = process.stdout.write;
  process.stdout.write = () => true;
  process.env.GITHUB_OUTPUT = out;
  try { workerSnapshot({ run: fakeWrangler([V1]).run }); } finally { process.stdout.write = w; delete process.env.GITHUB_OUTPUT; }
  assert.equal(readFileSync(out, 'utf8'), 'version=' + V1 + '\n');
});

/* ---------- deploy.yml 接线 ---------- */

const wf = yaml.load(readFileSync(path.join(REPO, '.github/workflows/deploy.yml'), 'utf8'));
const WORKER_JOBS = {
  /* P4-2b：search-index、chat 退役，ai 接过索引上传（2026-11-05 起环境 / token 为 STYRIGX_AI_DEPLOY） */
  'deploy-ai-worker': { dir: 'workers/ai', secret: 'STYRIGX_AI_DEPLOY', internal: true },
  'deploy-status-worker': { dir: 'workers/status', secret: 'STYRIGX_STATUS_DEPLOY', internal: true },
  'deploy-proxy-rules-worker': { dir: 'workers/proxy-rules', secret: 'STYRIGX_PROXY_RULES_DEPLOY', internal: false },
  'deploy-space-core': { dir: 'workers/space-core', secret: 'STYRIGX_SPACE_CORE_DEPLOY', internal: false },
  'deploy-account-worker': { dir: 'workers/account', secret: 'STYRIGX_ACCOUNT_DEPLOY', internal: false },
  /* 合并 PR3：两个子站接口 Worker 从 styrigx-atlas 接过来部署（GitHub 环境 / 环境密钥已建好，名字同 token） */
  'deploy-curio-core': { dir: 'workers/curio-core', secret: 'STYRIGX_CURIO_CORE_DEPLOY', internal: false },
  'deploy-daymark-core': { dir: 'workers/daymark-core', secret: 'STYRIGX_DAYMARK_CORE_DEPLOY', internal: false },
};
const isDeploy = (/** @type {any} */ st) => st.uses && String(st.uses).startsWith('cloudflare/wrangler-action') && /^deploy\b/.test(String(st.with && st.with.command));

test('deploy.yml：7 个 Worker job 都是「记线上版本 → 部署 → (核对) → 失败回滚」，token 同部署那一步', () => {
  for (const [name, cfg] of Object.entries(WORKER_JOBS)) {
    const steps = wf.jobs[name].steps;
    const snap = steps.findIndex((s) => s.id === 'live');
    const firstDeploy = steps.findIndex(isDeploy);
    assert.ok(snap >= 0 && snap < firstDeploy, name + ': snapshot before deploy');
    const sn = steps[snap];
    assert.equal(sn['continue-on-error'], true, name + ': snapshot never blocks the deploy');
    assert.equal(sn['working-directory'], cfg.dir, name);
    assert.match(sn.run, /deploy-rollback\.mjs" worker-snapshot$/, name);
    const last = steps[steps.length - 1];
    assert.equal(last.if, "failure() && steps.live.outputs.version != ''", name + ': rollback is the last step, only on failure');
    assert.match(last.run, /worker-rollback --to "\$PREVIOUS"$/, name);
    assert.equal(last.env.PREVIOUS, '${{ steps.live.outputs.version }}', name);
    assert.equal(last['working-directory'], cfg.dir, name);
    for (const st of [sn, last]) {
      assert.equal(st.env.CLOUDFLARE_API_TOKEN, '${{ secrets.' + cfg.secret + ' }}', name + ': same token as deploy');
      assert.equal(st.env.CLOUDFLARE_ACCOUNT_ID, '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}', name);
    }
    for (const d of steps.filter(isDeploy)) assert.equal(d.with.apiToken, '${{ secrets.' + cfg.secret + ' }}', name + ': deploy token');
    const verify = steps.findIndex((s) => typeof s.run === 'string' && s.run.includes('worker-verify'));
    if (cfg.internal) {
      assert.ok(verify > firstDeploy && verify < steps.length - 1, name + ': internal Worker gets a post-deploy check');
      assert.equal(steps[verify].env.PREVIOUS, '${{ steps.live.outputs.version }}', name);
    } else {
      assert.ok(steps.some((s) => /^Smoke test/.test(s.name)), name + ': public Worker keeps its HTTP smoke test');
    }
  }
});

test('deploy.yml：Pages 记 canonical deployment → 部署 → 冒烟（含首页构建号）→ 失败回滚', () => {
  const steps = wf.jobs['build-and-deploy'].steps;
  const snap = steps.findIndex((s) => s.id === 'live');
  const dep = steps.findIndex((s) => s.name === 'Deploy to Cloudflare Pages');
  assert.ok(snap >= 0 && snap === dep - 1);
  assert.equal(steps[snap]['continue-on-error'], true);
  assert.match(steps[snap].run, /pages-snapshot --project styrigx-space$/);
  const smoke = steps.find((s) => /^Smoke test Pages/.test(s.name));
  assert.match(smoke.run, /data-sgx-build=/);
  const last = steps[steps.length - 1];
  assert.equal(last.if, "failure() && steps.live.outputs.deployment != ''");
  assert.match(last.run, /pages-rollback --project styrigx-space --to "\$PREVIOUS"$/);
  for (const st of [steps[snap], last]) assert.equal(st.env.CLOUDFLARE_API_TOKEN, '${{ secrets.STYRIGX_SPACE_PAGES_DEPLOY }}');
});

test('deploy.yml：回滚不加新 secret（只用各 job 原有的部署 token 和 CLOUDFLARE_ACCOUNT_ID）', () => {
  /* STYRIGX_AI_DEPLOY：deploy-ai-worker 的部署 token（2026-11-05 由 STYRIGX_SEARCH_INDEX_DEPLOY 拆出改名，Cloudflare 上 styrigx-ai-deploy） */
  const allowed = new Set(['CLOUDFLARE_ACCOUNT_ID', 'STYRIGX_SPACE_PAGES_DEPLOY', 'STYRIGX_AI_DEPLOY', ...Object.values(WORKER_JOBS).map((c) => c.secret)]);
  const used = new Set([...readFileSync(path.join(REPO, '.github/workflows/deploy.yml'), 'utf8').matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]));
  for (const s of used) assert.ok(allowed.has(s), 'unexpected secret ' + s);
});

test('deploy.yml：部署顺序 ai → status → 账号 → styrigx-space-core → 奇趣 / 日刻接口 Worker → Pages（进站 v3 L2：短链 job 删了，并进 space-core）', () => {
  const needs = (/** @type {string} */ j) => [].concat(wf.jobs[j].needs || []);
  for (const n of ['deploy-ai-worker', 'deploy-status-worker']) assert.ok(needs('deploy-account-worker').includes(n), n);
  for (const j of Object.keys(wf.jobs)) assert.ok(!/search-worker|chat-worker|share-worker|auth-worker/.test(j) && !needs(j).some((n) => /search-worker|chat-worker|share-worker|auth-worker/.test(n)), j + '：没有 search / chat / share / auth-gateway 的 job');
  assert.ok(!needs('deploy-account-worker').includes('deploy-space-core'));
  /* space-core：ai、status、账号之后（服务绑定指向它们）；Pages 等 space-core 和两个子站接口 Worker */
  for (const n of ['deploy-ai-worker', 'deploy-status-worker', 'deploy-account-worker']) assert.ok(needs('deploy-space-core').includes(n), n);
  for (const n of ['deploy-space-core', 'deploy-curio-core', 'deploy-daymark-core']) assert.ok(needs('build-and-deploy').includes(n), n);
  assert.equal(wf.jobs['deploy-space-core'].environment, 'STYRIGX_SPACE_CORE_DEPLOY');
  /* space-core 自己跑迁移（进站 v3 L2b：一个绑定 D1_SPACE、一份基线），在部署之前；没有 D1_SHARE_LINK 了 */
  const core = wf.jobs['deploy-space-core'].steps;
  const migs = core.map((st, k) => [st, k]).filter(([st]) => st.with && /^d1 migrations apply D1_[A-Z_]+ --remote$/.test(String(st.with.command)));
  assert.deepEqual(migs.map(([st]) => st.with.command), ['d1 migrations apply D1_SPACE --remote']);
  for (const [, k] of migs) assert.ok(k < core.findIndex(isDeploy));
  /* 进站 v3 L3：旧 Worker、旧库已删，一次性的路由接管（route-takeover.mjs）和 resync / switched 步骤去掉；部署后只读核对路由（verify-core-routes.mjs） */
  const idx = (re) => core.findIndex((st) => typeof st.run === 'string' && re.test(st.run));
  assert.equal(idx(/route-takeover|d1-cutover|wrangler\.noroutes\.toml/), -1, '没有路由接管 / 搬迁步骤');
  const ver = idx(/verify-core-routes\.mjs$/);
  assert.ok(ver > core.findIndex(isDeploy), 'verify 在部署之后');
  assert.equal(core[ver].if, undefined);
  assert.equal(core[ver].env.CLOUDFLARE_API_TOKEN, '${{ secrets.STYRIGX_SPACE_CORE_DEPLOY }}');
  assert.ok(!Object.keys(wf.jobs).includes('d1-cutover-gate'), '没有搬迁闸门 job');
  for (const j of Object.keys(wf.jobs)) assert.ok(!needs(j).includes('d1-cutover-gate') && !/d1-cutover-gate/.test(String(wf.jobs[j].if || '')), j);
  /* 两个子站接口 Worker：服务绑定 SPACE 指向 space-core，所以排在它之后 */
  for (const c of ['deploy-curio-core', 'deploy-daymark-core']) {
    assert.ok(needs(c).includes('deploy-status-worker'), c);
    assert.ok(needs(c).includes('deploy-space-core'), c);
    assert.equal(wf.jobs[c].environment, WORKER_JOBS[c].secret, c + ' environment = secret name');
    const steps = wf.jobs[c].steps;
    const mig = steps.findIndex((st) => st.with && /^d1 migrations apply styrigx-/.test(String(st.with.command)));
    assert.ok(mig >= 0 && mig < steps.findIndex(isDeploy), c + ': D1 migrations before deploy');
    const smoke = steps.find((st) => /^Smoke test/.test(st.name)).run;
    assert.match(smoke, new RegExp('https://styrigx\\.com/' + c.replace('deploy-', '').replace('-core', '') + '/api/'), c + ': smoke hits the main-domain route');
    assert.doesNotMatch(smoke, /atlas\.styrigx\.com/, c + ': P4-3 PR-1 起旧图志域名的过渡期路由已删，冒烟不再测它');
  }
  /* 网关冒烟：v5 S3 整站放开，子站页面没进站也 200 访客态（网关注入 locked 标记），不再 302 踢回锁屏；旧图志域名的 301 已于 P4-3 PR-1 删除，不再测 */
  const gw = wf.jobs['deploy-space-core'].steps.find((st) => /^Smoke test/.test(st.name)).run;
  assert.doesNotMatch(gw, /atlas\.styrigx\.com/);
  assert.doesNotMatch(gw, /why=no-cookie/);
  /* 页面与 _redirects 归 Pages：space-core 在 Pages 之前部署，它的冒烟不能查页面改动（2026-11-12 #419 因查 /status/、/wild/ 拿到旧 Pages 而回滚） */
  assert.doesNotMatch(gw, /check \/(status|wild)\//);
  const tree = wf.jobs['build-and-deploy'].steps.find((st) => /^Smoke test single tree/.test(st.name)).run;
  assert.match(tree, /for p in \/status\/ \/zh\/status\/; do visitor/, '状态页在 Pages 部署后按访客页查');
  assert.match(tree, /"\/wild\/ \/status\/" "\/zh\/wild\/ \/zh\/status\/"/, '2026-11-12：旷野删除，/wild/ 301 到 /status/（Pages 部署后查）');
  /* 网关冒烟：伪造身份头必须 401（或旧路由残留时账号默认 fetch 404），头像带账号运行时标记 */
  const smoke = wf.jobs['deploy-space-core'].steps.find((s) => /^Smoke test/.test(s.name)).run;
  assert.match(smoke, /X-Styrigx-Space-Session: 1/);
  assert.match(smoke, /forged \/api\/account/);
  assert.match(smoke, /\/avatar\/96\.webp/);
  assert.match(smoke, /"\$rt" = "account"/);
  /* v6 P4（定稿 v5.3 §十三）：分享短链删除，不再冒烟 /s/<码>；/api/share 不在访问表里，没会话照默认拒绝 401（space-core 回答） */
  assert.doesNotMatch(smoke, /\/s\/smoke/);
  assert.match(smoke, /check \/api\/share 401/);
});

test('worker-verify：部署后读数滞后（先读到旧版本，再读到新版本）→ 轮询后 0；一直是旧版本 → 读满次数后 1', () => {
  const f = fakeWrangler([V1, V1, V2]);
  assert.equal(quiet(() => workerVerify({ previous: V1, run: f.run, wait: W })).r, 0);
  assert.equal(f.calls.filter((c) => c[0] === 'deployments').length, 3);
  const g = fakeWrangler([V1]);
  const { r, out } = quiet(() => workerVerify({ previous: V1, run: g.run, wait: W }));
  assert.equal(r, 1);
  assert.equal(g.calls.filter((c) => c[0] === 'deployments').length, W.attempts);
  assert.match(out, /still the pre-deploy one/);
});

test('worker-rollback：回滚后读数滞后（先读到新版本，再读到目标）→ 0', () => {
  const f = fakeWrangler([V2, V2, V2, V1]);
  assert.equal(quiet(() => workerRollback({ to: V1, run: f.run, wait: W })).r, 0);
});

test('pollLive：每两次读之间按间隔 sleep，满足即停', () => {
  const slept = [];
  const f = fakeWrangler([V1, V2, V2]);
  const l = pollLive(f.run, (x) => x.versionId === V2, { attempts: 5, intervalMs: 7, sleep: (ms) => { slept.push(ms); } });
  assert.equal(l.versionId, V2);
  assert.deepEqual(slept, [7]);
});
