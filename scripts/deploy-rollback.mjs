#!/usr/bin/env node
/**
 * @fileoverview main 部署的自动回滚：部署前记下线上正在跑的版本，部署 / 冒烟失败就退回去。
 *
 * deploy.yml 里 Pages 和 7 个 Worker 的 job 都这样接：
 *   1. 部署前「Record live version」：记下线上的版本（Worker：当前 100% 流量的 version id；Pages：生产的 canonical deployment id）
 *      写进 $GITHUB_OUTPUT。第一次部署（Worker 还不存在 / Pages 还没有生产部署）记成空；记录失败（token、网络）也记成空、
 *      只打 warning、不拦部署——空 = 这次失败不自动回滚，和加这个功能之前一样。
 *   2. 部署 + 冒烟（原样）。
 *   3. 最后「Roll back on failure」：if: failure() 且第 1 步记到了版本。先看线上现在是不是已经是记下的那个
 *      （部署在上传阶段就失败了 → 线上没变 → 什么都不做）；不是就退回去，再查一遍确认线上就是记下的版本。job 照样红。
 *
 * 用法（工作目录 = Worker 目录，wrangler 读那里的 wrangler.toml 拿 Worker 名字）：
 *   node scripts/deploy-rollback.mjs worker-snapshot                记下线上版本 → $GITHUB_OUTPUT version=<id|空>
 *   node scripts/deploy-rollback.mjs worker-verify [--previous <id>] 部署后：线上是一个版本吃 100% 流量，且不是部署前那个
 *   node scripts/deploy-rollback.mjs worker-rollback --to <id>      线上不是 <id> 就 wrangler rollback <id>，再核对
 *   node scripts/deploy-rollback.mjs pages-snapshot --project <名字>  → $GITHUB_OUTPUT deployment=<id|空>
 *   node scripts/deploy-rollback.mjs pages-rollback --project <名字> --to <id>
 * 回滚下限（scripts/deploy-rollback-floor.json，按 Worker 名）：worker-snapshot 记下的版本必须满足下限（带齐要求的绑定、
 *   创建时间不早于 notBefore），否则记成空 = 这次失败不自动回滚；worker-rollback 动手前再查一遍。用来挡住「退回存储迁移之前的代码」。
 *   读版本详情用 `wrangler versions view <id> --json`（同一个 token，Workers Scripts 读）。
 * 环境变量：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID（同部署那一步的 token，不另加 secret）；
 *   WRANGLER_VERSION（workflow 顶层 env）；CF_API_BASE（默认 https://api.cloudflare.com/client/v4，测试用）。
 *
 * 需要的 token 权限（都是各 job 部署本来就有的，没有新增）：
 *   Worker：Workers Scripts 编辑（wrangler deployments status 读、wrangler rollback 写；带 Secrets Store 绑定的 Worker 同部署一样要 Secrets Store 编辑）。
 *   Pages：Cloudflare Pages 编辑（GET 项目读 canonical_deployment，POST .../deployments/<id>/rollback）。
 * 回滚只换代码版本，不回滚 D1 迁移、KV 里的数据（搜索索引）、Secrets Store、路由 / 自定义域名（wrangler 也这么提示）。
 * 本脚本不打印 token；日志里只有版本 id。
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_API = 'https://api.cloudflare.com/client/v4';
/** Pages 回滚后 canonical_deployment 切换前最多再查几次（每次隔 5 秒） */
const PAGES_CONFIRM_TRIES = 6;

/**
 * `wrangler deployments status --json` 的输出 → 线上 100% 流量的版本 id。
 * 灰度（不止一个版本 / 不是 100%）、格式不对 → null（不敢替它决定退到哪个）。
 * 输出前面可能混着 npm / wrangler 的提示行：从第一个 `{` 开始解析。
 * @param {string} text
 * @returns {{versionId: string|null, reason: string}}
 */
export function parseDeploymentStatus(text) {
  const s = String(text || '');
  const i = s.indexOf('{');
  if (i < 0) return { versionId: null, reason: 'no JSON in wrangler output' };
  let j;
  try { j = JSON.parse(s.slice(i)); } catch (e) { return { versionId: null, reason: 'wrangler output is not valid JSON' }; }
  const versions = j && Array.isArray(j.versions) ? j.versions : null;
  if (!versions || !versions.length) return { versionId: null, reason: 'deployment has no versions' };
  if (versions.length !== 1 || Number(versions[0].percentage) !== 100) {
    return { versionId: null, reason: 'gradual deployment (' + versions.map((v) => v.version_id + '@' + v.percentage + '%').join(', ') + '): not choosing a rollback target' };
  }
  const id = versions[0].version_id;
  if (typeof id !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(id)) return { versionId: null, reason: 'unexpected version id' };
  return { versionId: id, reason: 'ok' };
}

/**
 * Pages 项目（GET /accounts/<id>/pages/projects/<名字> 的 result）→ 生产当前的 deployment id；还没有生产部署 → null。
 * @param {any} project
 * @returns {string|null}
 */
export function pagesCanonicalId(project) {
  const d = project && project.canonical_deployment;
  return d && typeof d.id === 'string' && d.id ? d.id : null;
}

/** 版本 / 部署 id 只许十六进制和连字符（会拼进命令行和 URL） @param {string} id */
export function isSafeId(id) {
  return typeof id === 'string' && /^[0-9a-f-]{8,64}$/i.test(id);
}

/** @param {string} key @param {string} value */
function setOutput(key, value) {
  const line = key + '=' + value + '\n';
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  process.stdout.write(line);
}

/** @param {'notice'|'warning'|'error'} level @param {string} msg */
function annotate(level, msg) {
  process.stdout.write('::' + level + '::' + msg + '\n');
}

/**
 * 跑 wrangler（固定版本，同 workflow 的 WRANGLER_VERSION）。
 * @param {string[]} args
 * @returns {{status: number, stdout: string, stderr: string}}
 */
export function runWrangler(args) {
  const v = process.env.WRANGLER_VERSION;
  if (!v) throw new Error('WRANGLER_VERSION is not set');
  const r = spawnSync('npx', ['--yes', 'wrangler@' + v, ...args], { encoding: 'utf8', env: process.env });
  return { status: r.status == null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * 线上版本。拿不到 → versionId null + 原因（不抛）。
 * @param {(args: string[]) => {status:number, stdout:string, stderr:string}} run
 */
export function liveWorkerVersion(run) {
  const r = run(['deployments', 'status', '--json']);
  if (r.status !== 0) {
    const msg = (r.stderr + '\n' + r.stdout).split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ');
    return { versionId: null, reason: 'wrangler deployments status failed: ' + msg.slice(0, 300) };
  }
  return parseDeploymentStatus(r.stdout);
}

const FLOOR_FILE = fileURLToPath(new URL('./deploy-rollback-floor.json', import.meta.url));

/**
 * 当前目录 wrangler.toml 的 Worker 名（顶层 name = "..."，第一个 [表] 之前）。拿不到 → ''。
 * @param {string} toml
 */
export function workerNameFromToml(toml) {
  for (const line of String(toml || '').split('\n')) {
    const t = line.trim();
    if (t.startsWith('[')) break;
    const m = /^name\s*=\s*"([a-z0-9-]{1,63})"\s*(#.*)?$/.exec(t);
    if (m) return m[1];
  }
  return '';
}

/**
 * @param {string} name Worker 名
 * @param {any} [floors] 测试注入；默认读 deploy-rollback-floor.json
 * @returns {{requireBindings?: string[], notBefore?: string}|null}
 */
export function floorFor(name, floors) {
  const all = floors || JSON.parse(readFileSync(FLOOR_FILE, 'utf8'));
  const f = name && Object.prototype.hasOwnProperty.call(all, name) && !name.startsWith('$') ? all[name] : null;
  return f && typeof f === 'object' ? f : null;
}

/**
 * 版本详情（`wrangler versions view <id> --json` 的输出）是否满足下限。
 * @param {string} text
 * @param {{requireBindings?: string[], notBefore?: string}} floor
 * @returns {{ok: boolean, reason: string}}
 */
export function checkFloor(text, floor) {
  const s = String(text || '');
  const i = s.indexOf('{');
  let v;
  try { v = i < 0 ? null : JSON.parse(s.slice(i)); } catch (e) { v = null; }
  if (!v || typeof v !== 'object') return { ok: false, reason: 'version details are not valid JSON' };
  const req = Array.isArray(floor.requireBindings) ? floor.requireBindings : [];
  if (req.length) {
    const b = v.resources && Array.isArray(v.resources.bindings) ? v.resources.bindings : null;
    if (!b) return { ok: false, reason: 'version details have no bindings list' };
    const have = new Set(b.map((x) => x && x.name));
    const missing = req.filter((n) => !have.has(n));
    if (missing.length) return { ok: false, reason: 'missing binding(s) ' + missing.join(', ') };
  }
  if (floor.notBefore) {
    const lim = Date.parse(floor.notBefore);
    const at = Date.parse(v.metadata && v.metadata.created_on);
    if (!Number.isFinite(lim)) return { ok: false, reason: 'floor notBefore is not a date' };
    if (!Number.isFinite(at)) return { ok: false, reason: 'version has no created_on' };
    if (at < lim) return { ok: false, reason: 'created ' + new Date(at).toISOString() + ', before ' + new Date(lim).toISOString() };
  }
  return { ok: true, reason: 'ok' };
}

/**
 * 目标版本是否允许回滚过去。没有下限的 Worker → 允许。查不到详情 → 不允许（宁可不自动回滚）。
 * @param {string} versionId
 * @param {{run?: typeof runWrangler, name?: string, floors?: any}} [deps]
 */
export function versionAboveFloor(versionId, deps = {}) {
  const run = deps.run || runWrangler;
  let name = deps.name;
  if (name === undefined) {
    try { name = workerNameFromToml(readFileSync('wrangler.toml', 'utf8')); } catch (e) { name = ''; }
  }
  let floor;
  try { floor = floorFor(name || '', deps.floors); } catch (e) { return { ok: false, reason: 'cannot read rollback floor file' }; }
  if (!floor) return { ok: true, reason: 'no floor for ' + (name || '(unknown worker)') };
  const r = run(['versions', 'view', versionId, '--json']);
  if (r.status !== 0) return { ok: false, reason: 'wrangler versions view failed' };
  const c = checkFloor(r.stdout, floor);
  return { ok: c.ok, reason: c.ok ? 'meets rollback floor of ' + name : 'below rollback floor of ' + name + ': ' + c.reason };
}

/** @param {{run?: typeof runWrangler, name?: string, floors?: any}} [deps] */
export function workerSnapshot(deps = {}) {
  const live = liveWorkerVersion(deps.run || runWrangler);
  let id = live.versionId || '';
  let reason = live.reason;
  if (id) {
    const f = versionAboveFloor(id, deps);
    if (!f.ok) { reason = 'live version ' + id + ' is ' + f.reason; id = ''; }
  }
  if (!id) annotate('warning', 'no rollback target recorded (' + reason + '); if this deploy fails it will NOT be rolled back automatically');
  else annotate('notice', 'live version before deploy: ' + id);
  setOutput('version', id);
  return id;
}

/**
 * 部署后核对（没有公开地址、冒烟打不到的 Worker 用：search / status / chat）：
 * 线上是一个版本吃 100% 流量；记过部署前版本的话，现在的必须不是它（确实换上了新版本）。
 * @param {{previous?: string, run?: typeof runWrangler}} opts
 */
export function workerVerify(opts) {
  const live = liveWorkerVersion(opts.run || runWrangler);
  if (!live.versionId) { annotate('error', 'post-deploy check: ' + live.reason); return 1; }
  if (opts.previous && live.versionId === opts.previous) {
    annotate('error', 'post-deploy check: live version is still the pre-deploy one (' + live.versionId + ')');
    return 1;
  }
  annotate('notice', 'post-deploy check: live version ' + live.versionId + ' at 100%');
  return 0;
}

/**
 * @param {{to: string, run?: typeof runWrangler, message?: string, name?: string, floors?: any}} opts
 * @returns {number} exit code
 */
export function workerRollback(opts) {
  const run = opts.run || runWrangler;
  if (!isSafeId(opts.to)) { annotate('error', 'rollback target is not a version id'); return 1; }
  const before = liveWorkerVersion(run);
  if (before.versionId === opts.to) {
    annotate('notice', 'live version is already ' + opts.to + ' (the deploy did not change production): nothing to roll back');
    return 0;
  }
  const f = versionAboveFloor(opts.to, { run, name: opts.name, floors: opts.floors });
  if (!f.ok) {
    annotate('error', 'not rolling back to ' + opts.to + ': ' + f.reason + '. Production stays on the new version; fix forward or revert and redeploy');
    return 1;
  }
  annotate('warning', 'rolling back to ' + opts.to + ' (live: ' + (before.versionId || before.reason) + ')');
  const msg = (opts.message || 'auto-rollback').slice(0, 120);
  const r = run(['rollback', opts.to, '--message', msg, '--yes']);
  process.stdout.write(r.stdout);
  if (r.status !== 0) {
    process.stdout.write(r.stderr);
    annotate('error', 'wrangler rollback failed; production may still run the new version. Roll back by hand: wrangler rollback ' + opts.to);
    return 1;
  }
  const after = liveWorkerVersion(run);
  if (after.versionId !== opts.to) {
    annotate('error', 'after rollback the live version is ' + (after.versionId || after.reason) + ', expected ' + opts.to);
    return 1;
  }
  annotate('warning', 'rolled back: live version is ' + opts.to + ' again');
  return 0;
}

/**
 * Cloudflare API（Pages）。不抛：返回 { ok, result, status }。
 * @param {string} method @param {string} path
 * @param {{fetch?: typeof fetch}} [deps]
 */
async function cfApi(method, path, deps = {}) {
  const f = deps.fetch || fetch;
  const base = process.env.CF_API_BASE || DEFAULT_API;
  const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!acct || !token) return { ok: false, status: 0, result: null, reason: 'CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set' };
  try {
    const res = await f(base + '/accounts/' + encodeURIComponent(acct) + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    let j = null;
    try { j = await res.json(); } catch (e) {}
    const ok = res.ok && !!j && j.success === true;
    return { ok, status: res.status, result: j ? j.result : null, reason: ok ? 'ok' : 'HTTP ' + res.status };
  } catch (e) {
    return { ok: false, status: 0, result: null, reason: 'request failed: ' + (e && /** @type {any} */ (e).name) };
  }
}

/** @param {string} project */
function projectPath(project) {
  if (!/^[a-z0-9-]{1,58}$/.test(project)) throw new Error('bad Pages project name');
  return '/pages/projects/' + project;
}

/** @param {{project: string, fetch?: typeof fetch}} opts */
export async function pagesSnapshot(opts) {
  const r = await cfApi('GET', projectPath(opts.project), opts);
  const id = r.ok ? pagesCanonicalId(r.result) : null;
  if (!id) annotate('warning', 'no Pages rollback target recorded (' + (r.ok ? 'no production deployment yet' : r.reason) + '); if this deploy fails it will NOT be rolled back automatically');
  else annotate('notice', 'live Pages production deployment before deploy: ' + id);
  setOutput('deployment', id || '');
  return id || '';
}

/**
 * @param {{project: string, to: string, fetch?: typeof fetch, sleep?: (ms:number) => Promise<void>}} opts
 * @returns {Promise<number>} exit code
 */
export async function pagesRollback(opts) {
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  if (!isSafeId(opts.to)) { annotate('error', 'rollback target is not a deployment id'); return 1; }
  const p = projectPath(opts.project);
  const now = await cfApi('GET', p, opts);
  const live = now.ok ? pagesCanonicalId(now.result) : null;
  if (live === opts.to) {
    annotate('notice', 'Pages production is already ' + opts.to + ' (the deploy did not change production): nothing to roll back');
    return 0;
  }
  annotate('warning', 'rolling back Pages production to ' + opts.to + ' (live: ' + (live || now.reason) + ')');
  const rb = await cfApi('POST', p + '/deployments/' + opts.to + '/rollback', opts);
  if (!rb.ok) {
    annotate('error', 'Pages rollback API failed (' + rb.reason + '); roll back by hand in the dashboard (Deployments → ' + opts.to + ' → Rollback)');
    return 1;
  }
  for (let i = 0; i < PAGES_CONFIRM_TRIES; i++) {
    const chk = await cfApi('GET', p, opts);
    if (chk.ok && pagesCanonicalId(chk.result) === opts.to) {
      annotate('warning', 'rolled back: Pages production is ' + opts.to + ' again');
      return 0;
    }
    await sleep(5000);
  }
  annotate('error', 'Pages rollback requested but production is not ' + opts.to + ' yet; check the dashboard');
  return 1;
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error('unexpected argument ' + a);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(a + ' needs a value');
    o[a.slice(2)] = v;
    i++;
  }
  return o;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  const sha = (process.env.GITHUB_SHA || '').slice(0, 7);
  const message = 'auto-rollback: deploy of ' + (sha || 'this commit') + ' failed its post-deploy check (run ' + (process.env.GITHUB_RUN_ID || '?') + ')';
  switch (cmd) {
    case 'worker-snapshot': workerSnapshot(); return 0;
    case 'worker-verify': return workerVerify({ previous: a.previous || '' });
    case 'worker-rollback': return workerRollback({ to: a.to || '', message });
    case 'pages-snapshot': await pagesSnapshot({ project: a.project || '' }); return 0;
    case 'pages-rollback': return pagesRollback({ project: a.project || '', to: a.to || '' });
    default:
      process.stderr.write('usage: deploy-rollback.mjs worker-snapshot | worker-verify [--previous id] | worker-rollback --to id | pages-snapshot --project name | pages-rollback --project name --to id\n');
      return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    /* 快照出错不拦部署（调用方 continue-on-error）；只打一行，不打堆栈 */
    annotate('error', 'deploy-rollback: ' + (e && /** @type {any} */ (e).message));
    process.exitCode = 1;
  });
}
