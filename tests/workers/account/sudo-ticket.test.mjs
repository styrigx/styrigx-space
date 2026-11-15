/**
 * D-3 a′「先验后发票」（偏离稿 v3.12 第 9 节）：跨 Worker sudo 的一次性票（账号 Worker 侧）。
 * - POST /api/identity sudo-grant：只给 sudoers；每次验自己的凭据（输错 401 + login-fail 审计、不发票）；目标只认路由表标了 sudoTicket 且这一档是 root 的
 * - 库里只存票的 SHA-256，审计只记 sudo <方法> <路径> [action]，票本身不落库、不进审计
 * - AccountVerifier.sudoAdmit：同 uid、同会话、同方法、同路径、同 action、60 秒内才放行（root，sudo，sudoBy）；只能用一次；
 *   对不上的票同样作废；会话栈顶已是 root / 救援 / 不在 sudoers → 拒；并发两次核销只有一次成功
 *
 * 运行：node --test tests/workers/account/sudo-ticket.test.mjs
 */
import './_cf-workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAccountD1 } from './_d1.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const SRC = REPO + 'workers/account/src/';
const { serviceFetch } = await import(SRC + 'rpc/account-service.js');
const { checkSudoAdmit } = await import(SRC + 'rpc/account-verifier.js');
const { _resetSecretCache } = await import(SRC + 'secrets.js');
const { makePasswordRecord } = await import(SRC + 'core/password.js');
const T = await import(SRC + 'core/sudo-ticket.js');
const RA = await import(SRC + 'core/route-access.js');

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

const grant = (env, tok, command, pw) => id(env, { action: 'sudo-grant', password: pw === undefined ? PW.styrigx : pw, command }, tok, freshIp());
const ck = (tok) => 'sgx-session=' + tok;
const EXPORT = { method: 'GET', path: '/curio/api/export' };

test('路由表：只有 atlas-core 的四条 root 接口标了 sudoTicket；sudo-grant 是 sudoers 档、不在救援白名单', () => {
  const marked = RA.ROUTE_ACCESS.filter((r) => r.sudoTicket).map((r) => r.method + ' ' + r.path).sort();
  assert.deepEqual(marked, ['DELETE /daymark/api/collections', 'GET /curio/api/export', 'POST /curio/api/import', 'POST /curio/api/music']);
  for (const r of RA.ROUTE_ACCESS.filter((x) => x.sudoTicket)) assert.equal(r.worker, 'atlas-core', r.path);
  assert.equal(RA.levelOf('POST', '/api/identity', { action: 'sudo-grant' }), 'sudoers');
  assert.equal(RA.rescueOf('POST', '/api/identity', { action: 'sudo-grant' }), false);
});

test('ticketTarget：root 档才发；带 action 的按 action；账号自己的接口、写组档、查询串一律拒', () => {
  assert.equal(T.ticketTarget(EXPORT).ok, true);
  assert.equal(T.ticketTarget({ method: 'post', path: '/curio/api/import/' }).ok, true, '方法大小写、结尾 / 规范化');
  assert.equal(T.ticketTarget({ method: 'DELETE', path: '/daymark/api/collections' }).ok, true);
  assert.equal(T.ticketTarget({ method: 'POST', path: '/curio/api/music', action: 'album.del' }).ok, true);
  assert.equal(T.ticketTarget({ method: 'POST', path: '/curio/api/music' }).error, 'action', '音乐路由本身是写组档');
  assert.equal(T.ticketTarget({ method: 'POST', path: '/curio/api/music', action: 'album.edit' }).error, 'action');
  assert.equal(T.ticketTarget({ method: 'POST', path: '/curio/api/music', action: 'nope' }).error, 'action');
  assert.equal(T.ticketTarget({ method: 'POST', path: '/api/account/proxy' }).error, 'not-here', '账号自己的 root 接口走 sudo，不发票');
  assert.equal(T.ticketTarget({ method: 'POST', path: '/curio/api/items' }).error, 'not-here');
  assert.equal(T.ticketTarget({ method: 'GET', path: '/curio/api/export?lang=en' }).ok, false, '票不绑查询串');
  assert.equal(T.ticketTarget({ method: 'PATCH', path: '/curio/api/export' }).ok, false);
});

test('sudo-grant：sudoers 验自己的凭据领票；库里只存哈希；审计记 sudo <方法> <路径> [action]，不含票', async () => {
  const env = await setup();
  const tok = await login(env, 'styrigx');
  const r = await grant(env, tok, EXPORT);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.ticket, T.SUDO_TICKET_RE);
  const t = rows(env, 'SELECT * FROM account_sudo_tickets');
  assert.equal(t.length, 1);
  assert.notEqual(t[0].id, r.json.ticket, '库里不存票本身');
  assert.match(t[0].id, /^[0-9a-f]{64}$/);
  assert.equal(t[0].uid, 1000);
  assert.equal(t[0].expires_at - Date.now() <= T.SUDO_TICKET_TTL_MS, true);
  const r2 = await grant(env, tok, { method: 'POST', path: '/curio/api/music', action: 'album.del' });
  assert.equal(r2.status, 200);
  const audits = rows(env, 'SELECT command, ok, uid FROM account_user_audit').filter((a) => a.command.startsWith('sudo'));
  assert.deepEqual(audits.map((a) => a.command), ['sudo GET /curio/api/export', 'sudo POST /curio/api/music album.del']);
  assert.ok(audits.every((a) => a.uid === 1000));
  const all = JSON.stringify(rows(env, 'SELECT * FROM account_user_audit'));
  assert.ok(!all.includes(r.json.ticket) && !all.includes(r2.json.ticket), '审计里没有票');
});

test('sudo-grant：输错 401 + login-fail、不发票；不在 sudoers 403；访客 401；救援会话拒；目标不对 400', async () => {
  const env = await setup();
  const tok = await login(env, 'styrigx');
  const bad = await grant(env, tok, EXPORT, PW.root);
  assert.equal(bad.status, 401, '输的是自己的凭据，不是 root 的');
  assert.equal(rows(env, 'SELECT * FROM account_sudo_tickets').length, 0);
  assert.ok(rows(env, 'SELECT command FROM account_user_audit').some((a) => a.command === 'login-fail sudo'));
  const alice = await login(env, 'alice');
  assert.equal((await grant(env, alice, EXPORT, PW.alice)).status, 403);
  assert.equal((await grant(env, undefined, EXPORT)).status, 401);
  assert.equal((await grant(env, tok, { method: 'POST', path: '/api/account/proxy' })).status, 400);
  assert.equal((await grant(env, tok, { method: 'POST', path: '/curio/api/music', action: 'track.del' })).status, 400);
  assert.equal(rows(env, 'SELECT * FROM account_sudo_tickets').length, 0, '目标不对不验凭据也不发票');
});

test('sudoAdmit：对得上 → root（sudo，sudoBy = 本人），只能用一次', async () => {
  const env = await setup();
  const tok = await login(env, 'styrigx');
  const { ticket } = (await grant(env, tok, EXPORT)).json;
  const a = await checkSudoAdmit(env, ck(tok), ticket, 'GET', '/curio/api/export', {});
  assert.deepEqual({ allowed: a.allowed, uid: a.uid, root: a.root, sudo: a.sudo, sudoBy: a.sudoBy, action: a.action }, { allowed: true, uid: 0, root: true, sudo: true, sudoBy: 1000, action: '' });
  const b = await checkSudoAdmit(env, ck(tok), ticket, 'GET', '/curio/api/export', {});
  assert.equal(b.allowed, false, '第二次用 → 拒');
  assert.equal(b.reason, 'ticket');
  assert.equal(rows(env, 'SELECT * FROM account_sudo_tickets').length, 0);
});

test('sudoAdmit：方法 / 路径 / action 对不上 → 拒且票作废；别的会话、过期、坏票 → 拒', async () => {
  const env = await setup();
  const tok = await login(env, 'styrigx');
  const t1 = (await grant(env, tok, EXPORT)).json.ticket;
  assert.equal((await checkSudoAdmit(env, ck(tok), t1, 'POST', '/curio/api/import', {})).allowed, false, '换路径');
  assert.equal((await checkSudoAdmit(env, ck(tok), t1, 'GET', '/curio/api/export', {})).allowed, false, '对不上的票已作废，不给重试');
  const t2 = (await grant(env, tok, { method: 'POST', path: '/curio/api/music', action: 'album.del' })).json.ticket;
  assert.equal((await checkSudoAdmit(env, ck(tok), t2, 'POST', '/curio/api/music', { action: 'track.del' })).allowed, false, '换 action');
  const t3 = (await grant(env, tok, EXPORT)).json.ticket;
  const other = await login(env, 'styrigx');
  assert.equal((await checkSudoAdmit(env, ck(other), t3, 'GET', '/curio/api/export', {})).allowed, false, '同一个人的另一个会话');
  const t4 = (await grant(env, tok, EXPORT)).json.ticket;
  assert.equal((await checkSudoAdmit(env, ck(tok), t4, 'GET', '/curio/api/export', {}, Date.now() + T.SUDO_TICKET_TTL_MS + 1)).allowed, false, '过期');
  assert.equal((await checkSudoAdmit(env, ck(tok), 'x'.repeat(43), 'GET', '/curio/api/export', {})).allowed, false, '编的票');
  assert.equal((await checkSudoAdmit(env, ck(tok), 'short', 'GET', '/curio/api/export', {})).allowed, false);
  assert.equal((await checkSudoAdmit(env, '', t4, 'GET', '/curio/api/export', {})).allowed, false, '没会话');
});

test('sudoAdmit：会话栈顶已是 root（su root 后）→ 拒；发票时清掉过期行', async () => {
  const env = await setup();
  const tok = await login(env, 'styrigx');
  const t = (await grant(env, tok, EXPORT)).json.ticket;
  await suRoot(env, tok);
  const a = await checkSudoAdmit(env, ck(tok), t, 'GET', '/curio/api/export', {});
  assert.equal(a.allowed, false);
  assert.equal(a.reason, 'need-sudoers');
  env.D1_ACCOUNT.raw.prepare('INSERT INTO account_sudo_tickets (id, uid, session_id, method, path, action, expires_at) VALUES (?, 1000, ?, ?, ?, ?, ?)')
    .run('f'.repeat(64), 's', 'GET', '/curio/api/export', '', 1);
  await id(env, { action: 'exit' }, tok, freshIp());
  await grant(env, tok, EXPORT);
  assert.equal(rows(env, 'SELECT * FROM account_sudo_tickets WHERE expires_at <= ?', Date.now()).length, 0, '过期行已清');
});

test('sudoAdmit：并发两次核销同一张票只有一次成功', async () => {
  const env = await setup();
  const tok = await login(env, 'styrigx');
  const t = (await grant(env, tok, EXPORT)).json.ticket;
  const [a, b] = await Promise.all([checkSudoAdmit(env, ck(tok), t, 'GET', '/curio/api/export', {}), checkSudoAdmit(env, ck(tok), t, 'GET', '/curio/api/export', {})]);
  assert.equal([a.allowed, b.allowed].filter(Boolean).length, 1);
});
