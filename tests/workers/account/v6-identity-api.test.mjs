/**
 * v6 身份统一 P2：身份命令 POST /api/identity 与 v6 新会话下的账号接口（经 AccountService 的 serviceFetch，真 SQL：node:sqlite）。
 *
 * 覆盖定稿 v4 §十三「P2 必有测试」与本 PR 的硬要求：
 * - su <用户>：访客 → 普通用户（密码；v6 P4 起只有账号 pepper，pepper 方案 a 的 space 一档删除）；root 代码级禁止公开登录；
 *   普通用户态不能 su 到另一个普通用户（exit-first）；防枚举（用户不存在 = 密码错，同一个 401 auth）；两维限流
 * - su root：仅 wheel；压 root 层；who 路径 root via styrigx；exit 弹一层；idle 只弹 root 层；lock 删会话行
 * - sudo：每次输自己的凭据，借 root 执行一条，不压栈；sudo passwd root / passwd-user root / passkey 一律拒（root-creds）
 * - useradd：一次性密码只回一次、库里只存哈希、首登强制改、24 小时；-e 按 Asia/Shanghai 当日 00:00 起失效；临时用户进 wheel / sudoers / 写组被拒
 * - usermod：临时用户进特权 / 写组被拒；减最后一个 wheel / sudoers 成员先警告（force 才执行）；epoch +1 作废会话
 * - userdel：拒删 root、styrigx；连同会话、凭据、组一起删
 * - passwd：改自己的要先输当前密码（救援会话免）；自己改 → 当前会话续命、其他会话作废；passwd <名> → 该用户会话全部作废
 * - 救援会话：只放白名单（whoami / passwd / passkey / groups / exit / lock）；调别的 root 接口一律拒（即使 public 档）
 * - 名片 PUT：styrigx 能改、root 能改（写审计）、别的 uid 被拒
 * - 每条 user 路由「传他人 uid 被拒 / 被忽略」：prefs（两种表结构）、avatar、devices、passwd、groups、who
 * - 审计：不含密码 / 一次性密码
 *
 * 运行：node --test tests/workers/account/v6-identity-api.test.mjs
 */
import './_cf-workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeAccountD1 } from './_d1.mjs';
import { idSession, routeAccess as RA, admit as AD } from './_identity.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const SRC = REPO + 'workers/account/src/';
const { serviceFetch } = await import(SRC + 'rpc/account-service.js');
const { _resetSecretCache } = await import(SRC + 'secrets.js');
const { makePasswordRecord } = await import(SRC + 'core/password.js');
const stack = await import(SRC + 'core/identity-stack.js');
const auth = await import(SRC + 'core/identity-auth.js');
const users = await import(SRC + 'core/users.js');

const ORIGIN = 'https://styrigx.com';
const PEP_A = 'pepper-account-test';
const PEP_S = 'pepper-space-test'; /* v6 P4：旧 pepper 已删，只用来造一条「space」哈希，验它验不过 */
const PW = { root: 'root-pass-01', styrigx: 'sty-pass-01', alice: 'alice-pass-01', temp: 'temp-pass-01' };

function makeKv() {
  const m = new Map();
  return {
    m,
    async get(k) { const v = m.get(k); return v === undefined ? null : (v && v.value !== undefined ? v.value : v); },
    async getWithMetadata(k) { const v = m.get(k); return v ? { value: v.value ?? v, metadata: v.metadata ?? null } : { value: null, metadata: null }; },
    async put(k, v, opts) { m.set(k, opts && opts.metadata ? { value: v, metadata: opts.metadata } : v); },
    async delete(k) { m.delete(k); },
  };
}

let ipN = 0;
const freshIp = () => '198.51.100.' + (++ipN % 250);

async function setup() {
  _resetSecretCache();
  const env = {
    SGX_ENV: 'production', SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: ORIGIN,
    SGX_ACCOUNT_PASSWORD_PEPPER: PEP_A,
    D1_ACCOUNT: makeAccountD1(), KV_PROFILE: makeKv(),
    ASSETS: { fetch: async () => new Response('DEFAULT', { status: 200 }) },
  };
  const raw = env.D1_ACCOUNT.raw;
  const addUser = async (uid, name, pw, o = {}) => {
    raw.prepare('INSERT INTO account_users (uid, name, avatar, expires_at, epoch, disabled, created_at) VALUES (?, ?, \'\', ?, 0, 0, 1)').run(uid, name, o.expiresAt || 0);
    for (const g of o.groups || []) raw.prepare('INSERT INTO account_user_groups (uid, grp, added_at) VALUES (?, ?, 1)').run(uid, g);
    if (pw) {
      const rec = await makePasswordRecord(pw, o.pepperId === 'space' ? PEP_S : PEP_A);
      raw.prepare('INSERT INTO account_user_password (uid, record, pepper_id, must_change, expires_at) VALUES (?, ?, ?, 0, 0)').run(uid, JSON.stringify(rec), o.pepperId || 'account');
    }
  };
  await addUser(0, 'root', PW.root);
  await addUser(1000, 'styrigx', PW.styrigx, { groups: ['wheel', 'sudoers', 'listen', 'ai', 'status', 'curio-write', 'daymark-write'] });
  await addUser(1001, 'alice', PW.alice, { groups: ['listen'] });
  await addUser(1002, 'temp', PW.temp, { expiresAt: Date.now() + 30 * 86400000 });
  return env;
}

/** @param {any} env @param {string} method @param {string} path @param {{cookie?:string, body?:any, ip?:string, headers?:Record<string,string>, raw?:any}} [o] */
async function call(env, method, path, o = {}) {
  const headers = Object.assign({ Origin: ORIGIN, 'CF-Connecting-IP': o.ip || '203.0.113.7' }, o.headers || {});
  if (o.cookie) headers.Cookie = 'sgx-session=' + o.cookie;
  const init = { method, headers };
  if (o.raw !== undefined) init.body = o.raw;
  else if (o.body !== undefined) { init.body = JSON.stringify(o.body); headers['Content-Type'] = 'application/json'; }
  const res = await serviceFetch(new Request(ORIGIN + path, init), env, { waitUntil() {} });
  let json = null;
  try { json = JSON.parse(await res.clone().text()); } catch (e) {}
  return { res, status: res.status, json, cookies: res.headers.getSetCookie() };
}
const id = (env, body, cookie, ip) => call(env, 'POST', '/api/identity', { body, cookie, ip });
const tokenOf = (r) => { const c = r.cookies.find((x) => x.startsWith('sgx-session=')); return c ? c.split(';')[0].slice('sgx-session='.length) : ''; };

async function login(env, user, password, ip) {
  const r = await id(env, { action: 'su', user, password: password || PW[user] }, undefined, ip || freshIp());
  assert.equal(r.status, 200, 'su ' + user + ' ' + JSON.stringify(r.json));
  return tokenOf(r);
}
async function suRoot(env, tok) {
  const r = await id(env, { action: 'su', user: 'root', password: PW.root }, tok, freshIp());
  assert.equal(r.status, 200, 'su root ' + JSON.stringify(r.json));
  return r;
}
const rows = (env, sql, ...p) => env.D1_ACCOUNT.raw.prepare(sql).all(...p).map((r) => ({ ...r }));
async function rescueToken(env) {
  const s = await stack.issueRescueSession(env, { epoch: rows(env, 'SELECT epoch FROM account_users WHERE uid = 0')[0].epoch });
  return s.token;
}

/* ---------------- su / exit / lock / idle ---------------- */

test('su styrigx：访客 → 普通用户；cookie HttpOnly / Secure / SameSite=Lax / 30 天；账号 pepper；审计不含密码', async () => {
  const env = await setup();
  const r = await id(env, { action: 'su', user: 'styrigx', password: PW.styrigx }, undefined, freshIp());
  assert.equal(r.status, 200);
  assert.equal(r.json.user.name, 'styrigx');
  assert.equal(r.json.user.uid, 1000);
  assert.equal(r.json.user.owner, true);
  const c = r.cookies.find((x) => x.startsWith('sgx-session='));
  assert.match(c, /^sgx-session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
  assert.ok(r.cookies.includes('sgx-id=1; Path=/; Secure; SameSite=Lax; Max-Age=2592000'), '登录标记（非 HttpOnly、值固定 1，P2b）');
  assert.equal(rows(env, 'SELECT pepper_id FROM account_user_password WHERE uid = 1000')[0].pepper_id, 'account');
  const s = rows(env, 'SELECT uid, rescue FROM account_sessions');
  assert.deepEqual(s, [{ uid: 1000, rescue: 0 }]);
  assert.notEqual(rows(env, 'SELECT id FROM account_sessions')[0].id, tokenOf(r), '库里存的是令牌的哈希');
  const w = await id(env, { action: 'whoami' }, tokenOf(r));
  assert.equal(w.json.user.path, 'styrigx');
  /* 同一密码再登一次 */
  await login(env, 'styrigx');
  const audits = rows(env, 'SELECT command FROM account_user_audit').map((x) => x.command);
  assert.ok(audits.includes('su styrigx'));
  for (const a of audits) for (const p of Object.values(PW)) assert.ok(!a.includes(p), '审计里没有密码');
});

test('root 代码级禁止公开登录：访客 su root 403；issueSession 拒签 uid 0；防枚举：不存在的用户 = 密码错 = 401 auth', async () => {
  const env = await setup();
  const r = await id(env, { action: 'su', user: 'root', password: PW.root }, undefined, freshIp());
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'permission');
  assert.equal(rows(env, 'SELECT * FROM account_sessions').length, 0);
  await assert.rejects(() => stack.issueSession(env, { uid: 0, epoch: 0 }), /root-login-forbidden/);
  const a = await id(env, { action: 'su', user: 'nobody', password: 'whatever-1' }, undefined, freshIp());
  const b = await id(env, { action: 'su', user: 'alice', password: 'wrong-pass-1' }, undefined, freshIp());
  assert.equal(a.status, 401);
  assert.deepEqual(a.json, b.json, '同一个错误');
  assert.deepEqual(a.json, { ok: false, error: 'auth' });
  const t = await id(env, { action: 'su', user: 'temp', password: PW.temp }, undefined, freshIp());
  assert.equal(t.status, 200, '临时用户没到期可以登');
});

test('限流：同一用户名渐进退避（不硬锁）；同一 IP 每分钟 6 次失败后冷却；通行密钥 / 正确密码不计数', async () => {
  const env = await setup();
  const ip = freshIp();
  assert.equal((await id(env, { action: 'su', user: 'alice', password: 'bad-1aaaaa' }, undefined, ip)).status, 401);
  assert.equal((await id(env, { action: 'su', user: 'alice', password: 'bad-2aaaaa' }, undefined, freshIp())).status, 401);
  const c = await id(env, { action: 'su', user: 'alice', password: PW.alice }, undefined, freshIp());
  assert.equal(c.status, 429, '第二次失败后要等（1s → 5s → 30s → 5min）');
  assert.equal(c.json.error, 'cooldown');
  const row = rows(env, "SELECT strikes FROM account_attempt_limit WHERE kind = 'v6-name' AND bucket = 'n:alice'")[0];
  assert.equal(row.strikes, 1);
  /* IP 维度：换不同用户名，同一 IP 第 6 次失败后冷却 */
  const ip2 = freshIp();
  for (let i = 0; i < 6; i++) await id(env, { action: 'su', user: 'nobody' + i, password: 'x-pass-123' }, undefined, ip2);
  const d = await id(env, { action: 'su', user: 'styrigx', password: PW.styrigx }, undefined, ip2);
  assert.equal(d.status, 429, 'IP 硬上限');
  assert.deepEqual(auth.NAME_BACKOFF_MS, [1000, 5000, 30000, 300000]);
  assert.equal(auth.IP_LIMIT.max, 6);
});

test('普通用户态不能 su 到另一个普通用户（exit-first）；失效的令牌 whoami 时清 cookie', async () => {
  const env = await setup();
  const tok = await login(env, 'alice');
  const r = await id(env, { action: 'su', user: 'styrigx', password: PW.styrigx }, tok, freshIp());
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'exit-first');
  const bad = await id(env, { action: 'whoami' }, 'A'.repeat(43));
  assert.equal(bad.json.user, null);
  assert.ok(bad.cookies.some((c) => c.startsWith('sgx-session=;')), '清掉坏 cookie');
});

test('su root：仅 wheel；压 root 层（≤ 1 小时）；who 路径 root via styrigx；exit 弹一层 → styrigx → 访客（会话行删掉）', async () => {
  const env = await setup();
  const at = await login(env, 'alice');
  const no = await id(env, { action: 'su', user: 'root', password: PW.root }, at, freshIp());
  assert.equal(no.status, 403, 'alice 不在 wheel');
  assert.equal(no.json.need, 'wheel');
  const tok = await login(env, 'styrigx');
  const wrong = await id(env, { action: 'su', user: 'root', password: PW.styrigx }, tok, freshIp());
  assert.equal(wrong.status, 401, 'su root 输的是 root 的凭据，不是自己的');
  const r = await suRoot(env, tok);
  assert.equal(r.json.user.root, true);
  assert.equal(r.json.user.via, 'styrigx');
  assert.equal(r.json.user.path, 'root via styrigx');
  assert.equal(r.json.user.idleMs, 15 * 60 * 1000, '前台空闲 15 分钟由前端计时');
  const layer = rows(env, 'SELECT uid, pushed_at, expires_at FROM account_session_stack')[0];
  assert.equal(layer.uid, 0);
  assert.ok(layer.expires_at - layer.pushed_at <= 3600 * 1000);
  const again = await id(env, { action: 'su', user: 'root', password: PW.root }, tok, freshIp());
  assert.equal(again.json.error, 'already-root');
  const who = await id(env, { action: 'who' }, tok);
  assert.ok(who.json.sessions.some((s) => s.path === 'root via styrigx' && s.current), 'root 看全部、带路径');
  assert.ok(who.json.sessions.some((s) => s.path === 'alice'), 'root 看全部');
  const e1 = await id(env, { action: 'exit' }, tok);
  assert.equal(e1.json.user.name, 'styrigx');
  assert.equal(rows(env, 'SELECT * FROM account_session_stack').length, 0);
  const e2 = await id(env, { action: 'exit' }, tok);
  assert.equal(e2.json.user, null);
  assert.ok(e2.cookies.some((c) => c.startsWith('sgx-session=;')));
  assert.ok(e2.cookies.some((c) => c.startsWith('sgx-id=;')), '回访客时登录标记一起清');
  assert.equal((await id(env, { action: 'whoami' }, tok)).json.user, null);
  const audits = rows(env, 'SELECT command FROM account_user_audit').map((x) => x.command);
  for (const c of ['su root', 'exit root', 'exit', 'login-fail su root']) assert.ok(audits.includes(c), c);
});

test('idle：只弹 root 层，普通用户层不动；lock：清栈并删服务端会话行', async () => {
  const env = await setup();
  const tok = await login(env, 'styrigx');
  const n0 = await id(env, { action: 'idle' }, tok);
  assert.equal(n0.json.popped, false);
  assert.equal(n0.json.user.name, 'styrigx', '普通用户层空闲不退出');
  await suRoot(env, tok);
  const n1 = await id(env, { action: 'idle' }, tok);
  assert.equal(n1.json.popped, true);
  assert.equal(n1.json.user.name, 'styrigx');
  await suRoot(env, tok);
  const l = await id(env, { action: 'lock' }, tok);
  assert.equal(l.json.user, null);
  assert.equal(rows(env, 'SELECT * FROM account_sessions').length, 0);
  assert.equal(rows(env, 'SELECT * FROM account_session_stack').length, 0);
  /* 定稿 §六：lock 删服务端会话行——别的标签页（同一个令牌）下一次请求就失效，不靠前端刷新 */
  assert.equal((await id(env, { action: 'whoami' }, tok)).json.user, null, '同一令牌再问 whoami = 访客');
});

test('身份栈最多三层：栈表 CHECK depth = 1；root 层过期（1 小时）→ admit 弹回 styrigx', async () => {
  const env = await setup();
  const tok = await login(env, 'styrigx');
  await suRoot(env, tok);
  const sid = rows(env, 'SELECT id FROM account_sessions')[0].id;
  assert.throws(() => env.D1_ACCOUNT.raw.prepare('INSERT INTO account_session_stack (session_id, depth, uid, epoch, pushed_at, expires_at) VALUES (?, 2, 0, 0, 0, 9e15)').run(sid));
  env.D1_ACCOUNT.raw.prepare('UPDATE account_session_stack SET expires_at = ?').run(Date.now() - 1);
  assert.equal((await id(env, { action: 'whoami' }, tok)).json.user.name, 'styrigx');
});

/* ---------------- useradd / usermod / userdel / passwd <名> ---------------- */

test('useradd：一次性密码只回一次、16 位以上、库里只存哈希、首登强制改（带 newPassword 才签会话）、24 小时；-e 当日 00:00 北京时间起失效；临时用户 -G wheel / sudoers / 写组被拒', async () => {
  const env = await setup();
  const tok = await login(env, 'styrigx');
  const plain = await id(env, { action: 'useradd', name: 'bob' }, tok);
  assert.equal(plain.status, 403, 'styrigx 不是 root（要 su root / sudo）');
  assert.equal(plain.json.need, 'root');
  await suRoot(env, tok);
  for (const g of ['wheel', 'sudoers', 'curio-write', 'daymark-write']) {
    const r = await id(env, { action: 'useradd', name: 'guest1', expire: '2099-12-01', groups: [g] }, tok);
    assert.equal(r.status, 400, g);
    assert.equal(r.json.error, 'temporary', g);
  }
  assert.equal(rows(env, "SELECT * FROM account_users WHERE name = 'guest1'").length, 0, '整条命令不执行');
  assert.equal((await id(env, { action: 'useradd', name: 'old', expire: '2020-01-01' }, tok)).json.error, 'expiry');
  assert.equal((await id(env, { action: 'useradd', name: 'root' }, tok)).json.error, 'name');
  assert.equal((await id(env, { action: 'useradd', name: 'alice' }, tok)).json.error, 'exists');
  const r = await id(env, { action: 'useradd', name: 'guest1', expire: '2099-12-01', groups: 'listen,ai' }, tok);
  assert.equal(r.status, 200);
  assert.equal(r.json.user.uid, 1003);
  assert.deepEqual(r.json.user.groups, ['ai', 'listen']);
  assert.equal(r.json.user.expiresAt, Date.UTC(2099, 11, 1) - 8 * 3600 * 1000, '2099-12-01 00:00 Asia/Shanghai（存 UTC）');
  const otp = r.json.password;
  assert.ok(typeof otp === 'string' && otp.length >= 16);
  assert.equal(r.json.mustChange, true);
  const pw = rows(env, 'SELECT record, must_change, expires_at, pepper_id FROM account_user_password WHERE uid = 1003')[0];
  assert.ok(!pw.record.includes(otp), '只存哈希');
  assert.equal(pw.must_change, 1);
  assert.equal(pw.pepper_id, 'account');
  assert.ok(Math.abs(pw.expires_at - (Date.now() + 24 * 3600 * 1000)) < 60000, '24 小时过期');
  assert.ok(!rows(env, 'SELECT command FROM account_user_audit').some((a) => a.command.includes(otp)), '审计里没有一次性密码');
  /* 首登：不带 newPassword → 403 must-change、不签会话；带上 → 改密 + 签会话 */
  const g0 = await id(env, { action: 'su', user: 'guest1', password: otp }, undefined, freshIp());
  assert.equal(g0.status, 403);
  assert.equal(g0.json.error, 'must-change');
  assert.equal(tokenOf(g0), '');
  const weak = await id(env, { action: 'su', user: 'guest1', password: otp, newPassword: 'short' }, undefined, freshIp());
  assert.equal(weak.json.error, 'weak');
  const g1 = await id(env, { action: 'su', user: 'guest1', password: otp, newPassword: 'guest-new-pass' }, undefined, freshIp());
  assert.equal(g1.status, 200);
  assert.ok(tokenOf(g1));
  assert.equal(rows(env, 'SELECT must_change FROM account_user_password WHERE uid = 1003')[0].must_change, 0);
  assert.equal((await id(env, { action: 'su', user: 'guest1', password: otp }, undefined, freshIp())).status, 401, '一次性密码用过就作废');
  /* 一次性密码过期 */
  const r2 = await id(env, { action: 'useradd', name: 'late' }, tok);
  env.D1_ACCOUNT.raw.prepare('UPDATE account_user_password SET expires_at = ? WHERE uid = ?').run(Date.now() - 1, r2.json.user.uid);
  assert.equal((await id(env, { action: 'su', user: 'late', password: r2.json.password, newPassword: 'late-new-pass' }, undefined, freshIp())).status, 401);
  const audits = rows(env, 'SELECT command FROM account_user_audit').map((x) => x.command);
  assert.ok(audits.includes('useradd guest1 -e 2099-12-01 -G listen,ai'));
});

test('usermod：临时用户 -aG wheel / sudoers / 写组被拒；加组 epoch +1 作废会话；减最后一个 wheel 成员先 409 警告、force 才执行', async () => {
  const env = await setup();
  const tt = await login(env, 'temp');
  const tok = await login(env, 'styrigx');
  await suRoot(env, tok);
  for (const g of ['wheel', 'sudoers', 'curio-write', 'daymark-write']) {
    const r = await id(env, { action: 'usermod', op: '-aG', groups: [g], name: 'temp' }, tok);
    assert.equal(r.status, 400, g);
    assert.equal(r.json.error, 'temporary');
  }
  assert.equal(rows(env, 'SELECT * FROM account_user_groups WHERE uid = 1002').length, 0);
  assert.equal((await id(env, { action: 'whoami' }, tt)).json.user.name, 'temp', '被拒不动 epoch');
  const ok = await id(env, { action: 'usermod', op: '-aG', groups: ['listen'], name: 'temp' }, tok);
  assert.equal(ok.json.changed, true);
  assert.equal((await id(env, { action: 'whoami' }, tt)).json.user, null, '组变了 → 会话作废');
  assert.equal((await id(env, { action: 'usermod', op: '-aG', groups: ['wheel'], name: 'root' }, tok)).json.error, 'protected');
  const last = await id(env, { action: 'usermod', op: '-rG', groups: ['wheel'], name: 'styrigx' }, tok);
  assert.equal(last.status, 409);
  assert.equal(last.json.error, 'last-member');
  assert.equal(last.json.group, 'wheel');
  const forced = await id(env, { action: 'usermod', op: '-rG', groups: ['wheel'], name: 'styrigx', force: true }, tok);
  assert.equal(forced.json.warning, 'last-member');
  assert.equal((await id(env, { action: 'whoami' }, tok)).json.user, null, 'styrigx 自己的会话（连同 root 层）作废');
});

test('userdel：拒删 root、styrigx；删别人连同会话、身份栈、密码、通行密钥、组', async () => {
  const env = await setup();
  const at = await login(env, 'alice');
  env.D1_ACCOUNT.raw.prepare("INSERT INTO account_user_passkey (credential_id, uid, user_handle, legacy_handle, record) VALUES ('c1', 1001, 'h', '', '{}')").run();
  const tok = await login(env, 'styrigx');
  await suRoot(env, tok);
  const r0 = await id(env, { action: 'userdel', name: 'root' }, tok);
  assert.equal(r0.status, 403);
  assert.deepEqual(r0.json, { ok: false, error: 'protected', target: 'root' });
  const r1 = await id(env, { action: 'userdel', name: 'styrigx' }, tok);
  assert.deepEqual(r1.json, { ok: false, error: 'protected', target: 'owner' });
  assert.equal((await id(env, { action: 'userdel', name: 'ghost' }, tok)).status, 404);
  const r = await id(env, { action: 'userdel', name: 'alice' }, tok);
  assert.equal(r.status, 200);
  for (const t of ['account_user_groups', 'account_user_password', 'account_user_passkey', 'account_sessions']) {
    assert.equal(rows(env, 'SELECT * FROM ' + t + ' WHERE uid = 1001').length, 0, t);
  }
  /* P2c：用户行留墓碑，uid 永不复用（按 uid 存的头像 / 偏好 / 数字健康不会被新用户继承）；名字可再用 */
  assert.deepEqual(rows(env, 'SELECT name, disabled, expires_at FROM account_users WHERE uid = 1001'), [{ name: '#deleted-1001', disabled: 1, expires_at: 0 }]);
  assert.equal((await id(env, { action: 'whoami' }, at)).json.user, null);
  assert.equal((await id(env, { action: 'userdel', name: '#deleted-1001' }, tok)).status, 404, '墓碑查不到');
  assert.equal((await id(env, { action: 'su', user: '#deleted-1001', password: PW.alice }, undefined, freshIp())).status, 401);
  const again = await id(env, { action: 'useradd', name: 'alice' }, tok);
  assert.equal(again.status, 200);
  assert.ok(again.json.user.uid > 1002, 'uid 不复用');
});

test('passwd <名>：root 发一次性密码，该用户会话全部作废；目标是 root → root-creds', async () => {
  const env = await setup();
  const at = await login(env, 'alice');
  const tok = await login(env, 'styrigx');
  await suRoot(env, tok);
  const r = await id(env, { action: 'passwd-user', name: 'alice' }, tok);
  assert.equal(r.status, 200);
  assert.ok(r.json.password.length >= 16);
  assert.equal((await id(env, { action: 'whoami' }, at)).json.user, null);
  const rr = await id(env, { action: 'passwd-user', name: 'root' }, tok);
  assert.equal(rr.status, 403);
  assert.equal(rr.json.error, 'root-creds');
});

/* ---------------- sudo ---------------- */

test('sudo：sudoers 每次输自己的凭据、借 root 执行一条、不压栈；输错 401；不在 sudoers 403；sudo 动不了 root 的凭据', async () => {
  const env = await setup();
  const tok = await login(env, 'styrigx');
  const r = await id(env, { action: 'sudo', password: PW.styrigx, command: { action: 'useradd', name: 'carol' } }, tok, freshIp());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.user.name, 'carol');
  assert.equal(rows(env, 'SELECT * FROM account_session_stack').length, 0, 'sudo 不压栈');
  assert.equal((await id(env, { action: 'whoami' }, tok)).json.user.root, false, '不发票据：之后还是 styrigx');
  assert.equal((await id(env, { action: 'useradd', name: 'dave' }, tok)).status, 403, '下一条照样要 sudo');
  const bad = await id(env, { action: 'sudo', password: PW.root, command: { action: 'useradd', name: 'dave' } }, tok, freshIp());
  assert.equal(bad.status, 401, 'sudo 输的是自己的凭据，不是 root 的');
  for (const cmd of [{ action: 'passwd', password: 'new-root-pass' }, { action: 'passkey-add' }, { action: 'passkey-delete', n: 1 }]) {
    const x = await id(env, { action: 'sudo', password: PW.styrigx, command: cmd }, tok, freshIp());
    assert.equal(x.status, 403, cmd.action);
    assert.equal(x.json.error, 'root-creds', 'sudo passwd root / passkey 一律拒');
  }
  const pr = await id(env, { action: 'sudo', password: PW.styrigx, command: { action: 'passwd-user', name: 'root' } }, tok, freshIp());
  assert.equal(pr.status, 403);
  assert.equal(pr.json.error, 'root-creds', 'sudo passwd root（经 passwd <名>）同样拒');
  assert.equal((await id(env, { action: 'sudo', password: PW.styrigx, command: { action: 'su' } }, tok, freshIp())).json.error, 'action');
  const at = await login(env, 'alice');
  const na = await id(env, { action: 'sudo', password: PW.alice, command: { action: 'useradd', name: 'eve' } }, at, freshIp());
  assert.equal(na.status, 403);
  assert.equal(na.json.need, 'sudoers');
  const tt = await login(env, 'temp');
  assert.equal((await id(env, { action: 'sudo', password: PW.temp, command: { action: 'who' } }, tt, freshIp())).status, 403);
  const audits = rows(env, 'SELECT command, ok FROM account_user_audit').map((x) => x.command);
  assert.ok(audits.includes('sudo useradd carol'));
  assert.ok(audits.includes('login-fail sudo'));
});

/* ---------------- passwd（自己） ---------------- */

test('passwd：改自己的要先输当前密码；自己改 → 当前会话续命、自己的其他会话作废；救援会话改 root 免当前密码', async () => {
  const env = await setup();
  const t1 = await login(env, 'alice');
  const t2 = await login(env, 'alice');
  const no = await id(env, { action: 'passwd', current: 'wrong-pass-9', password: 'alice-new-pass' }, t1, freshIp());
  assert.equal(no.status, 401);
  const other = await id(env, { action: 'passwd', user: 'styrigx', current: PW.alice, password: 'alice-new-pass' }, t1, freshIp());
  assert.equal(other.status, 400, '传别人的名字被拒（改别人的是 root 的 passwd <名>）');
  assert.equal(other.json.error, 'target');
  const ok = await id(env, { action: 'passwd', current: PW.alice, password: 'alice-new-pass' }, t1, freshIp());
  assert.equal(ok.status, 200);
  assert.equal((await id(env, { action: 'whoami' }, t1)).json.user.name, 'alice', '当前会话续命');
  assert.equal((await id(env, { action: 'whoami' }, t2)).json.user, null, '其他会话作废');
  await login(env, 'alice', 'alice-new-pass');
  /* root 在 su root 里改自己的密码：要 root 的当前密码 */
  const tok = await login(env, 'styrigx');
  await suRoot(env, tok);
  assert.equal((await id(env, { action: 'passwd', current: PW.styrigx, password: 'root-new-pass' }, tok, freshIp())).status, 401);
  const rp = await id(env, { action: 'passwd', current: PW.root, password: 'root-new-pass' }, tok, freshIp());
  assert.equal(rp.status, 200, JSON.stringify(rp.json));
  assert.equal((await id(env, { action: 'whoami' }, tok)).json.user.root, true, '自己改 → root 层续命');
  /* 救援会话：不用当前密码 */
  const rt = await rescueToken(env);
  const rs = await id(env, { action: 'passwd', password: 'root-rescued-pass' }, rt, freshIp());
  assert.equal(rs.status, 200);
  assert.equal((await id(env, { action: 'whoami' }, tok)).json.user.name, 'styrigx', '救援改 root 密码 → 别处的 root 层作废，栈底不动');
  assert.ok(rows(env, 'SELECT command FROM account_user_audit').some((a) => a.command === 'passwd rescue'));
});

/* ---------------- 救援会话 ---------------- */

test('救援会话：白名单 whoami / passwd / passkey / groups / exit / lock 可用；su / sudo / useradd / userdel / usermod / passwd <名> / who 一律拒；其他 root 接口 admit 也拒（即使 public 档）', async () => {
  const env = await setup();
  const rt = await rescueToken(env);
  const w = await id(env, { action: 'whoami' }, rt);
  assert.equal(w.json.user.rescue, true);
  assert.equal(w.json.user.path, 'root (rescue)');
  assert.equal((await id(env, { action: 'groups' }, rt)).status, 200);
  assert.equal((await id(env, { action: 'passkey-list' }, rt)).status, 200);
  for (const body of [{ action: 'useradd', name: 'x1' }, { action: 'userdel', name: 'alice' }, { action: 'usermod', op: '-aG', groups: ['ai'], name: 'alice' },
    { action: 'passwd-user', name: 'alice' }, { action: 'who' }, { action: 'su', user: 'alice', password: PW.alice }, { action: 'sudo', password: 'x', command: { action: 'who' } }, { action: 'idle' }]) {
    const r = await id(env, body, rt, freshIp());
    assert.equal(r.status, 403, body.action);
    assert.equal(r.json.error, 'permission', body.action);
  }
  assert.equal(rows(env, "SELECT * FROM account_users WHERE name = 'x1'").length, 0);
  const req = new Request(ORIGIN + '/', { headers: { Cookie: 'sgx-session=' + rt } });
  for (const [m, p] of [['GET', '/curio/api/export'], ['POST', '/api/account/proxy'], ['POST', '/curio/api/import'], ['DELETE', '/daymark/api/collections'],
    ['GET', '/api/space-audit'], ['POST', '/api/ai'], ['PUT', '/api/profile'], ['GET', '/api/find'], ['GET', '/api/profile']]) {
    const c = await AD.admitRoute(env, req, m, p);
    assert.equal(c.allowed, false, m + ' ' + p);
    assert.equal(c.rescue, true);
  }
  assert.equal((await AD.admitRoute(env, req, 'POST', '/api/account/keys')).allowed, false, 'v6 P4：旧账号钥匙接口删除，路由表里没有这一条（救援只剩 /api/identity 的白名单）');
  /* 救援 exit 直接回访客 */
  const e = await id(env, { action: 'exit' }, rt);
  assert.equal(e.json.user, null);
  assert.equal(rows(env, 'SELECT * FROM account_sessions WHERE rescue = 1').length, 0);
});

test('救援会话：15 分钟、不续期；签发只经 issueRescueSession，唯一调用方是 P3 救援入口 core/rescue.js', async () => {
  const env = await setup();
  const s = await stack.issueRescueSession(env, { epoch: 0 }, 1000);
  assert.equal(s.expiresAt - 1000, 15 * 60 * 1000);
  assert.equal(await stack.renewSession(env, s.id, s.token, 2000), null);
  const src = readFileSync(SRC + 'api/identity.js', 'utf8') + readFileSync(SRC + 'rpc/account-service.js', 'utf8');
  assert.doesNotMatch(src, /issueRescueSession/, '接口层不直接签救援会话（只经 core/rescue.js，先验恢复钥匙）');
  assert.match(readFileSync(SRC + 'core/rescue.js', 'utf8'), /issueRescueSession/);
});

/* ---------------- 名片 PUT ---------------- */

test('名片 PUT /api/profile：styrigx 能改、root 能改（写审计 profile）、别的 uid 被拒（含临时用户）', async () => {
  const env = await setup();
  const put = (tok, body) => call(env, 'PUT', '/api/profile', { cookie: tok, body });
  const st = await login(env, 'styrigx');
  const a = await put(st, { nickname: 'Sty' });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.profile.nickname, 'Sty');
  const at = await login(env, 'alice');
  const b = await put(at, { nickname: 'Alice wins' });
  assert.ok(b.status === 401 || b.status === 403, 'alice 被拒');
  const tt = await login(env, 'temp');
  assert.ok((await put(tt, { nickname: 'Temp' })).status >= 400);
  const rt = await login(env, 'styrigx');
  await suRoot(env, rt);
  const c = await put(rt, { motto: 'root was here' });
  assert.equal(c.status, 200);
  const g = await call(env, 'GET', '/api/profile', { cookie: at });
  assert.equal(g.json.profile.nickname, 'Sty', 'alice 没改动名片');
  assert.equal(g.json.profile.motto, 'root was here');
  assert.ok(rows(env, 'SELECT command, uid FROM account_user_audit').some((x) => x.command === 'profile set motto' && x.uid === 0), 'root 改名片留痕');
  assert.equal(RA.levelOf('PUT', '/api/profile'), 'owner');
});

/* ---------------- user 路由：传他人 uid 被拒 / 被忽略 ---------------- */

const EVIL = { 'X-Styrigx-Uid': '1000', 'X-Uid': '1000' };

test('prefs：各读写各的；alice 塞 uid=1000（查询串 / 请求头 / 请求体）只写进自己的 1001', async () => {
  const env = await setup();
  env.D1_ACCOUNT.raw.prepare("INSERT INTO settings_sync (uid, k, v, t, updated_at) VALUES (1000, 'sgx-old', 'kept', 1, 1)").run();
  const now = Date.now();
  const at = await login(env, 'alice');
  const p = await call(env, 'POST', '/api/prefs?uid=1000', { cookie: at, headers: EVIL, body: { uid: 1000, changes: { 'sgx-old': { v: 'hacked', t: now } } } });
  assert.equal(p.status, 200);
  assert.deepEqual(p.json.items, { 'sgx-old': { v: 'hacked', t: now } }, 'alice 只看到自己的');
  assert.deepEqual(rows(env, 'SELECT uid, v FROM settings_sync ORDER BY uid'), [{ uid: 1000, v: 'kept' }, { uid: 1001, v: 'hacked' }]);
  const st = await login(env, 'styrigx');
  const g = await call(env, 'GET', '/api/prefs', { cookie: st });
  assert.deepEqual(g.json.items, { 'sgx-old': { v: 'kept', t: 1 } });
});

test('avatar：alice 换头像（塞 uid=1000）只写 avatar:u1001:*，站点头像 avatar:* 不动；GET /avatar/u1001-96.webp 读得到', async () => {
  const env = await setup();
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
  const fd = new FormData();
  for (const s of [32, 96, 192, 512]) fd.append(String(s), new Blob([PNG], { type: 'image/png' }), s + '.png');
  fd.append('uid', '1000');
  const at = await login(env, 'alice');
  const r = await call(env, 'PUT', '/api/avatar?uid=1000', { cookie: at, headers: EVIL, raw: fd });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const keys = [...env.KV_PROFILE.m.keys()].sort();
  assert.deepEqual(keys, ['avatar:u1001:192', 'avatar:u1001:32', 'avatar:u1001:512', 'avatar:u1001:96', 'avatar:u1001:ver']);
  const g = await call(env, 'GET', '/avatar/u1001-96.webp');
  assert.equal(g.res.headers.get('Content-Type'), 'image/png');
  const site = await call(env, 'GET', '/avatar/96.webp');
  assert.match(site.res.headers.get('ETag'), /^"d-96"$/, '站点头像仍是默认');
  const d = await call(env, 'DELETE', '/api/avatar', { cookie: at, headers: EVIL });
  assert.equal(d.status, 200);
  assert.equal(env.KV_PROFILE.m.size, 0);
});

test('devices（v6）：只列 / 只踢自己的会话；n 指不到别人的会话；revoke-all 只删自己的其他会话', async () => {
  const env = await setup();
  const st = await login(env, 'styrigx');
  const a1 = await login(env, 'alice');
  const a2 = await login(env, 'alice');
  const dv = (tok, body) => call(env, 'POST', '/api/account/devices', { cookie: tok, body, headers: EVIL });
  const l = await dv(a1, { action: 'list', uid: 1000 });
  assert.equal(l.status, 200, JSON.stringify(l.json));
  assert.equal(l.json.devices.length, 2);
  assert.ok(l.json.devices.every((d) => d.user === 'alice'));
  assert.equal((await dv(a1, { action: 'revoke', n: 1 })).json.error, 'current');
  assert.equal((await dv(a1, { action: 'revoke', n: 3 })).status, 404, '第 3 个不存在（styrigx 的会话不在 alice 的列表里）');
  assert.equal((await dv(a1, { action: 'revoke-all', uid: 1000 })).status, 200);
  assert.equal((await id(env, { action: 'whoami' }, a2)).json.user, null);
  assert.equal((await id(env, { action: 'whoami' }, st)).json.user.name, 'styrigx', 'styrigx 的会话没被踢');
});

test('groups / who：普通用户只看自己（groups <别人> 403）；root 看全部', async () => {
  const env = await setup();
  const at = await login(env, 'alice');
  const g = await id(env, { action: 'groups', uid: 1000 }, at);
  assert.deepEqual(g.json.groups, ['listen'], 'uid 参数不认');
  assert.equal((await id(env, { action: 'groups', user: 'styrigx' }, at)).status, 403);
  const st = await login(env, 'styrigx');
  const w = await id(env, { action: 'who', uid: 1000 }, at);
  assert.ok(w.json.sessions.every((s) => s.user === 'alice'));
  await suRoot(env, st);
  assert.deepEqual((await id(env, { action: 'groups', user: 'alice' }, st)).json.groups, ['listen']);
  assert.deepEqual((await id(env, { action: 'groups' }, st)).json.groups, ['root']);
  assert.ok((await id(env, { action: 'who' }, st)).json.sessions.some((s) => s.user === 'alice'));
});

test('滑动续期：剩余不足一半且距上次续期满一天才续写（whoami / 账号接口）；救援永不续', async () => {
  const env = await setup();
  const tok = await login(env, 'styrigx');
  const now = Date.now();
  env.D1_ACCOUNT.raw.prepare('UPDATE account_sessions SET created_at = ?, expires_at = ?').run(now - 20 * 86400000, now + 10 * 86400000);
  const w = await id(env, { action: 'whoami' }, tok);
  assert.ok(w.cookies.some((c) => c.startsWith('sgx-session=') && c.includes('Max-Age=2592000')));
  const s = rows(env, 'SELECT expires_at, renewed_at FROM account_sessions')[0];
  assert.ok(s.expires_at > now + 29 * 86400000);
  assert.ok(s.renewed_at >= now);
  const w2 = await id(env, { action: 'whoami' }, tok);
  assert.equal(w2.cookies.length, 0, '刚续过不再写');
  /* 账号接口上也续（已算过路由级结论时） */
  env.D1_ACCOUNT.raw.prepare('UPDATE account_sessions SET renewed_at = 0, created_at = ?, expires_at = ?').run(now - 20 * 86400000, now + 10 * 86400000);
  const p = await call(env, 'GET', '/api/prefs', { cookie: tok });
  assert.equal(p.status, 200);
  assert.ok(p.cookies.some((c) => c.startsWith('sgx-session=')));
});

test('请求要同源；不认识的 action 400；访客调 user 档 401', async () => {
  const env = await setup();
  const r = await serviceFetch(new Request(ORIGIN + '/api/identity', { method: 'POST', body: '{"action":"whoami"}' }), env, {});
  assert.equal(r.status, 403);
  assert.equal((await id(env, { action: 'recovery-key' })).json.error, 'action');
  assert.equal((await id(env, { action: 'passwd', current: 'x', password: 'y' })).status, 401);
  assert.equal((await id(env, { action: 'whoami' })).json.user, null);
});

test('epoch：凭据 / 组 / 期限任何变更都 bump（users.js），会话快照严格相等', async () => {
  const env = await setup();
  const at = await login(env, 'alice');
  await users.setUserExpiry(env, 1001, Date.now() + 86400000 * 3);
  assert.equal((await id(env, { action: 'whoami' }, at)).json.user, null, '期限变了 → 会话作废');
  assert.equal(rows(env, 'SELECT epoch FROM account_users WHERE uid = 1001')[0].epoch, 1);
  assert.equal(typeof idSession.admitSession, 'function');
});

/* ---------------- 通行密钥（v6 用户；可发现凭据，不按用户列钥匙） ---------------- */

const fx = await import('./_fixtures.mjs');
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function seedV6Passkey(env, uid, handle, legacy = '') {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const credId = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const rec = { name: '', provider: 'samsung-pass', aaguid: '', createdAt: 1, lastUsedAt: 0, credId, publicKey: jwk, signCount: 0, uv: 1 };
  env.D1_ACCOUNT.raw.prepare('INSERT INTO account_user_passkey (credential_id, uid, user_handle, legacy_handle, record) VALUES (?, ?, ?, ?, ?)').run(credId, uid, handle, legacy, JSON.stringify(rec));
  return { kp, credId };
}

test('su / su root / sudo 用通行密钥：challenge 不列钥匙（防枚举）；钥匙要属于目标用户；userHandle 认 user_handle 或 legacy_handle；UV 必须', async () => {
  const env = await setup();
  const sk = await seedV6Passkey(env, 1000, 'h-sty', 'h-legacy-lock');
  const rk = await seedV6Passkey(env, 0, 'h-root');
  const ch = await id(env, { action: 'su-challenge' });
  assert.equal(ch.status, 200);
  assert.deepEqual(ch.json.allowCredentials, [], '不列钥匙');
  /* 拿 styrigx 的钥匙登 alice → 401 auth（同一个错误） */
  const wrong = await id(env, { action: 'su', user: 'alice', cid: ch.json.cid, credential: await fx.assertion(sk.kp, sk.credId, ch.json.challenge, 'h-sty') }, undefined, freshIp());
  assert.deepEqual(wrong.json, { ok: false, error: 'auth' });
  const ch2 = await id(env, { action: 'su-challenge' });
  const noUv = await id(env, { action: 'su', user: 'styrigx', cid: ch2.json.cid, credential: await fx.assertion(sk.kp, sk.credId, ch2.json.challenge, 'h-sty', { uv: false }) }, undefined, freshIp());
  assert.equal(noUv.status, 401, 'UV 必须');
  const ch3 = await id(env, { action: 'su-challenge' });
  const ok = await id(env, { action: 'su', user: 'styrigx', cid: ch3.json.cid, credential: await fx.assertion(sk.kp, sk.credId, ch3.json.challenge, 'h-legacy-lock', { signCount: 2 }) }, undefined, freshIp());
  assert.equal(ok.status, 200, '迁来的钥匙带旧 userHandle 也认');
  const tok = tokenOf(ok);
  /* su root：root 的钥匙 */
  const ch4 = await id(env, { action: 'su-challenge' }, tok);
  const sr = await id(env, { action: 'su', user: 'root', cid: ch4.json.cid, credential: await fx.assertion(rk.kp, rk.credId, ch4.json.challenge, 'h-root') }, tok, freshIp());
  assert.equal(sr.status, 200);
  assert.equal(sr.json.user.path, 'root via styrigx');
  await id(env, { action: 'exit' }, tok);
  /* sudo：自己的钥匙（不是 root 的） */
  const ch5 = await id(env, { action: 'sudo-challenge' }, tok);
  const sRoot = await id(env, { action: 'sudo', cid: ch5.json.cid, credential: await fx.assertion(rk.kp, rk.credId, ch5.json.challenge, 'h-root', { signCount: 3 }), command: { action: 'who' } }, tok, freshIp());
  assert.equal(sRoot.status, 401, 'sudo 要自己的凭据');
  const ch6 = await id(env, { action: 'sudo-challenge' }, tok);
  const sOk = await id(env, { action: 'sudo', cid: ch6.json.cid, credential: await fx.assertion(sk.kp, sk.credId, ch6.json.challenge, 'h-sty', { signCount: 5 }), command: { action: 'who' } }, tok, freshIp());
  assert.equal(sOk.status, 200);
  /* challenge 用途分开：su 的 challenge 不能拿来 sudo */
  const ch7 = await id(env, { action: 'su-challenge' }, tok);
  const cross = await id(env, { action: 'sudo', cid: ch7.json.cid, credential: await fx.assertion(sk.kp, sk.credId, ch7.json.challenge, 'h-sty', { signCount: 7 }), command: { action: 'who' } }, tok, freshIp());
  assert.equal(cross.status, 401);
});

test('passkey ls / add / rm：只管自己的；add 的 user.id = 已有钥匙的 handle、name = 用户名（styrigx / root 分得开）；改了 → epoch +1，当前会话续命', async () => {
  const env = await setup();
  await seedV6Passkey(env, 1000, 'h-sty');
  await seedV6Passkey(env, 1001, 'h-alice');
  const t1 = await login(env, 'styrigx');
  const t2 = await login(env, 'styrigx');
  const l0 = await id(env, { action: 'passkey-list', uid: 1001 }, t1);
  assert.equal(l0.json.passkeys.length, 1, '只列自己的（uid 参数不认）');
  const ch = await id(env, { action: 'passkey-add-challenge' }, t1);
  assert.equal(ch.json.user.id, 'h-sty');
  assert.equal(ch.json.user.name, 'styrigx');
  assert.equal(ch.json.excludeCredentials.length, 1);
  const cred = await fx.makeAttestationCredential(ch.json.challenge, 'styrigx.com', ORIGIN);
  const forged = await id(env, { action: 'passkey-add', cid: ch.json.cid, credential: cred, handle: 'h-alice' }, t1);
  assert.equal(forged.status, 403, 'handle 对不上 challenge 的用途 → challenge 无效');
  const ch2 = await id(env, { action: 'passkey-add-challenge' }, t1);
  const cred2 = await fx.makeAttestationCredential(ch2.json.challenge, 'styrigx.com', ORIGIN);
  const add = await id(env, { action: 'passkey-add', cid: ch2.json.cid, credential: cred2, handle: ch2.json.user.id, name: 'S24' }, t1);
  assert.equal(add.status, 200, JSON.stringify(add.json));
  assert.equal((await id(env, { action: 'whoami' }, t1)).json.user.name, 'styrigx', '当前会话续命');
  assert.equal((await id(env, { action: 'whoami' }, t2)).json.user, null, '其他会话作废');
  const l1 = await id(env, { action: 'passkey-list' }, t1);
  assert.deepEqual(l1.json.passkeys.map((k) => k.n), [1, 2]);
  assert.equal(rows(env, 'SELECT user_handle FROM account_user_passkey WHERE uid = 1000 ORDER BY rowid')[1].user_handle, 'h-sty');
  assert.equal((await id(env, { action: 'passkey-delete', n: 2 }, t1)).status, 200);
  assert.equal((await id(env, { action: 'passkey-delete', n: 2 }, t1)).status, 404);
  assert.equal(rows(env, 'SELECT * FROM account_user_passkey WHERE uid = 1001').length, 1, 'alice 的钥匙没动');
});

test('pepper：按 pepper_id 取 pepper；v6 P4 起只有 account（space 删除）；不认识的 id / space → 验不过（fail closed）；缺账号 pepper → 503 config', async () => {
  const env = await setup();
  env.D1_ACCOUNT.raw.prepare("UPDATE account_user_password SET pepper_id = 'mystery' WHERE uid = 1001").run();
  assert.equal((await id(env, { action: 'su', user: 'alice', password: PW.alice }, undefined, freshIp())).status, 401);
  assert.deepEqual(Object.keys(auth.PEPPERS), ['account']);
  /* 一条按旧 space pepper 算的哈希：P4 起验不过（部署前已核生产库没有这种行） */
  const spaceRec = await makePasswordRecord(PW.temp, PEP_S);
  env.D1_ACCOUNT.raw.prepare("UPDATE account_user_password SET record = ?, pepper_id = 'space' WHERE uid = 1002").run(JSON.stringify(spaceRec));
  _resetSecretCache();
  assert.equal((await id({ ...env, SGX_SPACE_PASSWORD_PEPPER: PEP_S }, { action: 'su', user: 'temp', password: PW.temp }, undefined, freshIp())).status, 401, '就算 env 里还有旧 pepper 也不读');
  _resetSecretCache();
  const noA = { ...env, SGX_ACCOUNT_PASSWORD_PEPPER: '' };
  const r = await id(noA, { action: 'su', user: 'styrigx', password: PW.styrigx }, undefined, freshIp());
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'config');
  _resetSecretCache();
});


test('P2c 名片 GET /api/profile 公开（定稿 v5 §五）：访客 / 坏令牌 / 救援会话都 200，只回四个公开字段；PUT 照旧站长 + root', async () => {
  const env = await setup();
  env.KV_PROFILE.m.set('profile', JSON.stringify({ v: 1, nickname: 'Sty', private_note: 'nope', updatedAt: 7 }));
  for (const cookie of [undefined, 'bogus-token', await rescueToken(env)]) {
    const g = await call(env, 'GET', '/api/profile', { cookie });
    assert.equal(g.status, 200, String(cookie));
    assert.deepEqual(Object.keys(g.json.profile).sort(), ['email', 'motto', 'name', 'nickname']);
    assert.equal(g.json.profile.nickname, 'Sty');
    assert.ok(!JSON.stringify(g.json).includes('nope'), '存的别的键不回');
  }
  assert.equal(RA.levelOf('GET', '/api/profile'), 'public');
  assert.ok((await call(env, 'PUT', '/api/profile', { body: { nickname: 'x' } })).status >= 400, '访客 PUT 被拒');
});

/* ---------------- P2c：到期满宽限期自动删除 ---------------- */

const expiry = await import(SRC + 'core/user-expiry.js');
const { AccountJanitor } = await import(SRC + 'rpc/account-janitor.js');

test('P2c 到期自动删除：到期满 30 天（一个常量）的用户连同会话 / 身份栈 / 凭据 / 组删掉，同 userdel；宽限期内的、没期限的、root、styrigx 不动；写审计 expire', async () => {
  assert.equal(expiry.EXPIRED_USER_GRACE_MS, 30 * 86400000, '宽限期 30 天');
  const env = await setup();
  const raw = env.D1_ACCOUNT.raw;
  const now = Date.now();
  const tt = await login(env, 'temp');
  /* temp 到期 31 天；再造一个宽限期内的（到期 29 天） */
  raw.prepare("INSERT INTO account_users (uid, name, avatar, expires_at, epoch, disabled, created_at) VALUES (1003, 'bob', '', ?, 0, 0, 1)").run(now - 29 * 86400000);
  raw.prepare("INSERT INTO account_user_groups (uid, grp, added_at) VALUES (1003, 'listen', 1)").run();
  raw.prepare('UPDATE account_users SET expires_at = ? WHERE uid = 1002').run(now - 31 * 86400000);
  raw.prepare("INSERT INTO account_user_groups (uid, grp, added_at) VALUES (1002, 'listen', 1)").run();
  raw.prepare("INSERT INTO account_user_passkey (credential_id, uid, user_handle, legacy_handle, record) VALUES ('ct', 1002, 'h', '', '{}')").run();
  /* root / styrigx 即使库里被写了期限也永不删 */
  raw.prepare('UPDATE account_users SET expires_at = ? WHERE uid IN (0, 1000)').run(now - 365 * 86400000);
  assert.equal((await id(env, { action: 'whoami' }, tt)).json.user, null, '到期即作废会话（P2 已有）');
  const r = await expiry.purgeExpiredUsers(env, now);
  assert.deepEqual(r.deleted, ['temp']);
  for (const t of ['account_user_groups', 'account_user_password', 'account_user_passkey', 'account_sessions']) {
    assert.equal(rows(env, 'SELECT * FROM ' + t + ' WHERE uid = 1002').length, 0, t);
  }
  assert.deepEqual(rows(env, 'SELECT name, disabled FROM account_users WHERE uid = 1002'), [{ name: '#deleted-1002', disabled: 1 }], '墓碑，同 userdel');
  assert.deepEqual(rows(env, "SELECT uid FROM account_users WHERE disabled = 0 ORDER BY uid").map((x) => x.uid), [0, 1000, 1001, 1003]);
  assert.ok(rows(env, 'SELECT command, uid FROM account_user_audit').some((x) => x.command === 'expire userdel temp' && x.uid === null));
  /* 再跑一遍什么都不删；bob 满 30 天后才删 */
  assert.deepEqual((await expiry.purgeExpiredUsers(env, now)).deleted, []);
  assert.deepEqual((await expiry.purgeExpiredUsers(env, now + 2 * 86400000)).deleted, ['bob']);
  assert.deepEqual(rows(env, "SELECT uid FROM account_users WHERE disabled = 0 ORDER BY uid").map((x) => x.uid), [0, 1000, 1001]);
});

test('P2c 到期自动删除的触发：AccountJanitor.purgeExpiredUsers（status 每日一轮经 JOB_ACCOUNT 调）只回个数、出错不抛；useradd 前懒清理（同名的过期用户不挡新建）', async () => {
  const env = await setup();
  env.D1_ACCOUNT.raw.prepare('UPDATE account_users SET expires_at = ? WHERE uid = 1002').run(Date.now() - 40 * 86400000);
  const j = new AccountJanitor({}, env);
  assert.deepEqual(await j.purgeExpiredUsers(Date.now()), { ok: true, deleted: 1 });
  const broken = new AccountJanitor({}, {});
  const e = console.error; console.error = () => {};
  try { assert.deepEqual(await broken.purgeExpiredUsers(Date.now()), { ok: false, deleted: 0 }); } finally { console.error = e; }
  /* 懒清理：alice 到期满 30 天 → root useradd alice 成功（旧的先被删掉，uid 换新） */
  env.D1_ACCOUNT.raw.prepare('UPDATE account_users SET expires_at = ? WHERE uid = 1001').run(Date.now() - 31 * 86400000);
  const tok = await login(env, 'styrigx');
  await suRoot(env, tok);
  const r = await id(env, { action: 'useradd', name: 'alice' }, tok);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.user.uid > 1002, 'uid 不复用');
  assert.equal(rows(env, 'SELECT * FROM account_user_groups WHERE uid = 1001').length, 0, '旧 alice 的组跟着删了');
});

/* ---------------- P2c：sudo 借 root 执行任何一条（账号 Worker 内） ---------------- */

test('P2c sudo <任意 root 档接口>：sudoers 非站长用户 sudo PUT /api/profile → 200（每次验自己的凭据、不发票据、不压栈）；审计记真正执行的人', async () => {
  const env = await setup();
  env.D1_ACCOUNT.raw.prepare("INSERT INTO account_user_groups (uid, grp, added_at) VALUES (1001, 'sudoers', 1)").run();
  const at = await login(env, 'alice');
  const direct = await call(env, 'PUT', '/api/profile', { cookie: at, body: { nickname: 'A' } });
  assert.ok(direct.status === 401 || direct.status === 403, 'alice 不是站长，直接改被拒');
  const cmd = { method: 'PUT', path: '/api/profile', body: { nickname: 'Alice via sudo' } };
  const bad = await id(env, { action: 'sudo', password: PW.root, command: cmd }, at, freshIp());
  assert.equal(bad.status, 401, '输的是自己的凭据');
  const r = await id(env, { action: 'sudo', password: PW.alice, command: cmd }, at, freshIp());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.profile.nickname, 'Alice via sudo');
  assert.equal(rows(env, 'SELECT * FROM account_session_stack').length, 0, '不压栈');
  assert.equal((await id(env, { action: 'whoami' }, at)).json.user.root, false, '不发票据');
  assert.ok((await call(env, 'PUT', '/api/profile', { cookie: at, body: { nickname: 'B' } })).status >= 400, '下一条照样被拒');
  const au = rows(env, 'SELECT command, uid, ok FROM account_user_audit');
  assert.ok(au.some((x) => x.command === 'sudo PUT /api/profile' && x.uid === 1001 && x.ok === 1), JSON.stringify(au));
  assert.ok(au.some((x) => x.command === 'profile set nickname via sudo' && x.uid === 1001), 'root 的特权内容操作留痕：记真正执行的人');
  for (const a of au) assert.ok(!a.command.includes(PW.alice));
  /* 不在 sudoers → 403；临时用户 → 403 */
  const sty = await login(env, 'styrigx');
  env.D1_ACCOUNT.raw.prepare("DELETE FROM account_user_groups WHERE uid = 1001 AND grp = 'sudoers'").run();
  const at2 = await login(env, 'alice');
  assert.equal((await id(env, { action: 'sudo', password: PW.alice, command: cmd }, at2, freshIp())).status, 403);
  assert.ok(sty);
});

test('P2c sudo 的目标：身份接口本身 400 action；v6 P4 删掉的旧接口（/api/account/keys、reset、session、reauth）不在路由表 → 400 action；别的 Worker 的接口 400 not-here；查不到档 400；GET 带 body 400；旧写法（command.action）照旧', async () => {
  const env = await setup();
  const tok = await login(env, 'styrigx');
  const sudo = (command) => id(env, { action: 'sudo', password: PW.styrigx, command }, tok, freshIp());
  for (const [command, status, error] of [
    [{ method: 'POST', path: '/api/account/keys', body: { action: 'password-set' } }, 400, 'action'],
    [{ method: 'POST', path: '/api/account/keys/', body: { action: 'passkey-add' } }, 400, 'action'],
    [{ method: 'POST', path: '/api/account/reset', body: { action: 'password-set' } }, 400, 'action'],
    [{ method: 'POST', path: '/api/identity', body: { action: 'passwd' } }, 400, 'action'],
    [{ method: 'POST', path: '/api/account/session', body: { action: 'password' } }, 400, 'action'],
    [{ method: 'POST', path: '/api/account/reauth' }, 400, 'action'],
    [{ method: 'GET', path: '/curio/api/export' }, 400, 'not-here'],
    [{ method: 'DELETE', path: '/daymark/api/collections' }, 400, 'not-here'],
    [{ method: 'GET', path: '/api/space-audit' }, 400, 'not-here'],
    [{ method: 'GET', path: '/api/nope' }, 400, 'action'],
    [{ method: 'POST', path: '/api/account/proxy', body: { action: 'nope' } }, 400, 'action'],
    [{ method: 'PATCH', path: '/api/profile' }, 400, 'action'],
    [{ method: 'GET', path: '//evil.example/api/profile' }, 400, 'action'],
    [{ method: 'GET', path: '/api/profile', body: { a: 1 } }, 400, 'body'],
  ]) {
    const r = await sudo(command);
    assert.equal(r.status, status, JSON.stringify(command) + ' ' + JSON.stringify(r.json));
    assert.equal(r.json.error, error, JSON.stringify(command));
  }
  assert.equal(rows(env, "SELECT * FROM account_user_audit WHERE command LIKE 'sudo %'").length, 0, '目标不合法：不验凭据、不执行、不记 sudo');
  /* 旧写法照旧：身份命令 */
  assert.equal((await sudo({ action: 'useradd', name: 'zed' })).status, 200);
  assert.equal((await sudo({ action: 'passwd', password: 'x-new-pass-123' })).json.error, 'root-creds');
  /* 账号 Worker 内认 v6 的接口都能借：GET /api/profile、POST /api/account/devices list（借来的 root 只看 root 自己的会话，不越权） */
  const g = await sudo({ method: 'GET', path: '/api/profile' });
  assert.equal(g.status, 200);
  const d = await sudo({ method: 'POST', path: '/api/account/devices', body: { action: 'list' } });
  assert.equal(d.status, 200, JSON.stringify(d.json));
});

test('P2c sudo 不能动 root 的凭据（栈顶必须是 root）：sudo 下 identity passwd / passkey 全拒（旧 keys / reset 接口已删，400 action）；su root 后（栈顶 root）passwd 改 root 才行', async () => {
  const env = await setup();
  const tok = await login(env, 'styrigx');
  for (const command of [{ action: 'passwd', password: 'n-e-w-pass-1' }, { action: 'passkey-add' }]) {
    const r = await id(env, { action: 'sudo', password: PW.styrigx, command }, tok, freshIp());
    assert.equal(r.json.error, 'root-creds', JSON.stringify(command));
  }
  assert.equal((await id(env, { action: 'sudo', password: PW.styrigx, command: { method: 'POST', path: '/api/account/keys', body: { action: 'password-set', password: 'n-e-w-pass-1' } } }, tok, freshIp())).json.error, 'action');
  await suRoot(env, tok);
  const p = await id(env, { action: 'passwd', current: PW.root, password: 'root-pass-02x' }, tok, freshIp());
  assert.equal(p.status, 200, JSON.stringify(p.json));
});
