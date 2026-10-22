/**
 * 批次 A 验收修复 P1：服务端 error 码静态核对（tests/kernel）。
 *
 * 规则：functions/api/*.js 返回的每个 error 码，必须属于以下之一，
 * 否则前端 apiErrorText 会落到「未知错误（code/status）」：
 * - ERR_KEY（assets/js/apps/app-gate.js）：有用户文案映射
 * - NEED_VERIFY_CODES（同文件）：走 needVerify 跳验证流程，不展示开发用语
 * - KNOWN_FIXED：调用方只用 HTTP 状态/ok 判断、显示固定文案，永不进 apiErrorText
 *
 * 提取方式（纯文本静态扫描，不跑服务端）：
 * - error: 'code' 字面量
 * - 三元 ? 'a' : 'b'（same-as-lock/same-as-owner、uv-required 等动态码）
 * 注意：不扫 throw new Error('…')——那是内部异常名（如 kv-error、invalid-class），
 * catch 里会转译成返回码（server / class），从不直接作为 error 返回。
 *
 * KNOWN_FIXED 说明：
 * - auth：lockreset 401，lock.js 按 HTTP 状态 + 固定文案处理
 * - configured：root-session 403，exchangeRootSession 只返回 ok/status
 * - failed / hostname / token：verify.js，lock.js submitToken 只看 ok，固定文案
 * - bad-form / missing / bad-type / too-large：/api/avatar 换头像，avatar-edit.js 只看 ok，失败一律固定文案
 * - account：账号会话缺失（/api/account 管理），账号页按码跳回账号登录，不进 apiErrorText
 * - door：门票缺失/过期（/api/account 管理、锁屏凭证管理），门内页按码回到门口重新验证，不进 apiErrorText
 *
 * 另断言：每个 ERR_KEY 的 i18n key 都在门内模板
 * （security-lock；原 security-owner 已升级为账号页，应用凭证页已删除）里定义，
 * 否则 t() 兜底会把映射当成缺键丢掉。
 *
 * 运行：node --test tests/kernel/error-codes.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const KNOWN_FIXED = new Set([
  'auth',
  'configured',
  'denied',
  'failed',
  'hostname',
  'token',
  'door',
  'bad-form',
  'missing',
  'bad-type',
  'too-large',
  'account',
  'bad-json',
  'bad-url',
  'current', /* 账号 › 设备：不能在设备页退出此设备（lib/account-api.js ERR_KEYS → devCurrent） */
  /* 全站搜索 /api/search：前端不显示错误，任何失败都退回本地索引（shell/search-layer.js askApi） */
  'too-long',
  'unauthorized',
  'upstream',
]);

function read(p) {
  return readFileSync(join(ROOT, p), 'utf8');
}

/** 提取服务端 error 码（见文件头三种模式）。 */
function extractServerCodes() {
  const codes = new Set();
  for (const f of readdirSync(join(ROOT, 'workers/auth-gateway/functions/api')).filter((x) => x.endsWith('.js'))) {
    const src = read(join('workers/auth-gateway/functions/api', f));
    for (const m of src.matchAll(/error:\s*'([a-z][a-z0-9-]*)'/g)) codes.add(m[1]);
    for (const line of src.split('\n')) {
      if (!/error|code/i.test(line)) continue;
      for (const m of line.matchAll(/\?\s*'([a-z][a-z0-9-]*)'\s*:\s*'([a-z][a-z0-9-]*)'/g)) {
        codes.add(m[1]);
        codes.add(m[2]);
      }
    }
  }
  return [...codes].sort();
}

/** 提取 ERR_KEY 的码 → i18n key，以及 NEED_VERIFY_CODES。 */
function extractFrontendMaps() {
  const src = read('web/assets/js/apps/app-gate.js');
  const errBlock = src.match(/var ERR_KEY = \{([\s\S]*?)\};/);
  assert.ok(errBlock, '应能找到 ERR_KEY 定义');
  const errKey = new Map();
  for (const m of errBlock[1].matchAll(/'([a-z][a-z0-9-]*)':\s*'([A-Za-z]+)'/g)) {
    errKey.set(m[1], m[2]);
  }
  const needBlock = src.match(/const NEED_VERIFY_CODES = \[([\s\S]*?)\];/);
  assert.ok(needBlock, '应能找到 NEED_VERIFY_CODES 定义');
  const needVerify = new Set([...needBlock[1].matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]));
  return { errKey, needVerify };
}

test('服务端每个 error 码都有前端映射或固定文案处理', () => {
  const serverCodes = extractServerCodes();
  const { errKey, needVerify } = extractFrontendMaps();
  assert.ok(serverCodes.length > 20, '应提取到一批服务端 error 码，实际 ' + serverCodes.length);
  const unmapped = serverCodes.filter(
    (c) => !errKey.has(c) && !needVerify.has(c) && !KNOWN_FIXED.has(c)
  );
  assert.deepEqual(unmapped, [], '未映射的服务端 error 码会落到「未知错误（code/status）」');
});

test('same-as-lock / same-as-owner 必须在 ERR_KEY 里（双向相同密码文案）', () => {
  const { errKey } = extractFrontendMaps();
  assert.equal(errKey.get('same-as-lock'), 'errSameAsLock');
  assert.equal(errKey.get('same-as-owner'), 'errSameAsOwner');
});

test('每个 ERR_KEY 的 i18n key 都在门内模板里定义', () => {
  const { errKey } = extractFrontendMaps();
  const templates = [
    'web/layouts/_default/security-lock.html',
  ];
  for (const t of templates) {
    const src = read(t);
    const missing = [...errKey.values()].filter((k) => !src.includes('"' + k + '"'));
    assert.deepEqual(missing, [], t + ' 缺少 i18n key');
  }
});
