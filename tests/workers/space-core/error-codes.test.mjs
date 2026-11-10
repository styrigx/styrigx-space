/**
 * 批次 A 验收修复 P1：服务端 error 码静态核对（tests/kernel）。
 *
 * 规则：网关 src/api/*.js 返回的每个 error 码，必须属于以下之一，
 * 否则前端 apiErrorText 会落到「未知错误（code/status）」：
 * - ERR_KEY（assets/js/shell/space/api.js；进站 v3 L1 起锁屏 / reset / 盾牌共用，原 apps/app-gate.js 已删）：有用户文案映射
 * - NEED_VERIFY_CODES（同文件）：终端按码回锁屏 / 重跑 sudo styrigx reauth，不展示开发用语
 * - KNOWN_FIXED：调用方只用 HTTP 状态/ok 判断、显示固定文案，永不进 apiErrorText
 *
 * 提取方式（纯文本静态扫描，不跑服务端）：
 * - error: 'code' 字面量
 * - apiError(<状态>, 'code'…)（workers/space-core/src/lib/http.js 的错误响应）
 * - 三元 ? 'a' : 'b'（same-as-lock/same-as-account、uv-required 等动态码）
 * 注意：不扫 throw new Error('…')——那是内部异常名（如 kv-error、invalid-class），
 * catch 里会转译成返回码（server / class），从不直接作为 error 返回。
 *
 * KNOWN_FIXED 说明：
 * - auth：lockreset 401，lock.js 按 HTTP 状态 + 固定文案处理
 * - purpose：/api/space-auth 缺 purpose / purpose 不认识（前端总是带四个固定值之一，只在请求被篡改时出现）
 * - no-session-key：签进站会话缺私钥，前端显示「服务器错误」
 * - duration / name / full：/api/share create（名字太长 / 已满 20 条；duration 只在下拉被篡改时出现）
 * - link：v5 S1 分享链接进来的会话被拒（403），S5 终端合一时接固定文案
 * - bad-form / missing / bad-type / too-large：/api/avatar 换头像，avatar-edit.js 只看 ok，失败一律固定文案
 * - account：账号会话缺失（/api/account 管理），账号页按码跳回账号登录，不进 apiErrorText
 * - reauth：reauth 票缺失/过期（/api/account 管理、锁屏凭证管理），页面按码回到验证入口重新验证，不进 apiErrorText
 *
 * 另断言：每个 ERR_KEY 的 i18n key 都在外壳字符串表 space.common.*（data/sgx-shell-i18n/<语言>.yaml）里定义，
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
  'purpose', /* /api/space-auth：前端总是带固定 purpose */
  'denied',
  'no-session-key', /* 签进站会话缺 SGX_SPACE_PRIVATE（issueLockSession）：前端显示「服务器错误」 */
  'duration', /* /api/share create：只在下拉值被篡改时出现，落到通用文案 */
  'name', /* /api/share create：名字太长 */
  'full', /* /api/share create：已满 20 条 */
  'target', /* /api/share create（进站 v3 L2 并入 space-core）：目标由前端按当前页 / 固定值给，只在请求被篡改时出现，分享层显示固定失败文案 */
  'reauth',
  'link', /* v5 S1：分享链接进来的会话（by=link）不能新建 / 管理分享、reauth、管锁屏凭证（403 link）；S5 终端合一时按码显示固定文案，在那之前落到通用失败文案 */
  'bad-form',
  'missing',
  'bad-type',
  'too-large',
  'account',
  'bad-json',
  'bad-url',
  'current', /* 账号 › 设备：不能在设备页退出此设备（auth/post-json.js ERR_KEYS → devCurrent） */
  'unauthorized',
  'upstream',
  /* /api/ai（P4-1）：AI 窗口在 P5-1，按码显示固定文案（全站太忙，稍后再试），不进 apiErrorText */
  'busy',
]);

function read(p) {
  return readFileSync(join(ROOT, p), 'utf8');
}

/** 提取服务端 error 码（见文件头三种模式）。 */
function extractServerCodes() {
  const codes = new Set();
  for (const f of readdirSync(join(ROOT, 'workers/space-core/src/api')).filter((x) => x.endsWith('.js'))) {
    const src = read(join('workers/space-core/src/api', f));
    for (const m of src.matchAll(/error:\s*'([a-z][a-z0-9-]*)'/g)) codes.add(m[1]);
    for (const m of src.matchAll(/apiError\(\s*\d+\s*,\s*'([a-z][a-z0-9-]*)'/g)) codes.add(m[1]);
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
  const src = read('space/web/assets/js/shell/space/api.js');
  const errBlock = src.match(/export const ERR_KEY = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert.ok(errBlock, '应能找到 ERR_KEY 定义');
  const errKey = new Map();
  for (const m of errBlock[1].matchAll(/'([a-z][a-z0-9-]*)':\s*'([A-Za-z]+)'/g)) {
    errKey.set(m[1], m[2]);
  }
  const needBlock = src.match(/export const NEED_VERIFY_CODES = \[([\s\S]*?)\];/);
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

test('same-as-lock / same-as-account 必须在 ERR_KEY 里（双向相同密码文案）', () => {
  const { errKey } = extractFrontendMaps();
  assert.equal(errKey.get('same-as-lock'), 'errSameAsLock');
  assert.equal(errKey.get('same-as-account'), 'errSameAsAccount');
});

test('每个 ERR_KEY 的 i18n key 都在外壳字符串表 space.common 里定义（进站 v3 L1：data/sgx-shell-i18n/<语言>.yaml）', async () => {
  const { errKey } = extractFrontendMaps();
  const yaml = (await import('js-yaml')).default;
  for (const lang of ['en', 'zh']) {
    const table = ((yaml.load(read('space/web/data/sgx-shell-i18n/' + lang + '.yaml')) || {}).space || {}).common || {};
    const missing = [...new Set(errKey.values())].filter((k) => table[k] == null || table[k] === '');
    assert.deepEqual(missing, [], lang + ' 字符串表 space.common 缺少 i18n key');
  }
});

/* ---------- 错误码登记表（workers/space-core/src/lib/http.js ERROR_CODES） ---------- */

/** 网关 src/、账号 / 分享 Worker 里每个带 HTTP 状态的错误码：apiError(S,'c')、{status:S, body:{ok:false,error:'c'}}、json(S,{ok:false,error:'c'}) */
function extractCodeStatusPairs() {
  const dirs = ['workers/space-core/src', 'workers/account/src'];
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      const p = d + '/' + e.name;
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js') && p !== 'workers/space-core/src/lib/http.js') files.push(p);
    }
  };
  dirs.forEach(walk);
  const pairs = [];
  for (const f of files) {
    const src = read(f);
    const res = [
      /apiError\(\s*(\d+)\s*,\s*'([a-z][a-z0-9_-]*)'/g,
      /status:\s*(\d+),\s*body:\s*\{\s*ok:\s*false,\s*error:\s*'([a-z][a-z0-9_-]*)'/g,
      /json\(\s*(\d+)\s*,\s*\{\s*ok:\s*false,\s*error:\s*'([a-z][a-z0-9_-]*)'/g,
    ];
    for (const re of res) for (const m of src.matchAll(re)) pairs.push({ file: f, status: Number(m[1]), code: m[2] });
  }
  return pairs;
}

test('错误码登记表：每个返回的错误码都登记在 ERROR_CODES，HTTP 状态也在登记范围内', async () => {
  const { ERROR_CODES } = await import(join(ROOT, 'workers/space-core/src/lib/http.js'));
  const pairs = extractCodeStatusPairs();
  assert.ok(pairs.length > 150, '应提取到一批错误响应，实际 ' + pairs.length);
  const bad = pairs.filter((p) => !Object.prototype.hasOwnProperty.call(ERROR_CODES, p.code) || !ERROR_CODES[p.code].includes(p.status));
  assert.deepEqual(bad, [], '新错误码或新状态要先登记到 workers/space-core/src/lib/http.js ERROR_CODES');
  /* 登记表里没有用不到的码 */
  const used = new Set(pairs.map((p) => p.code));
  assert.deepEqual(Object.keys(ERROR_CODES).filter((c) => !used.has(c)), []);
});

test('json() / apiError()：默认头、Set-Cookie 原样保留、错误体字段顺序', async () => {
  const { json, apiError, NO_STORE } = await import(join(ROOT, 'workers/space-core/src/lib/http.js'));
  const r = json(200, { ok: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'application/json');
  assert.equal(r.headers.get('Cache-Control'), NO_STORE);
  assert.equal(await r.text(), '{"ok":true}');
  const h = new Headers();
  h.append('Set-Cookie', 'a=1; Path=/');
  h.append('Set-Cookie', 'b=2; Path=/');
  const r2 = json(200, { ok: true }, h);
  assert.deepEqual(r2.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
  const r3 = apiError(403, 'reauth', { reason: 'expired' }, { 'Cache-Control': 'no-store' });
  assert.equal(r3.status, 403);
  assert.equal(r3.headers.get('Cache-Control'), 'no-store');
  assert.equal(await r3.text(), '{"ok":false,"error":"reauth","reason":"expired"}');
});

test('clientIp()：只认 CF-Connecting-IP，不认 X-Forwarded-For', async () => {
  const { clientIp } = await import(join(ROOT, 'workers/space-core/src/lib/http.js'));
  assert.equal(clientIp(new Request('https://x/', { headers: { 'CF-Connecting-IP': '203.0.113.9', 'X-Forwarded-For': '1.2.3.4' } })), '203.0.113.9');
  assert.equal(clientIp(new Request('https://x/', { headers: { 'X-Forwarded-For': '1.2.3.4' } })), 'unknown');
  assert.equal(clientIp(new Request('https://x/')), 'unknown');
});
