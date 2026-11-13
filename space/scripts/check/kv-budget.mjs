#!/usr/bin/env node
/**
 * @fileoverview passkey-e2e 的预览状态：清预览 D1（只清会干扰本次运行的表）+ 每次运行的用量估算。
 *
 * 2026-10-27 起网关的认证状态全部在 D1（正式 styrigx-auth-gateway；预览 2026-10-29 起是测试专用库 styrigx-test-preview），不再绑定 KV（以前这里按键清预览 KV，
 * 因为免费计划的 KV 写 / 删 / 列各 1000 次 / 天、全账号共用，2026-10-25 四次 passkey-e2e 用掉了约 84%）。
 * 文件名沿用（CI 和文档都按这个名字引用）。
 *
 * 用法（CI 的 passkey-e2e job；本地可配 CF_API_BASE 指向 tests/space/e2e/helpers/preview-emulator.cjs）：
 *   node space/scripts/check/kv-budget.mjs reset-preview   清预览 D1 的 RESET_D1_TABLES（库 id 从 space/web/wrangler.toml 读，见 previewD1Id）
 *   node space/scripts/check/kv-budget.mjs estimate        打印每次运行的估算
 * 环境变量：CF_ACCOUNT_ID、CF_API_TOKEN（要 D1 编辑）；CF_API_BASE（默认 https://api.cloudflare.com/client/v4）。
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { REALM_LOCK } from '../../../workers/space-core/src/core/realms.js';

/**
 * 一次 passkey-e2e 运行的用量估算（上限）。KV：网关和测试都不再碰 KV，全为 0。
 * D1：tests/space/e2e/helpers/preview-emulator.cjs 量（/__kv/stats 的 d1 一栏，按语句数），真实预览留余量。
 */
export const PER_RUN_ESTIMATE = Object.freeze({ read: 0, write: 0, delete: 0, list: 0, d1Statements: 2500 });

/* ---------- 清预览 D1 ---------- */

/**
 * 清哪些表：会改变本次运行起始状态的（ai-limit.js / 账号的 attempt-limit 与凭据表）。
 * - account_passkey、account_password（账号，命名 v2 起独立的表）：「是否已设置」；不清的话账号的「设第一把钥匙」会变成假入口
 * - attempt_limit、account_attempt_limit：按 IP 的失败计数 / 冷却，会直接让本次运行 429（密码冷却等）
 * 不清的表，以及为什么不影响本次运行：
 * - audit：只追加的审计（7 天后不认），只有 /api/space-audit 读，passkey 组不测它。
 * - 网关旧进站 8 张表：v6 P4 起运行时 0 读写、建表语句已删（定稿 v5.4 §十一），不再清
 *   （生产由 docs/ops/v6-p4-drop-space-legacy.sql 在部署绿后 drop）。
 */
export const RESET_D1_TABLES = Object.freeze(['attempt_limit', 'account_passkey', 'account_password', 'account_attempt_limit']);

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
 * 预览 D1 的库 id：space/web/wrangler.toml [env.preview] 的 D1_SPACE，并断言它不是正式网关的库。
 * @param {string} repo 仓库根目录
 */
export function previewD1Id(repo) {
  const pv = d1DatabaseId(readFileSync(repo + '/space/web/wrangler.toml', 'utf8'), REALM_LOCK.d1Binding);
  const prod = d1DatabaseId(readFileSync(repo + '/workers/space-core/wrangler.toml', 'utf8'), REALM_LOCK.d1Binding);
  if (!pv || !prod || pv === prod) throw new Error('preview D1 id missing or equal to the production gateway D1');
  return pv;
}

async function resetPreviewD1() {
  const account = need('CF_ACCOUNT_ID');
  const repo = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/+$/, '');
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
    console.error('usage: node space/scripts/check/kv-budget.mjs reset-preview | estimate');
    process.exit(2);
  }
}
