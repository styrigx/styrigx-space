#!/usr/bin/env node
/**
 * @fileoverview passkey-e2e 的预览状态：清预览 D1（只清会干扰本次运行的表）+ 每次运行的用量估算。
 *
 * 2026-10-27 起网关的认证状态全部在 D1（正式 styrigx-auth-gateway；预览 2026-10-29 起是测试专用库 styrigx-test-preview），不再绑定 KV（以前这里按键清预览 KV，
 * 因为免费计划的 KV 写 / 删 / 列各 1000 次 / 天、全账号共用，2026-10-25 四次 passkey-e2e 用掉了约 84%）。
 * 文件名沿用（CI 和文档都按这个名字引用）。
 *
 * 用法（CI 的 passkey-e2e job；本地可配 CF_API_BASE 指向 tests/web/e2e/preview-emulator.cjs）：
 *   node scripts/kv-budget.mjs reset-preview   清预览 D1 的 RESET_D1_TABLES（库 id 从 web/wrangler.toml 读，见 previewD1Id）
 *   node scripts/kv-budget.mjs estimate        打印每次运行的估算
 * 环境变量：CF_ACCOUNT_ID、CF_API_TOKEN（要 D1 编辑）；CF_API_BASE（默认 https://api.cloudflare.com/client/v4）。
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { REALM_LOCK } from '../workers/auth-gateway/functions/_kernel/realms.js';

/**
 * 一次 passkey-e2e 运行的用量估算（上限）。KV：网关和测试都不再碰 KV，全为 0。
 * D1：tests/web/e2e/preview-emulator.cjs 量（/__kv/stats 的 d1 一栏，按语句数），真实预览留余量。
 */
export const PER_RUN_ESTIMATE = Object.freeze({ read: 0, write: 0, delete: 0, list: 0, d1Statements: 2500 });

/* ---------- 清预览 D1 ---------- */

/**
 * 清哪些表：会改变本次运行起始状态的（d1-state.js / attempt-limit.js）。
 * - passkey、password：锁屏 / 账号「是否已设置」（layers.js 由它们推出）；不清的话 root-auth 的 lock-reset / account-reset 入口会变成假入口
 * - attempt_limit：按 IP 的失败计数 / 冷却，会直接让本次运行 429（root-auth 连错锁 15 分钟、密码冷却）
 * 不清的表，以及为什么不影响本次运行：
 * - epoch：只和会话 / 票里写的纪元比较。上一次运行的会话和票都是上一次现生成的 Ed25519 私钥签的，这次换了钥匙对，验签先失败；
 *   这次的会话按当前值签发。用例只断言「+1」这种相对变化。
 * - user_handle：注册通行密钥时给认证器的随机 user handle，生产上第一次注册之后也一直复用；虚拟认证器每个用例新建，没有旧凭据。
 * - audit：只追加的审计（7 天后不认），只有 /api/root-audit 读，passkey 组不测它。
 * - challenge：一次性随机 cid（5 分钟后不认），新运行拿不到旧 cid。
 * - tempkey、device：passkey 组不创建临时钥匙，也不做成功的账号登录；都有 expires_at。
 * - lock_reset_switch（旧表 recovery_switch 网关已不读写）：签过票的行标了已用，永不再生效；用例要用时插一行新的（preview-helpers.cjs armResetSwitch）。
 * - kv_migration：只有导入脚本写，运行时不读。
 */
export const RESET_D1_TABLES = Object.freeze(['passkey', 'password', 'attempt_limit']);

/**
 * 从 wrangler.toml 文本里取 binding 对应的 database_id（[[...d1_databases]] 块）。
 * @param {string} toml @param {string} binding
 * @returns {string}
 */
export function d1DatabaseId(toml, binding) {
  for (const block of String(toml).split(/\n(?=\[\[)/)) {
    if (!/^\[\[(?:env\.preview\.)?d1_databases\]\]/.test(block)) continue;
    const b = block.match(/^binding = "([A-Z0-9_]+)"/m);
    const id = block.match(/^database_id = "([0-9a-f-]+)"/m);
    if (b && id && b[1] === binding) return id[1];
  }
  return '';
}

/**
 * 预览 D1 的库 id：web/wrangler.toml [env.preview] 的 D1_LOCK_AUTH，并断言它不是正式网关的库。
 * @param {string} repo 仓库根目录
 */
export function previewD1Id(repo) {
  const pv = d1DatabaseId(readFileSync(repo + '/web/wrangler.toml', 'utf8'), REALM_LOCK.d1Binding);
  const prod = d1DatabaseId(readFileSync(repo + '/workers/auth-gateway/wrangler.toml', 'utf8'), REALM_LOCK.d1Binding);
  if (!pv || !prod || pv === prod) throw new Error('preview D1 id missing or equal to the production gateway D1');
  return pv;
}

async function resetPreviewD1() {
  const account = need('CF_ACCOUNT_ID');
  const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/\/+$/, '');
  let id;
  try {
    id = previewD1Id(repo);
  } catch (e) {
    console.error('::error::' + e.message);
    process.exit(1);
  }
  let cleared = 0;
  for (const t of RESET_D1_TABLES) {
    const r = await cfFetch(`${apiBase()}/accounts/${account}/d1/database/${id}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'DELETE FROM ' + t }),
    });
    const msg = JSON.stringify((r.body && r.body.errors) || []);
    /* 第一次跑（迁移还没应用、表还没有）：没东西可清 */
    if (r.status !== 200 && /no such table/i.test(msg)) continue;
    if (r.status !== 200 || !r.body || !r.body.success) {
      console.error(`::error::D1 ${t} reset HTTP ${r.status} ${msg} (the token needs D1:Edit)`);
      process.exit(1);
    }
    const res = Array.isArray(r.body.result) ? r.body.result[0] : null;
    cleared += Number((res && res.meta && res.meta.changes) || 0);
  }
  console.log(`preview D1 reset: ${cleared} rows deleted from ${RESET_D1_TABLES.join(', ')}`);
}

/* ---------- CLI ---------- */

function apiBase() {
  return (process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
}

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`::error::${name} is not set`);
    process.exit(1);
  }
  return v;
}

async function cfFetch(url, init) {
  const token = need('CF_API_TOKEN');
  const r = await fetch(url, Object.assign({}, init, {
    headers: Object.assign({ Authorization: `Bearer ${token}` }, (init && init.headers) || {}),
    signal: AbortSignal.timeout(30000),
  }));
  let body = null;
  try { body = await r.json(); } catch (e) {}
  return { status: r.status, body };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, a1] = process.argv.slice(2);
  if (cmd === 'reset-preview') {
    if (a1) console.log('reset-preview: the KV namespace argument is ignored (the gateway no longer binds KV)');
    await resetPreviewD1();
  }
  else if (cmd === 'estimate') console.log(JSON.stringify({ perRun: PER_RUN_ESTIMATE }));
  else {
    console.error('usage: node scripts/kv-budget.mjs reset-preview | estimate');
    process.exit(2);
  }
}
