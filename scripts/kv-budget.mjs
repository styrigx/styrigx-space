#!/usr/bin/env node
/**
 * @fileoverview passkey-e2e 的 Workers KV：清预览 KV（只清会干扰本次运行的键）+ 每次运行的用量估算。
 *
 * 为什么要有：免费计划的 KV 配额按「整个账号、每个 UTC 日」算（写 1000、删 1000、列 1000、读 100000），
 * 预览 KV（styrigx-auth-gateway-preview）和生产网关的 KV 共用这一份。2026-10-25 四次 passkey-e2e
 * 用掉了全账号约 84% 的非读操作；超了以后生产网关的 KV 写会 429，锁屏 / 账号直接不可用。
 *
 * 用法（CI 的 passkey-e2e job；本地可配 CF_API_BASE 指向 tests/web/e2e/preview-emulator.cjs）：
 *   node scripts/kv-budget.mjs reset-preview <namespace-id>   只删会干扰本次运行的预览 KV 键（见 selectResetKeys）
 *   node scripts/kv-budget.mjs estimate                 打印每次运行的估算
 * 环境变量：CF_ACCOUNT_ID、CF_API_TOKEN；CF_API_BASE（默认 https://api.cloudflare.com/client/v4）。
 */
import { fileURLToPath } from 'node:url';
import { REALM_LOCK, REALM_ACCOUNT, REALM_ROOT } from '../workers/auth-gateway/functions/_kernel/realms.js';

/**
 * 一次 passkey-e2e 运行的 KV 操作估算（上限）。
 * 量法：tests/web/e2e/preview-emulator.cjs 本地模拟预览站跑完整 17 条用例、给每次 KV 操作记账（网关 + 测试进程 REST + 清 KV 步骤），
 * 实测（本 PR 之后）：读 549、写 87、删 47、列 9（其中清 KV 只删 4 个键 + 1 次列表）。真实预览站上 KV 最终一致，
 * 重置开关要轮询几次、刚写的密码偶尔要重试解锁，所以再留余量：读 ×1.5，写 / 删 / 列各加约 30%，
 * 并把清 KV 时最坏情况（上次运行中途失败，留下一批通行密钥）算进删除。
 * 2026-10-25 线上实测（本 PR 之前）四次平均：写 ~99、删 ~106、列 ~9、读 ~625，与模拟器的「之前」读数（写 101、删 113、列 9、读 592）一致。
 */
export const PER_RUN_ESTIMATE = Object.freeze({ read: 850, write: 120, delete: 80, list: 12 });

/* ---------- 清预览 KV：只删会改变本次运行起始状态的键 ---------- */

/** 精确键：决定「锁屏 / 账号是否已设置」的状态（不删的话 root-auth 的 lock-reset / account-reset 入口会变成假入口） */
export const RESET_EXACT = Object.freeze([
  REALM_LOCK.kv.password,
  REALM_LOCK.kv.configured,
  REALM_LOCK.kv.passkeyIndex,
  REALM_ACCOUNT.kv.password,
  REALM_ACCOUNT.kv.configured,
  REALM_ACCOUNT.kv.passkeyIndex,
]);

/**
 * 前缀：
 * - 通行密钥记录（同上，属于「已设置」的状态；正常运行时用例自己删光，只有中途失败才会留下）
 * - 按 IP 的失败计数 / 冷却：会直接让本次运行 429（root-auth 连错锁 15 分钟、密码冷却）
 */
export const RESET_PREFIXES = Object.freeze([
  REALM_LOCK.kv.passkeyPrefix,
  REALM_ACCOUNT.kv.passkeyPrefix,
  REALM_ROOT.kv.failPrefix,
  REALM_LOCK.kv.passwordFailPrefix,
  REALM_LOCK.kv.passwordCooldownPrefix,
  REALM_ACCOUNT.kv.passwordFailPrefix,
  REALM_ACCOUNT.kv.passwordCooldownPrefix,
  REALM_LOCK.kv.tempkeyFailPrefix,
]);

/*
 * 不删的键，以及为什么不影响本次运行（以前整库清空，每次 ~30 个删除，大半是这些）：
 * - lock-epoch / account-epoch：只和会话 / 票里写的纪元比较。上一次运行的会话和票都是上一次现生成的 Ed25519 私钥签的，
 *   这次换了钥匙对，验签先失败；这次的会话按 KV 里的当前值签发。用例只断言「+1」这种相对变化。
 * - lock-user-id / account-user-id：注册通行密钥时给认证器的随机 user handle，生产上第一次注册之后也一直复用；
 *   虚拟认证器每个用例新建，没有旧凭据。
 * - root-audit:*：只追加的审计日志（7 天 TTL），只有 /api/root-audit 读，passkey 组不测它。
 * - *-challenge:*：一次性随机 cid（5 分钟 TTL），新运行拿不到旧 cid。
 * - *-fail-global：全局计数只减速（root 每小时 ≥20 次、密码 ≥50 次才每次多等 2～3 秒），从不拒绝；一次运行只产生个位数。
 * - lock-tempkey*、account-device*：passkey 组不创建临时钥匙，也不做成功的账号登录；都有 TTL。
 * - lock-reset-switch：签过票的值在 D1 标了已用，永不再生效；用例要用时直接覆盖成新值（见 preview-helpers.cjs）。
 * 所以剩下的键只可能让本次运行「看到」和上次相同的计数器 / 日志，不会改变任何断言的前提。
 */

/**
 * 从预览 KV 的键列表里挑出要删的键。
 * @param {Array<{name: string}>} keys
 * @returns {string[]}
 */
export function selectResetKeys(keys) {
  const out = [];
  for (const k of keys || []) {
    const n = k && k.name;
    if (!n) continue;
    if (RESET_EXACT.includes(n) || RESET_PREFIXES.some((p) => n.startsWith(p))) out.push(n);
  }
  return out;
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

async function resetPreview(ns) {
  const account = need('CF_ACCOUNT_ID');
  if (!/^[0-9a-f]{32}$/.test(ns || '')) {
    console.error('::error::reset-preview needs the preview KV namespace id');
    process.exit(1);
  }
  const base = `${apiBase()}/accounts/${account}/storage/kv/namespaces/${ns}`;
  const keys = [];
  let cursor = '';
  let pages = 0;
  for (;;) {
    const q = new URLSearchParams({ limit: '1000' });
    if (cursor) q.set('cursor', cursor);
    const r = await cfFetch(base + '/keys?' + q);
    pages++;
    if (r.status !== 200 || !r.body || !r.body.success) {
      console.error(`::error::list keys HTTP ${r.status} (the token needs Workers KV Storage:Edit)`);
      process.exit(1);
    }
    keys.push(...(r.body.result || []));
    cursor = (r.body.result_info && r.body.result_info.cursor) || '';
    if (!cursor) break;
  }
  const names = selectResetKeys(keys);
  for (let i = 0; i < names.length; i += 1000) {
    const r = await cfFetch(base + '/bulk/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(names.slice(i, i + 1000)),
    });
    if (r.status !== 200 || !r.body || !r.body.success) {
      console.error(`::error::bulk delete HTTP ${r.status} (the token needs Workers KV Storage:Edit)`);
      process.exit(1);
    }
  }
  console.log(`preview KV reset: ${keys.length} keys listed (${pages} list op), ${names.length} deleted, ${keys.length - names.length} kept (they cannot affect this run; see scripts/kv-budget.mjs)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, a1] = process.argv.slice(2);
  if (cmd === 'reset-preview') await resetPreview(a1);
  else if (cmd === 'estimate') console.log(JSON.stringify({ perRun: PER_RUN_ESTIMATE }));
  else {
    console.error('usage: node scripts/kv-budget.mjs reset-preview <namespace-id> | estimate');
    process.exit(2);
  }
}
