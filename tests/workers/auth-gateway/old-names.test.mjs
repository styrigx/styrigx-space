/**
 * CI 守门（鉴权命名改造第 4 / 5 / 6 层之后）：workers/ 与 web/ 的源码里不许再出现旧名字——
 * 旧 cookie、旧票格式标识、旧角色值、旧接口路径、旧 RPC 名、旧 data 属性、旧 KV 键名。
 * 出现就失败，并列出「文件:行号 命中的旧名」。
 *
 * 白名单（不算命中）：
 * - 以前的 Cloudflare 绑定名：KV_LOCK_DOOR、KV_ACCOUNT_LOGIN、D1_LOCK_RESET（2026-10-27 起网关已不绑，binding-names.test.mjs 核对；
 *   测试替身和导入脚本里仍会出现这些名字）
 * - Secrets Store 密钥名：SGX_*（如 SGX_PW_PEPPER、SGX_ROOT_KEY，不改名）
 * - 历史文档不在 workers/ web/ 下（docs/2.4.1-*、docs/styrigx-3.0-task.md），本测试不扫
 * 生成物与第三方目录不扫：web/public、web/resources、node_modules、visual 基线图。
 *
 * 运行：node --test tests/workers/auth-gateway/old-names.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ROOTS = ['workers', 'web'];
const SKIP_DIRS = new Set(['node_modules', 'public', 'resources', 'visual', '.wrangler', '.git']);
const EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.html', '.css', '.toml', '.json', '.md', '.sql', '.yaml', '.yml', '.txt']);

/* 旧名 → 正则（顺序即报告顺序） */
const OLD_NAMES = [
  ['owner-（旧 KV 键 / 接口前缀）', /owner-/],
  ['sgx-verified', /sgx-verified/],
  ['sgx-tk', /sgx-tk\b/],
  ['sgx-door', /sgx-door/],
  ['sgx-account（旧 cookie 精确值）', /["'`]sgx-account["'`]|sgx-account=/],
  ['session-epoch', /session-epoch/],
  ['pw-lock', /(?<![\w-])pw-lock/],
  ['pw-fail', /(?<![\w-])pw-fail/],
  ['lock-temp（未改成 lock-tempkey 的）', /lock-temp(?!key)/],
  ['/api/lockreset', /\/api\/lockreset/],
  ['lockreset（旧状态值 / 旧 KV 前缀）', /lockreset/],
  ['/api/session-check', /\/api\/session-check/],
  ['/api/root-session', /\/api\/root-session/],
  ['SessionVerifier', /SessionVerifier/],
  ['data-sgx-session', /data-sgx-session(?![\w-])/],
  ['data-sgx-role="owner"', /data-sgx-role=["']owner/],
  ['role owner', /role\s*===?\s*['"]owner['"]|ROLE_OWNER/],
  ['recovery-switch', /recovery-switch/],
  ['root-auth-*（旧 KV 键）', /root-auth-(fail|global|audit)/],
  ['layer:*（旧 KV 键）', /layer:(lock|owner)/],
  ['account-dev:', /account-dev:/],
  ['account-revoked:', /account-revoked:/],
  ['account-challenge:', /account-challenge:/],
  ['pk-challenge:', /(?<![\w-])pk-challenge:/],
  ['lock-pw', /lock-pw\b/],
  ['STORE_CLASS_*', /STORE_CLASS_/],
  ['_kernel/key-names.js', /_kernel\/key-names/],
  ['signTk / parseTk / TK_COOKIE', /\bsignTk\b|\bparseTk\b|\bTK_COOKIE\b/],
  ['DoorTicket', /DoorTicket/],
];
/* 行内白名单：先从行里抹掉这些再匹配 */
const ALLOW = [/\bKV_LOCK_DOOR\b/g, /\bKV_ACCOUNT_LOGIN\b/g, /\bD1_LOCK_RESET\b/g, /\bSGX_[A-Z0-9_]+\b/g];

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(name))) out.push(p);
  }
  return out;
}

test('workers/ 与 web/ 源码里没有旧名字（cookie / 票 / 角色 / 接口 / RPC / data 属性 / KV 键名）', () => {
  const hits = [];
  let files = 0;
  for (const r of ROOTS) {
    for (const f of walk(path.join(REPO, r), [])) {
      files++;
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        let l = line;
        for (const a of ALLOW) l = l.replace(a, '');
        for (const [label, re] of OLD_NAMES) {
          if (re.test(l)) hits.push(path.relative(REPO, f) + ':' + (i + 1) + '  ' + label);
        }
      });
    }
  }
  assert.ok(files > 100, '扫到的文件太少（' + files + '），目录结构变了？');
  assert.deepEqual(hits, [], '发现旧名字：\n' + hits.join('\n'));
});

test('守门规则本身：旧名能命中，白名单不误报', () => {
  const match = (s) => {
    let l = s;
    for (const a of ALLOW) l = l.replace(a, '');
    return OLD_NAMES.filter(([, re]) => re.test(l)).map(([label]) => label);
  };
  assert.ok(match("kv.get('owner-pw')").length > 0);
  assert.ok(match("'sgx-verified='").length > 0);
  assert.ok(match("const k = 'lock-temp:' + id").length > 0);
  assert.ok(match("fetch('/api/session-check')").length > 0);
  assert.ok(match('<html data-sgx-session="valid">').length > 0);
  assert.deepEqual(match("env.KV_LOCK_DOOR, env.D1_LOCK_RESET, env.SGX_PW_PEPPER"), []);
  assert.deepEqual(match("'lock-tempkey:' + id; 'sgx-account-session'; /api/lock-session-check; data-sgx-lock-session"), []);
});
