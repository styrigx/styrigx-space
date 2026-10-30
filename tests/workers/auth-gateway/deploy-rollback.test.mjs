/**
 * main 部署的自动回滚：scripts/deploy-rollback.mjs（记线上版本 / 部署后核对 / 回滚）和 deploy.yml 里的接线。
 * （放在 tests/workers/auth-gateway/ 下，同 kv-budget.test.mjs：CI 的单元测试 glob 已经包含这个目录。）
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
  workerSnapshot, workerVerify, workerRollback, pagesSnapshot, pagesRollback,
  workerNameFromToml, floorFor, checkFloor, versionAboveFloor,
} from '../../../scripts/deploy-rollback.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const V1 = '11111111-aaaa-4bbb-8ccc-000000000001';
const V2 = '22222222-aaaa-4bbb-8ccc-000000000002';
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
  assert.equal(quiet(() => workerRollback({ to: V1, run: f.run })).r, 0);
  assert.ok(!f.calls.some((c) => c[0] === 'rollback'));
});

test('worker-rollback：线上是新版本 → wrangler rollback <id> --message … --yes，再核对', () => {
  const f = fakeWrangler([V2, V1]);
  assert.equal(quiet(() => workerRollback({ to: V1, run: f.run, message: 'auto-rollback: test' })).r, 0);
  const rb = f.calls.find((c) => c[0] === 'rollback');
  assert.deepEqual(rb, ['rollback', V1, '--message', 'auto-rollback: test', '--yes']);
});

test('worker-rollback：rollback 失败 / 回滚后线上不是目标 → 退出码 1；目标不是 id → 1，不调 wrangler', () => {
  assert.equal(quiet(() => workerRollback({ to: V1, run: fakeWrangler([V2], 1).run })).r, 1);
  assert.equal(quiet(() => workerRollback({ to: V1, run: fakeWrangler([V2, V2]).run })).r, 1);
  const f = fakeWrangler([V2]);
  assert.equal(quiet(() => workerRollback({ to: '--force', run: f.run })).r, 1);
  assert.equal(f.calls.length, 0);
});

/** 版本详情（wrangler versions view --json） */
const details = (/** @type {string[]} */ names, created = '2026-10-28T02:00:00Z') => JSON.stringify({
  id: V1, metadata: { created_on: created }, resources: { bindings: names.map((name) => ({ type: 'd1', name })) },
});
const FLOORS = { 'gw': { requireBindings: ['D1_LOCK_AUTH', 'D1_ACCOUNT_AUTH'] }, 'dated': { notBefore: '2026-10-28T00:00:00Z' } };
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

test('回滚下限：floor 文件里网关和账号 Worker 都要求 D1 绑定，且名字和 wrangler.toml 对得上', () => {
  const gwToml = readFileSync(path.join(REPO, 'workers/auth-gateway/wrangler.toml'), 'utf8');
  const acToml = readFileSync(path.join(REPO, 'workers/account/wrangler.toml'), 'utf8');
  const gw = floorFor(workerNameFromToml(gwToml));
  const ac = floorFor(workerNameFromToml(acToml));
  /* 账号拆分 PR3：网关要有转发绑定 ACCOUNT 和新名 SGX_ADMIN_KEY，账号要有账号库 D1_ACCOUNT_AUTH（自动回滚不退过拆分点） */
  assert.deepEqual(gw && gw.requireBindings, ['D1_LOCK_AUTH', 'ACCOUNT', 'SGX_ADMIN_KEY']);
  assert.deepEqual(ac && ac.requireBindings, ['D1_ACCOUNT_AUTH', 'D1_SETTINGS_SYNC']);
  // 要求的绑定当前 wrangler.toml 里确实有（否则每次部署都记不到目标）
  for (const [toml, f] of [[gwToml, gw], [acToml, ac]]) {
    for (const n of /** @type {any} */ (f).requireBindings) assert.match(toml, new RegExp('^binding = "' + n + '"$', 'm'));
  }
  assert.equal(floorFor('styrigx-chat'), null);
  assert.equal(floorFor('$comment'), null);
});

test('回滚下限：bindings 里的服务绑定 / Secrets Store 绑定也按名字认（拆分前的网关版本没有 ACCOUNT、绑的是旧名 → 不满足）', () => {
  const gw = floorFor('styrigx-auth-gateway');
  const v = (list) => JSON.stringify({ id: V1, metadata: { created_on: 'Fri 2026-10-30 8:00 AM CST (UTC+08:00)' }, resources: { bindings: list } });
  const after = [{ type: 'd1', name: 'D1_LOCK_AUTH' }, { type: 'service', name: 'ACCOUNT' }, { type: 'service', name: 'ACCOUNT_VERIFIER' }, { type: 'secrets_store_secret', name: 'SGX_ADMIN_KEY' }];
  assert.equal(checkFloor(v(after), gw).ok, true);
  const before = [{ type: 'd1', name: 'D1_LOCK_AUTH' }, { type: 'd1', name: 'D1_ACCOUNT_AUTH' }, { type: 'd1', name: 'D1_ROOT_AUTH' }, { type: 'secrets_store_secret', name: 'SGX_ROOT_KEY' }];
  assert.match(checkFloor(v(before), gw).reason, /missing binding\(s\) ACCOUNT, SGX_ADMIN_KEY/);
});

test('回滚下限：checkFloor 缺绑定 / 太早 / 坏 JSON → 不满足', () => {
  assert.equal(checkFloor(details(['D1_LOCK_AUTH', 'D1_ACCOUNT_AUTH', 'X']), FLOORS.gw).ok, true);
  assert.match(checkFloor(details(['D1_LOCK_AUTH']), FLOORS.gw).reason, /missing binding\(s\) D1_ACCOUNT_AUTH/);
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
  const ok = fakeWranglerWithView([V1], { [V1]: details(['D1_LOCK_AUTH', 'D1_ACCOUNT_AUTH']) });
  assert.equal(quiet(() => workerSnapshot({ run: ok.run, name: 'gw', floors: FLOORS })).r, V1);
});

test('worker-rollback：目标低于下限 → 退出码 1，不调 wrangler rollback', () => {
  const f = fakeWranglerWithView([V2], { [V1]: details(['KV_LOCK_DOOR']) });
  const { r, out } = quiet(() => workerRollback({ to: V1, run: f.run, name: 'gw', floors: FLOORS }));
  assert.equal(r, 1);
  assert.match(out, /::error::not rolling back to/);
  assert.ok(!f.calls.some((c) => c[0] === 'rollback'));
  const g = fakeWranglerWithView([V2, V1], { [V1]: details(['D1_LOCK_AUTH', 'D1_ACCOUNT_AUTH']) });
  assert.equal(quiet(() => workerRollback({ to: V1, run: g.run, name: 'gw', floors: FLOORS })).r, 0);
  assert.ok(g.calls.some((c) => c[0] === 'rollback'));
});

test('worker-verify：新版本 100% → 0；还是旧版本 / 拿不到 → 1；第一次部署（没有 previous）只要有版本就行', () => {
  assert.equal(quiet(() => workerVerify({ previous: V1, run: fakeWrangler([V2]).run })).r, 0);
  assert.equal(quiet(() => workerVerify({ previous: V1, run: fakeWrangler([V1]).run })).r, 1);
  assert.equal(quiet(() => workerVerify({ previous: '', run: fakeWrangler([null]).run })).r, 1);
  assert.equal(quiet(() => workerVerify({ previous: '', run: fakeWrangler([V2]).run })).r, 0);
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
  'deploy-search-worker': { dir: 'workers/search-index', secret: 'STYRIGX_SEARCH_INDEX_DEPLOY', internal: true },
  'deploy-status-worker': { dir: 'workers/status', secret: 'STYRIGX_STATUS_DEPLOY', internal: true },
  'deploy-chat-worker': { dir: 'workers/chat', secret: 'STYRIGX_CHAT_DEPLOY', internal: true },
  'deploy-proxy-rules-worker': { dir: 'workers/proxy-rules', secret: 'STYRIGX_PROXY_RULES_DEPLOY', internal: false },
  'deploy-auth-worker': { dir: 'workers/auth-gateway', secret: 'STYRIGX_AUTH_GATEWAY_DEPLOY', internal: false },
  'deploy-account-worker': { dir: 'workers/account', secret: 'STYRIGX_ACCOUNT_DEPLOY', internal: false },
  'deploy-share-worker': { dir: 'workers/share', secret: 'STYRIGX_SHARE_DEPLOY', internal: false },
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
  const allowed = new Set(['CLOUDFLARE_ACCOUNT_ID', 'STYRIGX_SPACE_PAGES_DEPLOY', ...Object.values(WORKER_JOBS).map((c) => c.secret)]);
  const used = new Set([...readFileSync(path.join(REPO, '.github/workflows/deploy.yml'), 'utf8').matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]));
  for (const s of used) assert.ok(allowed.has(s), 'unexpected secret ' + s);
});

test('deploy.yml：账号拆分 PR3 部署顺序 账号 → 短链 → 网关 → Pages（网关部署时短链已改问账号 Worker，没有 401 窗口）', () => {
  const needs = (/** @type {string} */ j) => [].concat(wf.jobs[j].needs || []);
  /* 账号最先：和网关一样等 status 的健康闸门，但不等网关 */
  for (const n of ['deploy-search-worker', 'deploy-status-worker', 'deploy-chat-worker']) assert.ok(needs('deploy-account-worker').includes(n), n);
  assert.ok(!needs('deploy-account-worker').includes('deploy-auth-worker'));
  /* 短链：账号之后（ACCOUNT_VERIFIER 指向它）、网关之前 */
  assert.ok(needs('deploy-share-worker').includes('deploy-account-worker'));
  assert.ok(needs('deploy-share-worker').includes('deploy-status-worker'));
  assert.ok(!needs('deploy-share-worker').includes('deploy-auth-worker'));
  /* 网关：账号、短链都在之后才部署；Pages 等网关 */
  assert.ok(needs('deploy-auth-worker').includes('deploy-account-worker'));
  assert.ok(needs('deploy-auth-worker').includes('deploy-share-worker'));
  assert.ok(needs('build-and-deploy').includes('deploy-auth-worker'));
  /* 网关冒烟：伪造身份头必须 401（或旧路由残留时账号默认 fetch 404），头像带账号运行时标记 */
  const smoke = wf.jobs['deploy-auth-worker'].steps.find((s) => /^Smoke test/.test(s.name)).run;
  assert.match(smoke, /X-Styrigx-Lock-Role: admin/);
  assert.match(smoke, /forged \/api\/account/);
  assert.match(smoke, /\/avatar\/96\.webp/);
  assert.match(smoke, /"\$rt" = "account"/);
});
