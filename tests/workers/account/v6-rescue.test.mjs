/**
 * v6 P3 救援入口（定稿 v5.2 §九 / §三 / §六 / §十；命令名 rescue）：POST /api/identity action rescue，经 AccountService 的 serviceFetch，真 SQL（node:sqlite）。
 *
 * 覆盖：
 * - 钥匙错 → 401 auth；钥匙对 → 15 分钟一次性 root 会话（rescue 标志、cookie Max-Age 900、不续期），钥匙两边去空白后比对（同已上线恢复密钥）
 * - 指纹：签发成功记 SHA-256（不存明文），同值再用直接拒（同一个 401 auth，审计区分 reused）；指纹写失败 → 拒绝救援、会话作废、不发 cookie
 * - 白名单（precedence() 一处）：whoami / passwd / passkey-* / groups / exit / lock 可用，其余命令拒；救援会话调别的 root 接口（admit）拒；
 *   救援里再 rescue 拒；救援中 exit 直接回访客
 * - 已登录（普通用户）走 rescue → exit-first；没绑钥匙 → 503 config
 * - 限流：单独的计数（不影响 su）；渐进退避 1s → 5s → 30s → 5min；按 IP 每分钟 6 次失败硬上限
 * - 审计：rescue / login-fail rescue（不含钥匙值）
 * - 重置后 epoch +1（救援里 passwd 改 root 密码 → root 在别处的会话层作废）
 * - 15 分钟到期：到期后 whoami 回访客；whoami 不续写
 * - 代码纪律：账号 Worker 源码不出现 Secrets Store 写 / 删
 *
 * 运行：node --test tests/workers/account/v6-rescue.test.mjs
 */
import './_cf-workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeAccountD1 } from './_d1.mjs';
import { admit as AD } from './_identity.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const SRC = REPO + 'workers/account/src/';
const { serviceFetch } = await import(SRC + 'rpc/account-service.js');
const { _resetSecretCache, SECRET_NAMES } = await import(SRC + 'secrets.js');
const { makePasswordRecord } = await import(SRC + 'core/password.js');
const R = await import(SRC + 'core/rescue.js');
const RA = await import(SRC + 'core/route-access.js');
const G = await import(SRC + 'core/groups.js');

const ORIGIN = 'https://styrigx.com';
const PEP_A = 'pepper-account-test';
const KEY = 'Resc-ue-Key-0123456789-abcdefghijklmnop';
const PW = { root: 'root-pass-01', styrigx: 'sty-pass-01' };

let ipN = 0;
const freshIp = () => '198.51.100.' + (++ipN % 250);

async function setup(o = {}) {
  _resetSecretCache();
  const env = {
    SGX_ENV: 'production', SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: ORIGIN,
    SGX_ACCOUNT_PASSWORD_PEPPER: PEP_A,
    D1_ACCOUNT: makeAccountD1(), KV_PROFILE: { get: async () => null, put: async () => {}, delete: async () => {} },
    ASSETS: { fetch: async () => new Response('DEFAULT', { status: 200 }) },
  };
  if (o.key !== null) env.SGX_ACCOUNT_RESCUE_KEY = o.key === undefined ? KEY : o.key;
  const raw = env.D1_ACCOUNT.raw;
  const addUser = async (uid, name, pw, groups = []) => {
    raw.prepare('INSERT INTO account_users (uid, name, avatar, expires_at, epoch, disabled, created_at) VALUES (?, ?, \'\', 0, 0, 0, 1)').run(uid, name);
    for (const g of groups) raw.prepare('INSERT INTO account_user_groups (uid, grp, added_at) VALUES (?, ?, 1)').run(uid, g);
    const rec = await makePasswordRecord(pw, PEP_A);
    raw.prepare('INSERT INTO account_user_password (uid, record, pepper_id, must_change, expires_at) VALUES (?, ?, \'account\', 0, 0)').run(uid, JSON.stringify(rec));
  };
  await addUser(0, 'root', PW.root);
  await addUser(1000, 'styrigx', PW.styrigx, ['wheel', 'sudoers', 'listen', 'ai', 'status', 'curio-write', 'daymark-write']);
  return env;
}

async function call(env, body, cookie, ip) {
  const headers = { Origin: ORIGIN, 'CF-Connecting-IP': ip || freshIp(), 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = 'sgx-session=' + cookie;
  const res = await serviceFetch(new Request(ORIGIN + '/api/identity', { method: 'POST', headers, body: JSON.stringify(body) }), env, { waitUntil() {} });
  let json = null;
  try { json = JSON.parse(await res.clone().text()); } catch (e) {}
  return { status: res.status, json, cookies: res.headers.getSetCookie() };
}
const tokenOf = (r) => { const c = r.cookies.find((x) => x.startsWith('sgx-session=')); return c ? c.split(';')[0].slice('sgx-session='.length) : ''; };
const rows = (env, sql, ...p) => env.D1_ACCOUNT.raw.prepare(sql).all(...p).map((r) => ({ ...r }));
/** 清掉救援入口的退避（测下一次时不被上一次的 1s 冷却挡住） */
const unblock = (env) => env.D1_ACCOUNT.raw.prepare("UPDATE account_attempt_limit SET locked_until = 0 WHERE kind LIKE 'v6-rescue%'").run();

async function rescueOk(env, key = KEY) {
  const r = await call(env, { action: 'rescue', key });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { r, tok: tokenOf(r) };
}

test('绑定：SGX_ACCOUNT_RESCUE_KEY 在 SECRET_NAMES 与 wrangler.toml（同 store、binding = secret_name、预览不绑）', () => {
  assert.ok(SECRET_NAMES.includes('SGX_ACCOUNT_RESCUE_KEY'));
  assert.equal(R.RESCUE_KEY_SECRET, 'SGX_ACCOUNT_RESCUE_KEY');
  const toml = readFileSync(REPO + 'workers/account/wrangler.toml', 'utf8');
  const code = toml.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
  const [prod, preview] = code.split(/^\[env\.preview\]$/m);
  assert.match(prod, /\[\[secrets_store_secrets\]\]\nbinding = "SGX_ACCOUNT_RESCUE_KEY"\nstore_id = "a5a984f365424401bad5ad6ddcd44479"\nsecret_name = "SGX_ACCOUNT_RESCUE_KEY"/);
  assert.doesNotMatch(preview, /SGX_ACCOUNT_RESCUE_KEY/);
});

test('钥匙错 → 401 auth（不签会话、记审计 login-fail rescue、不含钥匙值）；钥匙对 → 15 分钟 root 救援会话，Max-Age 900，指纹记 SHA-256 不存明文', async () => {
  const env = await setup();
  const bad = await call(env, { action: 'rescue', key: 'wrong-key' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error, 'auth');
  assert.equal(tokenOf(bad), '');
  assert.equal(rows(env, 'SELECT * FROM account_sessions').length, 0);
  assert.equal((await call(env, { action: 'rescue', key: '' })).status, 401, '空钥匙拒');
  assert.equal((await call(env, { action: 'rescue', key: KEY })).status, 429, '连错后进入退避：码对也不验');
  unblock(env);
  /* 去空白后比对（同已上线恢复密钥 normalizeRecoveryKey：粘贴多行） */
  const { r, tok } = await rescueOk(env, KEY.slice(0, 10) + '\n ' + KEY.slice(10));
  assert.equal(r.json.user.rescue, true);
  assert.equal(r.json.user.root, true);
  assert.equal(r.json.user.path, 'root (rescue)');
  const ck = r.cookies.find((x) => x.startsWith('sgx-session='));
  assert.match(ck, /HttpOnly/);
  assert.match(ck, /Max-Age=900(;|$)/);
  assert.ok(r.cookies.some((x) => /^sgx-id=1;.*Max-Age=900/.test(x)), '登录标记同 15 分钟');
  const s = rows(env, 'SELECT uid, rescue, expires_at - created_at AS ttl FROM account_sessions');
  assert.deepEqual(s, [{ uid: 0, rescue: 1, ttl: 15 * 60 * 1000 }]);
  const fp = rows(env, 'SELECT id, record, used_at FROM account_recovery_key');
  assert.equal(fp.length, 1);
  assert.equal(fp[0].id, await R.rescueFingerprint(KEY));
  assert.match(fp[0].id, /^[0-9a-f]{64}$/);
  assert.ok(fp[0].used_at > 0);
  const all = JSON.stringify(rows(env, 'SELECT * FROM account_recovery_key')) + JSON.stringify(rows(env, 'SELECT * FROM account_user_audit'));
  assert.ok(!all.includes(KEY) && !all.includes('wrong-key'), '钥匙值不进库、不进审计');
  const au = rows(env, 'SELECT uid, command, ok FROM account_user_audit ORDER BY ts');
  assert.ok(au.some((a) => a.command === 'login-fail rescue' && a.ok === 0 && a.uid === null));
  assert.ok(au.some((a) => a.command === 'rescue' && a.ok === 1 && a.uid === 0));
  assert.equal((await call(env, { action: 'whoami' }, tok)).json.user.rescue, true);
});

test('同值再用直接拒（同一个 401 auth，审计记 reused）；Gray 换值后新钥匙可用', async () => {
  const env = await setup();
  const { tok } = await rescueOk(env);
  await call(env, { action: 'exit' }, tok);
  const again = await call(env, { action: 'rescue', key: KEY });
  assert.equal(again.status, 401);
  assert.equal(again.json.error, 'auth');
  assert.equal(tokenOf(again), '');
  assert.equal(rows(env, 'SELECT * FROM account_sessions').length, 0);
  assert.ok(rows(env, 'SELECT command FROM account_user_audit').some((a) => a.command === 'login-fail rescue reused'));
  /* Gray 在 dashboard 换值（运行时生效） */
  unblock(env);
  _resetSecretCache();
  env.SGX_ACCOUNT_RESCUE_KEY = KEY + '-v2';
  await rescueOk(env, KEY + '-v2');
  assert.equal(rows(env, 'SELECT * FROM account_recovery_key').length, 2, '指纹永久保留');
});

test('并发两次同值：只有一个签成（指纹主键挡住第二个，第二个的会话作废）', async () => {
  const env = await setup();
  const [a, b] = await Promise.all([call(env, { action: 'rescue', key: KEY }), call(env, { action: 'rescue', key: KEY })]);
  const okN = [a, b].filter((r) => r.status === 200).length;
  assert.equal(okN, 1, JSON.stringify([a.status, b.status]));
  assert.equal(rows(env, 'SELECT * FROM account_sessions WHERE rescue = 1').length, 1);
});

test('指纹写失败 → 拒绝救援（fail-closed）：503 server、会话作废、不发 cookie、审计记 fingerprint', async () => {
  const env = await setup();
  env.D1_ACCOUNT.raw.exec("CREATE TRIGGER fp_fail BEFORE INSERT ON account_recovery_key BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  const r = await call(env, { action: 'rescue', key: KEY });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'server');
  assert.equal(tokenOf(r), '');
  assert.equal(rows(env, 'SELECT * FROM account_sessions').length, 0, '刚签的会话已删');
  assert.ok(rows(env, 'SELECT command FROM account_user_audit').some((a) => a.command === 'login-fail rescue fingerprint'));
});

test('没绑钥匙 / 值为空 → 503 config（fail closed，不计数）', async () => {
  for (const key of [null, '', '   ']) {
    const env = await setup({ key });
    const r = await call(env, { action: 'rescue', key: 'anything' });
    assert.equal(r.status, 503, String(key));
    assert.equal(r.json.error, 'config');
    assert.equal(rows(env, 'SELECT * FROM account_sessions').length, 0);
  }
});

test('已登录走 rescue → exit-first；救援会话里再 rescue → permits 拒（不在白名单）', async () => {
  const env = await setup();
  const su = await call(env, { action: 'su', user: 'styrigx', password: PW.styrigx });
  const st = tokenOf(su);
  const r = await call(env, { action: 'rescue', key: KEY }, st);
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'exit-first');
  assert.equal(rows(env, 'SELECT * FROM account_recovery_key').length, 0, '没比对、没记指纹');
  await call(env, { action: 'exit' }, st);
  const { tok } = await rescueOk(env);
  const again = await call(env, { action: 'rescue', key: KEY + 'x' }, tok);
  assert.equal(again.status, 403);
  assert.equal(again.json.error, 'permission');
  assert.equal(RA.rescueOf('POST', '/api/identity', { action: 'rescue' }), false);
  assert.equal(RA.levelOf('POST', '/api/identity', { action: 'rescue' }), 'public');
});

test('白名单只在 precedence() 一处：救援会话 whoami / groups / passkey-list / passwd / exit 可用；其余命令与别的 root 接口一律拒；exit 直接回访客', async () => {
  /* precedence 是唯一实现：permits / admitDecision 都经它 */
  const rid = { uid: 0, name: 'root', groups: [], rescue: true };
  assert.equal(G.precedence(rid, { rescue: false }), false);
  assert.equal(G.precedence(rid, { rescue: true }), true);
  assert.equal(G.permits(rid, 'public', { rescue: false }), false, '即使 public 档');
  assert.equal(AD.admitDecision(rid, 'root', { rescue: false }), false);
  assert.deepEqual([...G.RESCUE_COMMANDS], ['passwd', 'passkey', 'whoami', 'groups', 'exit', 'lock']);
  const listed = RA.ruleOf('POST', '/api/identity').rescueActions;
  assert.deepEqual([...listed].sort(), ['exit', 'groups', 'lock', 'passkey-add', 'passkey-add-challenge', 'passkey-delete', 'passkey-list', 'passwd', 'whoami']);
  for (const a of listed) assert.ok(G.RESCUE_COMMANDS.includes(a.startsWith('passkey') ? 'passkey' : a), a);

  const env = await setup();
  const { tok } = await rescueOk(env);
  for (const action of ['whoami', 'groups', 'passkey-list']) assert.equal((await call(env, { action }, tok)).status, 200, action);
  for (const body of [{ action: 'useradd', name: 'x1' }, { action: 'userdel', name: 'styrigx' }, { action: 'usermod', op: '-aG', groups: ['ai'], name: 'styrigx' },
    { action: 'passwd-user', name: 'styrigx' }, { action: 'who' }, { action: 'su', user: 'styrigx', password: PW.styrigx }, { action: 'idle' },
    { action: 'sudo', password: PW.root, command: { action: 'who' } }, { action: 'sudo', password: PW.root, command: { method: 'POST', path: '/api/account/proxy', body: { action: 'status' } } }]) {
    const r = await call(env, body, tok);
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.equal(r.json.error, 'permission');
  }
  const req = new Request(ORIGIN + '/', { headers: { Cookie: 'sgx-session=' + tok } });
  for (const [m, p] of [['GET', '/curio/api/export'], ['POST', '/api/account/proxy'], ['POST', '/curio/api/import'],
    ['DELETE', '/daymark/api/collections'], ['GET', '/api/space-audit'], ['PUT', '/api/profile'], ['GET', '/api/prefs'], ['POST', '/api/ai']]) {
    const c = await AD.admitRoute(env, req, m, p);
    assert.equal(c.allowed, false, m + ' ' + p);
    assert.equal(c.rescue, true);
  }
  const pw = await call(env, { action: 'passwd', password: 'root-rescued-pass-01' }, tok);
  assert.equal(pw.status, 200, JSON.stringify(pw.json));
  const e = await call(env, { action: 'exit' }, tok);
  assert.equal(e.json.user, null, '救援 exit 直接回访客');
  assert.equal(rows(env, 'SELECT * FROM account_sessions WHERE rescue = 1').length, 0);
});

test('重置后 epoch +1：救援里改 root 密码 → root epoch +1，别处的 su root 层作废，新密码可用', async () => {
  const env = await setup();
  const st = tokenOf(await call(env, { action: 'su', user: 'styrigx', password: PW.styrigx }));
  assert.equal((await call(env, { action: 'su', user: 'root', password: PW.root }, st)).status, 200);
  const e0 = rows(env, 'SELECT epoch FROM account_users WHERE uid = 0')[0].epoch;
  const { tok } = await rescueOk(env);
  assert.equal((await call(env, { action: 'passwd', password: 'root-rescued-pass-01' }, tok)).status, 200);
  assert.equal(rows(env, 'SELECT epoch FROM account_users WHERE uid = 0')[0].epoch, e0 + 1);
  const w = await call(env, { action: 'whoami' }, st);
  assert.equal(w.json.user.name, 'styrigx', 'root 层作废，栈底不动');
  assert.equal((await call(env, { action: 'whoami' }, tok)).json.user.rescue, true, '救援会话自己续命');
  assert.ok(rows(env, 'SELECT command FROM account_user_audit').some((a) => a.command === 'passwd rescue'));
  assert.equal((await call(env, { action: 'su', user: 'root', password: 'root-rescued-pass-01' }, st)).status, 200, '新密码可用');
});

test('15 分钟到期不续期：whoami 不续写；到期后回访客', async () => {
  const env = await setup();
  const { tok } = await rescueOk(env);
  const before = rows(env, 'SELECT expires_at, renewed_at FROM account_sessions')[0];
  const w = await call(env, { action: 'whoami' }, tok);
  assert.equal(w.json.user.rescue, true);
  assert.equal(w.cookies.filter((c) => c.startsWith('sgx-session=') && !/Max-Age=0|Expires=Thu, 01 Jan 1970/.test(c)).length, 0, '不发续期 cookie');
  assert.deepEqual(rows(env, 'SELECT expires_at, renewed_at FROM account_sessions')[0], before);
  env.D1_ACCOUNT.raw.prepare('UPDATE account_sessions SET expires_at = ?').run(Date.now() - 1);
  assert.equal((await call(env, { action: 'whoami' }, tok)).json.user, null);
  assert.equal((await call(env, { action: 'passwd', password: 'root-rescued-pass-01' }, tok)).status, 401);
});

test('限流：单独计数（不影响 su）；渐进退避 1s → 5s → 30s → 5min，不硬锁；按 IP 每分钟 6 次失败硬上限', async () => {
  assert.deepEqual([...R.RESCUE_BACKOFF.table], [1000, 5000, 30000, 300000]);
  assert.deepEqual({ ...R.RESCUE_IP_LIMIT }, { kind: 'v6-rescue-ip', max: 6, windowMs: 60000 });
  const env = await setup();
  const lock = () => { const r = rows(env, "SELECT locked_until - (expires_at - 86400000) AS d FROM account_attempt_limit WHERE kind = 'v6-rescue' AND bucket = 'root'")[0]; return r ? r.d : null; };
  /* 同 §十 用户名退避的现有实现（lib/attempt-limit.js recordAttempt max 1 + lockTable）：首次失败只记数，之后每次失败按轮次 1s → 5s → 30s → 5min */
  assert.equal((await call(env, { action: 'rescue', key: 'bad-first' })).status, 401);
  assert.equal(rows(env, "SELECT locked_until FROM account_attempt_limit WHERE kind = 'v6-rescue' AND bucket = 'root'")[0].locked_until, 0, '首次失败只记数');
  const want = [1000, 5000, 30000, 300000, 300000];
  for (let i = 0; i < want.length; i++) {
    const r = await call(env, { action: 'rescue', key: 'bad-' + i });
    assert.equal(r.status, 401, 'attempt ' + i);
    assert.equal(lock(), want[i], 'backoff ' + i);
    const blocked = await call(env, { action: 'rescue', key: KEY });
    assert.equal(blocked.status, 429, '退避中码对也不验');
    assert.equal(blocked.json.error, 'cooldown');
    unblock(env);
  }
  assert.equal(rows(env, "SELECT * FROM account_attempt_limit WHERE kind LIKE 'v6-name%' OR kind = 'v6-ip'").length, 0, '不和 su 共用计数');
  assert.equal((await call(env, { action: 'su', user: 'styrigx', password: PW.styrigx })).status, 200, 'su 不受影响');
  /* 同一 IP 每分钟 6 次失败 */
  const env2 = await setup();
  const ip = '203.0.113.9';
  for (let i = 0; i < 6; i++) { assert.equal((await call(env2, { action: 'rescue', key: 'bad' }, undefined, ip)).status, 401, 'ip ' + i); unblock2(env2); }
  const c = await call(env2, { action: 'rescue', key: KEY }, undefined, ip);
  assert.equal(c.status, 429, 'IP 满 6 次');
  assert.equal((await call(env2, { action: 'rescue', key: KEY }, undefined, '203.0.113.10')).status, 200, '别的 IP 照常');
  /* 成功后清掉退避 */
  assert.equal(rows(env2, "SELECT * FROM account_attempt_limit WHERE kind = 'v6-rescue' AND locked_until > 0").length, 0);
});
/** 只清退避那一维（IP 维度留着） */
function unblock2(env) { env.D1_ACCOUNT.raw.prepare("UPDATE account_attempt_limit SET locked_until = 0 WHERE kind = 'v6-rescue'").run(); }

test('代码纪律（定稿 §九）：账号 Worker 源码不出现 Secrets Store 写 / 删（运行时只有 get()）；救援钥匙只经 secrets.js 读', () => {
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.js')) files.push(p); } };
  walk(SRC);
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    assert.doesNotMatch(s, /secrets_store\/stores|\/secrets_store\b[^_]|api\.cloudflare\.com/i, f + '：不调 Secrets Store / Cloudflare REST');
    assert.doesNotMatch(s, /SGX_ACCOUNT_RESCUE_KEY\s*\]?\s*\.\s*(put|set|delete|create|update)\s*\(/, f);
    assert.doesNotMatch(s, /RESCUE_KEY_SECRET\s*\]\s*\.\s*(put|set|delete|create|update)\s*\(/, f);
  }
});
