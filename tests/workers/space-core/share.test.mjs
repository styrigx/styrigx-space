/**
 * 分享链接（进站 v3 L2：原分享短链 Worker styrigx-share 并入 styrigx-space-core；workers/space-core/src/api/share.js、core/share-open.js、
 * core/share-links.js，签 / 作废短链钥匙在 core/link-keys.js）。
 * 运行：node --test tests/workers/space-core/share.test.mjs
 *
 * 跑真代码：styrigx-space-core 的 default.fetch（app.js → router.js routeShare）；env 用临时 Ed25519 钥匙 + 进站 D1 替身（makeAuthD1）+ 分享 D1。
 * D1：有 node:sqlite 时真 SQL（migrations/0001_baseline.sql + core/share-links.js 的语句）和内存替身各跑一遍；Node 20 只跑内存替身。
 *
 * - 规则：码 128 位、目标只收站内相对路径（防开放重定向）、有效期 / 会话档位、会话不超过有效期
 * - 生成（v5 S1）：不签任何钥匙（v5 收尾删了 tempkey 表和 share_link.key_id 列）；要进门且不是分享链接进来的会话（不问账号会话）
 * - 点开：带会话 → 签 by=link 的进站会话（票里 linkId = share_link.id）（Max-Age = min(会话, 剩余)），302 到干净目标；普通 → 只 302；
 *   已进门的人点开不降级；预取 / HEAD 不发会话；不存在 / 过期 / 作废 / 格式不对 → 同一个响应；限速
 * - 作废：写 share_link.revoked_at（rm / rm --all），已发出的链接会话下一个请求就进不来；链接到期同样；纪元推进同样
 * - 权限：只认进站会话（不问账号会话）；管理（list / revoke）另要锁侧复验（401 reauth）；by=link 的会话新建 / 管理一律 403 link；
 *   没会话 401、跨源 403
 * - 清理入口 purgeDeadLinks：只删过期 / 作废满 7 天的行，一条 DELETE
 * - 路由：/s/*、/api/share 在 styrigx-space-core 的 styrigx.com/* 里；没有单独的短链 Worker
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { shareD1, HAS_SQLITE } from '../../fixtures/share-d1.mjs';
import { testLockSession, testTicket } from '../space-core/_tickets.mjs';
import { makeAuthD1, genKeyPair } from '../_harness.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const worker = (await import(REPO + 'workers/space-core/src/app.js')).default;
const links = await import(REPO + 'workers/space-core/src/core/share-links.js');
const { _resetMem, _setRandom } = await import(REPO + 'workers/space-core/src/core/share-open.js');
const issuerMod = await import(REPO + 'workers/space-core/src/core/link-keys.js');
const { signLockSessionTicket } = await import(REPO + 'workers/space-core/src/core/lock-session.js');
const { verifyLockSession } = await import(REPO + 'workers/space-core/src/core/lock-session.js');

const LOCK = await genKeyPair();
const H = 3600e3;

/** v5 收尾：tempkey 表已删（migrations/0002_drop_tempkey.sql）——每个用例都核对它不在 */
const tempkeyRows = (authDb) => authDb.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'tempkey'").get().n;

/** 改分享替身里的一行（sqlite / 内存两种） @param {any} db @param {string} id @param {Record<string, any>} patch */
function patchLink(db, id, patch) {
  if (db.raw) {
    for (const [k, v] of Object.entries(patch)) db.raw.prepare('UPDATE share_link SET ' + k + ' = ? WHERE id = ?').run(v, id);
  } else Object.assign(db._links.get(id), patch);
}

/** 让分享替身的某类语句出错 @param {any} db @param {RegExp} re */
function failShareOn(db, re) {
  const prep = db.prepare.bind(db);
  db.prepare = (sql) => { if (re.test(sql)) throw new Error('d1 down'); return prep(sql); };
}

/**
 * 进站 v3 L2b：进站和分享链接同一个库、同一个绑定 D1_SPACE。测试里两半还是各一份替身（分享那半要跑 sqlite / 内存两种），
 * 按语句碰的表分流：share_link / share_fail → 分享替身，其余 → 进站替身。每次调用时才取 prepare（failOn 换掉的也生效）。
 */
function spaceD1(authDb, shareDb) {
  return {
    prepare: (sql) => (/\bshare_(link|fail)\b/.test(sql) ? shareDb : authDb).prepare(sql),
    batch: (stmts) => authDb.batch(stmts), /* 分享链接不用 batch；进站的 batch 语句都是进站那半 prepare 出来的 */
  };
}

/** 一个 env（styrigx-space-core 自己的绑定）：D1_SPACE（进站 + 分享）+ 4 个 SGX_SPACE_* 测试值 */
function setup(d1opts) {
  const authDb = makeAuthD1(); /* 进站那半：纪元等（share_link / share_fail 走分享那半） */
  const db = shareD1(d1opts);
  const env = {
    D1_SPACE: spaceD1(authDb, db),
    SGX_SPACE_PRIVATE: LOCK.priv, SGX_SPACE_PUBLIC: LOCK.pub,
    SGX_SPACE_RECOVERY_KEY: 'share-test-recovery', SGX_SPACE_PASSWORD_PEPPER: 'share-test-password-pepper',
    SGX_ENV: 'production', SGX_SITE: 'space',
  };
  _resetMem();
  return { authDb, gwEnv: env, db, env };
}

/** 让进站 D1 的某类语句出错（模拟 D1 故障），其余照常 @param {any} authDb @param {RegExp} re */
function failOn(authDb, re) {
  const prep = authDb.prepare.bind(authDb);
  authDb.prepare = (sql) => { if (re.test(sql)) throw new Error('d1 down'); return prep(sql); };
}

/** 进门（锁屏密码）+ 锁侧复验票（lockkey 签出）；没有账号会话 cookie */
async function adminCookie() {
  const lock = await testLockSession(LOCK.priv, 0, 'password');
  return 'sgx-space-session=' + lock + '; sgx-space-reauth=' + (await testTicket(LOCK.priv, 'LockReauthTicket', 'password', 0));
}
/** 只进门（任何进门方式），没有锁侧复验 */
async function inCookie(by = 'password') {
  return 'sgx-space-session=' + (await testLockSession(LOCK.priv, 0, by));
}

const ctx = { waitUntil() {} };
async function api(env, body, cookie, origin) {
  const res = await worker.fetch(new Request('https://styrigx.com/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin || 'https://styrigx.com', Cookie: cookie === undefined ? await adminCookie() : cookie },
    body: JSON.stringify(body),
  }), env, ctx);
  return { s: res.status, j: await res.json(), res };
}
function open(env, path, opts = {}) {
  const headers = Object.assign({ 'CF-Connecting-IP': opts.ip || '7.7.7.7' }, opts.cookie ? { Cookie: opts.cookie } : {}, opts.headers || {});
  return worker.fetch(new Request('https://styrigx.com' + path, { method: opts.method || 'GET', headers }), env, ctx);
}
/** Set-Cookie → Cookie 头（sgx-space-session 带 Domain 的那条） */
function cookiesFrom(res) {
  return res.headers.getSetCookie()
    .filter((c) => c.startsWith('sgx-space-session=') && !c.startsWith('sgx-space-session=;'))
    .map((c) => c.split(';')[0])
    .join('; ');
}
const age = (res, name) => parseInt(/Max-Age=(\d+)/.exec(res.headers.getSetCookie().find((c) => c.startsWith(name + '=')))[1], 10);

/** 统一失败响应：每一项都一样，也不发 cookie */
async function failShape(res) {
  return {
    status: res.status, loc: res.headers.get('Location'), cc: res.headers.get('Cache-Control'),
    ref: res.headers.get('Referrer-Policy'), robots: res.headers.get('X-Robots-Tag'), cookies: res.headers.getSetCookie().length,
    body: await res.text(),
  };
}
const FAIL = { status: 302, loc: 'https://styrigx.com/?entry=1', cc: 'private, no-store', ref: 'no-referrer', robots: 'noindex', cookies: 0, body: '' };

/* ---------------- 规则 ---------------- */

test('码：16 字节随机 → 22 位 base64url；50 个各不相同；id 16 位', () => {
  const s = new Set();
  for (let i = 0; i < 50; i++) {
    const c = links.newCode();
    assert.match(c, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(Buffer.from(c, 'base64url').length, 16);
    s.add(c);
  }
  assert.equal(s.size, 50);
  assert.ok(links.isId(links.newId()));
});

test('目标：站内相对路径或 https://styrigx.com 的地址（一律存相对路径），拒绝开放重定向和已下线的 atlas.styrigx.com', () => {
  assert.equal(links.cleanTarget(undefined), '/');
  assert.equal(links.cleanTarget(''), '/');
  assert.equal(links.cleanTarget(' /blog/x/?a=1#b '), '/blog/x/?a=1#b');
  assert.equal(links.cleanTarget('/a/../b/'), '/b/');
  assert.equal(links.cleanTarget('/%2F%2Fevil.com'), '/%2F%2Fevil.com', '编码的斜杠留在路径里，仍是同源');
  /* 主站绝对地址存成相对路径；主机大小写不敏感 */
  assert.deepEqual([...links.TARGET_HOSTS], ['styrigx.com']);
  assert.equal(links.cleanTarget('https://styrigx.com/blog/post/hello/'), '/blog/post/hello/');
  assert.equal(links.cleanTarget('https://styrigx.com'), '/');
  assert.equal(links.cleanTarget('https://Styrigx.COM/blog/zh/post/a/?x=1#h'), '/blog/zh/post/a/?x=1#h');
  assert.equal(links.cleanTarget('https://styrigx.com/blog/?a=1'), '/blog/?a=1');
  assert.equal(links.cleanTarget('https://styrigx.com/blog/post/%E4%BD%A0%E5%A5%BD/'), '/blog/post/%E4%BD%A0%E5%A5%BD/');
  assert.equal(links.cleanTarget('https://styrigx.com/blog/post/你好/'), '/blog/post/%E4%BD%A0%E5%A5%BD/', '中文路径编码后存');
  /* 去掉锁屏 / 回跳 / 分享参数，其他参数保留 */
  assert.equal(links.cleanTarget('https://styrigx.com/blog/p/?lock=1&why=x&return=https%3A%2F%2Fevil.com&share=1&q=a'), '/blog/p/?q=a');
  assert.equal(links.cleanTarget('/display/?lock=1'), '/display/');
  /* 子站下的 /<站>/s/ 不是短链，可以；/api/ 和 /<站>/api/ 不行 */
  assert.equal(links.cleanTarget('https://styrigx.com/blog/s/x/'), '/blog/s/x/');
  assert.equal(links.cleanTarget('https://styrigx.com/blog/apix/'), '/blog/apix/');
  assert.equal(links.targetUrl('/blog/'), 'https://styrigx.com/blog/');
  /* 合并 PR3：子站在主域名 /blog/ /curio/ /daymark/ 下（存相对路径）；主域名上的 /<站>/api/ 同样不能当目标 */
  assert.equal(links.cleanTarget('https://styrigx.com/curio/zh/?a=1'), '/curio/zh/?a=1');
  assert.equal(links.cleanTarget('/daymark/#trove'), '/daymark/#trove');
  for (const bad of ['/curio/api/links', '/daymark/api', '/daymark/api/today?x=1', 'https://styrigx.com/curio/api/export', '/blog/api/x']) {
    assert.equal(links.cleanTarget(bad), null, bad);
  }
  assert.equal(links.cleanTarget('/blog/apix/'), '/blog/apix/');
  /* 存量里不是相对路径的（只可能是旧图志完整地址，migrations/0002 已删）不再照跳，退回主站首页 */
  assert.equal(links.targetUrl('https://atlas.styrigx.com/blog/p/'), 'https://styrigx.com/');
  assert.equal(links.targetUrl('//evil.com/'), 'https://styrigx.com/');
  for (const bad of ['//evil.com', '/\\evil.com', '\\\\evil.com', 'https://evil.com/', 'http://styrigx.com/', 'http://atlas.styrigx.com/', 'evil.com', 'javascript:alert(1)',
    'JavaScript:alert(1)', 'data:text/html,x', 'https:evil.com', 'https:/atlas.styrigx.com/', 'https:///atlas.styrigx.com/',
    'https://styrigx.com.evil.com/', 'https://evil.com/https://atlas.styrigx.com/', 'https://atlas.styrigx.com.evil.com/', 'https://evilstyrigx.com/',
    'https://www.styrigx.com/', 'https://foo.atlas.styrigx.com/', 'https://atlas.styrigx.com./', 'https://atlas.styrigx.com:443/', 'https://atlas.styrigx.com:8443/',
    'https://user@atlas.styrigx.com/', 'https://user:pw@atlas.styrigx.com/', 'https://atlas.styrigx.com@evil.com/', 'https://evil.com#@atlas.styrigx.com/',
    'https://evil.com\\@atlas.styrigx.com/', 'https://atlas.styrigx.com/api/lock-session-check', 'https://atlas.styrigx.com/curio/api/links',
    'https://atlas.styrigx.com/daymark/api', 'https://styrigx.com/s/abc', 'https://styrigx.com/api/share',
    'https://blog.styrigx.com/', 'https://daymark.styrigx.com/', 'https://curio.styrigx.com/',
    /* 旧图志域名下线：原先放行的地址现在一律拒 */
    'https://atlas.styrigx.com/blog/post/hello/', 'https://atlas.styrigx.com/daymark/', 'https://atlas.styrigx.com', 'https://Atlas.Styrigx.com/blog/en/post/a/?x=1#h',
    'https://atlas.styrigx.com/blog/post/你好/', 'https://atlas.styrigx.com/blog/s/x/', 'https://atlas.styrigx.com/blog/p/?q=a',
    'https://styrigx.com:443/', 'https://user@styrigx.com/', 'https://styrigx.com@evil.com/', 'https://styrigx.com./', 'https://styrigx.com/blog/api/x',
    '/..//evil.com', '/\t/evil.com', '/\n/evil.com', '/ /x', '/a\\b', '/s/abc', '/s', '/api/lock-now', '/api/share', '/' + 'a'.repeat(links.TARGET_MAX),
    'https://atlas.styrigx.com/' + 'a'.repeat(links.TARGET_MAX), 'https://atlas.styrigx.com/' + '你'.repeat(100), 5, {}, ['/']]) {
    assert.equal(links.cleanTarget(bad), null, JSON.stringify(bad));
  }
});

test('有效期（1–24 小时、3 / 7 / 15 / 30 天）、会话档位和 link-keys 一致；会话不超过有效期；名字最多 24 字；isLinkId 单独一个校验', () => {
  const want = [[{ hours: 1 }, H], [{ hours: 24 }, 24 * H], [{ hours: 25 }, 0], [{ hours: 0 }, 0], [{ days: 3 }, 72 * H], [{ days: 7 }, 168 * H], [{ days: 15 }, 360 * H],
    [{ days: 30 }, 720 * H], [{ days: 2 }, 0], [{ hours: 1, days: 3 }, 0], [{ hours: '1' }, 0], [{}, 0]];
  for (const [p, ms] of want) assert.equal(links.durationMs(p), ms, JSON.stringify(p));
  assert.deepEqual([...links.DAYS], [3, 7, 15, 30]);
  assert.ok(links.isLinkId(links.newId()));
  for (const bad of ['', 'x', 'A'.repeat(15), 'A'.repeat(17), 'AAAA AAAAAAAAAAA', null, 1]) assert.equal(links.isLinkId(bad), false, String(bad));
  assert.notEqual(links.isLinkId, links.isId, '票的格式校验不和管理接口的参数校验共用一个函数');
  assert.deepEqual([...links.SESSION_OPTS], [...issuerMod.LINK_SESSION_OPTS]);
  assert.equal(links.sessionSeconds(undefined, H), 0);
  assert.equal(links.sessionSeconds(3600, H), 3600);
  assert.equal(links.sessionSeconds(3 * 3600, H), -1);
  for (const bad of [60, 1801, '1800', 1.5, -1, 30 * 86400]) assert.equal(links.sessionSeconds(bad, 30 * 24 * H), -1, String(bad));
  assert.equal(links.cleanName('a'.repeat(24)), 'a'.repeat(24));
  assert.equal(links.cleanName('a'.repeat(25)), null);
});

test('并入 styrigx-space-core：workers/share 不在了；core 的 wrangler.toml 只有 styrigx.com/* 一条路由；分享链接和进站同一个 D1_SPACE（L2b：库 styrigx-space-core，d1_migrations_core）；没有 ISSUER / AUTH / D1_SHARE_LINK 绑定', () => {
  assert.equal(existsSync(REPO + 'workers/share'), false, 'workers/share 已删');
  const t = readFileSync(REPO + 'workers/space-core/wrangler.toml', 'utf8');
  assert.match(t, /^name = "styrigx-space-core"$/m);
  assert.deepEqual([...t.matchAll(/^pattern = "([^"]+)"$/gm)].map((m) => m[1]), ['styrigx.com/*'], '分享链接不再单独登记路由');
  assert.match(t, /binding = "D1_SPACE"\ndatabase_name = "styrigx-space-core"\ndatabase_id = "1354c898-aacd-4122-92de-0ae39a3fcc1a"\nmigrations_dir = "migrations"\nmigrations_table = "d1_migrations_core"\n/);
  const body = t.replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(body, /binding = "(ISSUER|AUTH|D1_SHARE_LINK)"|ShareIssuer|styrigx-share|styrigx-space-gateway/, '不再有短链 Worker 的绑定、第二个 D1 绑定和旧库');
  /* 预览组合入口（space/web/wrangler.toml [env.preview]）同样只有 D1_SPACE（+ 账号的 D1_ACCOUNT） */
  const pv = readFileSync(REPO + 'space/web/wrangler.toml', 'utf8');
  assert.match(pv, /binding = "D1_SPACE"\ndatabase_name = "styrigx-test-preview"\ndatabase_id = "1339bb0b-f9f8-4e3d-b413-ff07ca28ce69"\nmigrations_dir = "\.\.\/\.\.\/workers\/space-core\/migrations"\nmigrations_table = "d1_migrations_core"\n/);
  assert.doesNotMatch(pv.replace(/^\s*#.*$/gm, ''), /D1_SHARE_LINK|migrations-share/);
});

test('分享链接的文件不带签名逻辑：api/share.js、core/share-open.js、core/share-links.js 里不出现私钥 / pepper / 签名函数（签会话只在 core/link-keys.js → lock-session）；临时钥匙代码已删', () => {
  for (const f of ['core/lock-tempkey.js', 'api/lock-tempkey.js', 'api/lock-tempkey-unlock.js']) assert.equal(existsSync(REPO + 'workers/space-core/src/' + f), false, f + ' 已删');
  const lk = readFileSync(REPO + 'workers/space-core/src/core/link-keys.js', 'utf8');
  assert.doesNotMatch(lk, /createLinkKey|revokeLinkKey|lock-tempkey/, 'link-keys 不再签 / 作废短链钥匙');
  for (const f of ['api/share.js', 'core/share-open.js', 'core/share-links.js']) {
    const src = readFileSync(REPO + 'workers/space-core/src/' + f, 'utf8');
    assert.doesNotMatch(src, /_PRIVATE|PEPPER|ed25519|signTk|issueLockSession|lock-tempkey|crypto\.subtle\.sign/i, f);
    assert.doesNotMatch(src, /env\.(ISSUER|AUTH)\b/, f + ' 不再经服务绑定');
  }
});

test('check-worker-routes：/s/*、/api/share 归 styrigx-space-core 的整站路由；子站接口 Worker 写宽了抢走就报错', async () => {
  const { readRoutes, readApiRoutes, checkWorkers, checkCores } = await import(REPO + 'space/scripts/check-worker-routes.mjs');
  const gw = readRoutes(readFileSync(REPO + 'workers/space-core/wrangler.toml', 'utf8'));
  const acct = readRoutes(readFileSync(REPO + 'workers/account/wrangler.toml', 'utf8'));
  const apis = readApiRoutes(readFileSync(REPO + 'workers/space-core/src/router.js', 'utf8'));
  const pages = ['/', '/account/', '/display/', '/search/', '/zh/display/'];
  assert.deepEqual(checkWorkers(gw, acct, apis, pages), []);
  const greedy = [{ name: 'curio-core', label: 'x', site: 'curio', routes: ['styrigx.com/curio/api/*', 'styrigx.com/s/*'], samples: [] }];
  assert.ok(checkCores(gw, greedy, apis.concat('/s/AAAAAAAAAAAAAAAAAAAAAA'), pages).length > 0, '别的 Worker 抢 /s/* 报错');
});

/* ---------------- 端到端（两种 D1 各跑一遍） ---------------- */

const KINDS = HAS_SQLITE ? [{ name: 'sqlite' }, { name: 'memory', memory: true }] : [{ name: 'memory', memory: true }];

for (const K of KINDS) {
  const T = (title, fn) => test('[' + K.name + '] ' + title, fn);
  const mk = () => setup({ memory: !!K.memory });

  T('带会话：生成（不签钥匙，没有 key_id 列）→ 别人点开拿到 by=link 的会话（linkId = share_link.id）、302 到干净目标（不带码）', async () => {
    const { env, db, authDb, gwEnv } = mk();
    const r = await api(env, { action: 'create', name: '小明', hours: 24, to: '/blog/?a=1#x', session: 3 * 3600 });
    assert.equal(r.s, 200, JSON.stringify(r.j));
    const link = r.j.link;
    assert.equal(link.status, 'active');
    assert.equal(link.session, 3 * 3600);
    assert.equal(link.to, '/blog/?a=1#x');
    assert.match(link.path, /^\/s\/[A-Za-z0-9_-]{22}$/);
    const row = db.rows()[0];
    assert.equal('key_id' in row, false, 'v5 收尾：share_link 没有 key_id 列');
    assert.ok(row.expires_at > Date.now() + 24 * H - 5000 && row.expires_at <= Date.now() + 24 * H);
    assert.equal(tempkeyRows(authDb), 0, 'tempkey 表不在');

    const res = await open(env, link.path);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), 'https://styrigx.com/blog/?a=1#x');
    assert.ok(!res.headers.get('Location').includes(link.path.slice(3)), 'Location 里没有码');
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal(res.headers.get('X-SGX-Runtime'), 'worker');
    const ck = cookiesFrom(res);
    assert.match(ck, new RegExp('sgx-space-session=link\\.\\d+\\.\\d+\\.' + row.id + '\\.'), 'v2 票：by.epoch.exp.linkId.sig');
    assert.doesNotMatch(ck, /sgx-tk=/);
    const ma = age(res, 'sgx-space-session');
    assert.ok(ma <= 3 * 3600 && ma > 3 * 3600 - 5, 'Max-Age = 会话时长');
    const v = await verifyLockSession(new Request('https://styrigx.com/', { headers: { Cookie: ck } }), gwEnv);
    assert.equal(v.ok, true);
    assert.equal(v.by, 'link');
    assert.equal(v.linkId, row.id);
    assert.equal(tempkeyRows(authDb), 0);
    /* 被打开的记录 */
    const l2 = await api(env, { action: 'list' });
    assert.equal(l2.j.links[0].opens, 1);
    assert.ok(l2.j.links[0].sessionLeft > 3 * 3600 - 5 && l2.j.links[0].sessionLeft <= 3 * 3600);
  });

  T('会话时长不超过链接剩余时间；openLinkSession 只认档位、只认合法 id、过期不签', async () => {
    const { env, db, gwEnv } = mk();
    const r = await api(env, { action: 'create', hours: 1, session: 3600 });
    const row = db.rows()[0];
    patchLink(db, row.id, { expires_at: Date.now() + 600e3 });
    const res = await open(env, r.j.link.path);
    const ma = age(res, 'sgx-space-session');
    assert.ok(ma <= 600 && ma > 590, 'min(会话, 链接剩余) = ' + ma);
    const exp = Date.now() + H;
    assert.deepEqual(await issuerMod.openLinkSession(row.id, 60, exp, gwEnv), { ok: false }, '不在档位');
    assert.deepEqual(await issuerMod.openLinkSession('x', 3600, exp, gwEnv), { ok: false });
    assert.deepEqual(await issuerMod.openLinkSession(row.id, 3600, Date.now() - 1, gwEnv), { ok: false }, '已到期');
    assert.deepEqual(await issuerMod.openLinkSession(row.id, 3600, NaN, gwEnv), { ok: false });
  });

  T('普通短链：不发会话，302 到目标（没解锁的人由网关照常送去锁屏）', async () => {
    const { env, authDb } = mk();
    const r = await api(env, { action: 'create', days: 3, to: '/display/' });
    assert.equal(r.s, 200);
    assert.equal(r.j.link.session, 0);
    assert.equal(tempkeyRows(authDb), 0);
    const res = await open(env, r.j.link.path + '/');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), 'https://styrigx.com/display/');
    assert.equal(res.headers.getSetCookie().length, 0);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  });

  T('已进门的人点开带会话的短链：只 302，不重签', async () => {
    const { env, authDb } = mk();
    const r = await api(env, { action: 'create', hours: 2, session: 1800 });
    const res = await open(env, r.j.link.path, { cookie: await adminCookie() });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), 'https://styrigx.com/');
    assert.equal(res.headers.getSetCookie().length, 0);
    assert.equal(tempkeyRows(authDb), 0);
  });

  T('预取不发会话（503，不缓存）；HEAD 只 302 不发会话', async () => {
    const { env } = mk();
    const r = await api(env, { action: 'create', hours: 2, session: 1800 });
    for (const h of [{ 'Sec-Purpose': 'prefetch' }, { 'Sec-Purpose': 'prefetch;prerender' }, { Purpose: 'prefetch' }, { 'X-Moz': 'prefetch' }]) {
      const res = await open(env, r.j.link.path, { headers: h });
      assert.equal(res.status, 503, JSON.stringify(h));
      assert.equal(res.headers.getSetCookie().length, 0);
      assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    }
    const hd = await open(env, r.j.link.path, { method: 'HEAD' });
    assert.equal(hd.status, 302);
    assert.equal(hd.headers.getSetCookie().length, 0);
    /* 访问表：/s/:code 只有 GET / HEAD 公开，其他方法没进站 401（进了站才轮到 405） */
    assert.equal((await open(env, r.j.link.path, { method: 'POST' })).status, 401);
  });

  T('不存在 / 格式不对 / 过期 / 作废（两种）/ 目标被改坏：同一个响应', async () => {
    const { env, db } = mk();
    const a = (await api(env, { action: 'create', hours: 1, session: 1800 })).j.link;
    const b = (await api(env, { action: 'create', hours: 1 })).j.link;
    const c = (await api(env, { action: 'create', hours: 1 })).j.link;
    const d = (await api(env, { action: 'create', hours: 1 })).j.link;
    assert.equal((await api(env, { action: 'revoke', id: a.id })).s, 200);
    assert.equal((await api(env, { action: 'revoke', id: b.id })).s, 200);
    if (db.raw) {
      db.raw.prepare('UPDATE share_link SET expires_at = ? WHERE id = ?').run(Date.now() - 1, c.id);
      db.raw.prepare("UPDATE share_link SET target = '//evil.com' WHERE id = ?").run(d.id);
    } else {
      db._links.get(c.id).expires_at = Date.now() - 1;
      db._links.get(d.id).target = '//evil.com';
    }
    const paths = ['/s/' + links.newCode(), '/s/short', '/s/', '/s/' + 'A'.repeat(23), a.path, b.path, c.path, d.path];
    let ip = 0;
    for (const p of paths) assert.deepEqual(await failShape(await open(env, p, { ip: '10.0.0.' + (ip++) })), FAIL, p);
  });

  T('作废带会话的短链（share rm）：写 revoked_at，已发出去的链接会话下一个请求就进不来；再点开也是失败响应', async () => {
    const { env, gwEnv, db } = mk();
    const l = (await api(env, { action: 'create', days: 7, session: 86400 })).j.link;
    const ck = cookiesFrom(await open(env, l.path));
    const req = () => new Request('https://styrigx.com/blog/', { headers: { Cookie: ck } });
    assert.equal((await verifyLockSession(req(), gwEnv)).ok, true);
    const rv = await api(env, { action: 'revoke', id: l.id });
    assert.equal(rv.s, 200);
    const v = await verifyLockSession(req(), gwEnv);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'link-revoked');
    assert.ok(db.rows()[0].revoked_at > 0, 'share_link 记了 revoked_at');
    /* 整条网关（v5 S3 起页面一律公开，不再 302 锁屏）：作废后的链接会话调上锁的接口 → 401。
       以前这里打 /display/ 断言 302：S3 后页面直接回源，测试里没有 ASSETS 就真的去请求线上，S3 上线后线上回 404，测试跟着红（v5 S4 修） */
    const locked = await worker.fetch(new Request('https://styrigx.com/api/status', { headers: { Cookie: ck } }), env, ctx);
    assert.equal(locked.status, 401);
    assert.deepEqual(await failShape(await open(env, l.path, { ip: '9.9.9.9' })), FAIL);
    const list = (await api(env, { action: 'list' })).j.links;
    assert.equal(list[0].status, 'revoked');
    assert.equal(list[0].path, undefined, '作废的不再给码');
    assert.equal(list[0].sessionLeft, 0);
    assert.equal((await api(env, { action: 'revoke', id: l.id })).s, 200, '再作废一次也 ok');
    assert.equal((await api(env, { action: 'revoke', id: links.newId() })).s, 404);
  });

  T('share rm --all（revoke all:true）：一次作废全部还没作废的，所有链接会话下一个请求都进不来；带 id 一起传 → 400', async () => {
    const { env, gwEnv, db } = mk();
    const a = (await api(env, { action: 'create', hours: 3, session: 3600 })).j.link;
    const b = (await api(env, { action: 'create', days: 15, session: 86400 })).j.link;
    const c = (await api(env, { action: 'create', hours: 3 })).j.link;
    const cks = [cookiesFrom(await open(env, a.path)), cookiesFrom(await open(env, b.path, { ip: '7.7.7.8' }))];
    for (const ck of cks) assert.equal((await verifyLockSession(new Request('https://styrigx.com/', { headers: { Cookie: ck } }), gwEnv)).ok, true);
    assert.equal((await api(env, { action: 'revoke', all: true, id: a.id })).s, 400);
    assert.equal((await api(env, { action: 'revoke', all: true })).s, 200);
    assert.ok(db.rows().every((r) => r.revoked_at > 0), JSON.stringify(db.rows().map((r) => r.revoked_at)));
    for (const ck of cks) {
      const v = await verifyLockSession(new Request('https://styrigx.com/', { headers: { Cookie: ck } }), gwEnv);
      assert.equal(v.ok, false);
      assert.equal(v.reason, 'link-revoked');
    }
    for (const l of [a, b, c]) assert.deepEqual(await failShape(await open(env, l.path, { ip: '9.9.9.' + l.id.length })), FAIL);
    assert.equal((await api(env, { action: 'revoke', all: true })).s, 200, '再来一次也 ok');
  });

  T('链接到期（行还在）：已发出的链接会话下一个请求进不来；行被清理掉也一样（按失效算）；纪元推进同样让它失效', async () => {
    const { env, gwEnv, db, authDb } = mk();
    const l = (await api(env, { action: 'create', hours: 2, session: 1800 })).j.link;
    const ck = cookiesFrom(await open(env, l.path));
    const req = () => new Request('https://styrigx.com/', { headers: { Cookie: ck } });
    assert.equal((await verifyLockSession(req(), gwEnv)).ok, true);
    patchLink(db, l.id, { expires_at: Date.now() - 1000 });
    let v = await verifyLockSession(req(), gwEnv);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'link-revoked');
    /* 行已被清理 */
    const l2 = (await api(env, { action: 'create', hours: 2, session: 1800 })).j.link;
    const ck2 = cookiesFrom(await open(env, l2.path, { ip: '7.7.7.9' }));
    const req2 = () => new Request('https://styrigx.com/', { headers: { Cookie: ck2 } });
    assert.equal((await verifyLockSession(req2(), gwEnv)).ok, true);
    if (db.raw) db.raw.prepare('DELETE FROM share_link WHERE id = ?').run(l2.id); else db._links.delete(l2.id);
    v = await verifyLockSession(req2(), gwEnv);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'link-revoked');
    /* 纪元推进（退出所有设备 / 改密码 / 删通行密钥）：有效链接的会话也失效 */
    const l3 = (await api(env, { action: 'create', hours: 2, session: 1800 })).j.link;
    const ck3 = cookiesFrom(await open(env, l3.path, { ip: '7.7.7.10' }));
    const req3 = () => new Request('https://styrigx.com/', { headers: { Cookie: ck3 } });
    assert.equal((await verifyLockSession(req3(), gwEnv)).ok, true);
    authDb.setEpoch('lock', (authDb.epoch('lock') || 0) + 1);
    v = await verifyLockSession(req3(), gwEnv);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'epoch-low');
  });

  T('验链接会话时 D1 出错 → 无效（d1-error，fail closed）', async () => {
    const { env, gwEnv, db } = mk();
    const l = (await api(env, { action: 'create', hours: 2, session: 1800 })).j.link;
    const ck = cookiesFrom(await open(env, l.path));
    failShareOn(db, /SELECT revoked_at, expires_at FROM share_link/);
    const v = await verifyLockSession(new Request('https://styrigx.com/', { headers: { Cookie: ck } }), gwEnv);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'd1-error');
  });

  T('作废写 D1 失败 → 503，行不变（可重试）', async () => {
    const { env, db } = mk();
    const l = (await api(env, { action: 'create', hours: 3, session: 3600 })).j.link;
    failShareOn(db, /^UPDATE share_link SET revoked_at/);
    assert.equal((await api(env, { action: 'revoke', id: l.id })).s, 503);
    assert.equal((await api(env, { action: 'revoke', all: true })).s, 503);
    assert.equal(db.rows()[0].revoked_at, null);
  });

  T('生成的校验：目标 / 有效期 / 会话 / 名字；最多同时 20 条（作废的不算）', async () => {
    const { env } = mk();
    for (const to of ['//evil.com', 'https://evil.com', '/\\evil.com', 'evil.com', '/s/x', '/api/lock-now']) {
      assert.deepEqual((await api(env, { action: 'create', hours: 1, to })).j, { ok: false, error: 'target' }, to);
    }
    assert.equal((await api(env, { action: 'create', hours: 25 })).j.error, 'duration');
    assert.equal((await api(env, { action: 'create', hours: 1, session: 3 * 3600 })).j.error, 'session');
    assert.equal((await api(env, { action: 'create', hours: 1, session: 999 })).j.error, 'session');
    assert.equal((await api(env, { action: 'create', hours: 1, name: 'x'.repeat(25) })).j.error, 'name');
    let first;
    for (let i = 0; i < 20; i++) {
      const r = await api(env, { action: 'create', hours: 1, session: i % 2 ? 1800 : 0 });
      assert.equal(r.s, 200, String(i));
      if (!first) first = r.j.link;
    }
    const full = await api(env, { action: 'create', hours: 1 });
    assert.equal(full.s, 409);
    assert.equal(full.j.error, 'full');
    await api(env, { action: 'revoke', id: first.id });
    assert.equal((await api(env, { action: 'create', hours: 1 })).s, 200);
  });

  T('权限（v5 S1）：新建（含 reuse、普通短链）要进门且不是 by=link；管理（list / revoke / rm --all）另要锁侧复验（401 reauth）；分享链接进来的会话新建 / 管理一律 403 link（带着 reauth 票也不行）；没会话 401、跨源 403', async () => {
    const { env, gwEnv, db, authDb } = mk();
    const l = (await api(env, { action: 'create', hours: 2, session: 1800 })).j.link;
    const viaLink = cookiesFrom(await open(env, l.path)); /* 短链进门的会话（by=link） */
    assert.equal((await verifyLockSession(new Request('https://styrigx.com/', { headers: { Cookie: viaLink } }), gwEnv)).by, 'link');
    const before = db.rows().length;
    const linkWithReauth = viaLink + '; sgx-space-reauth=' + (await testTicket(LOCK.priv, 'LockReauthTicket', 'password', 0));
    let r;
    for (const cookie of [viaLink, linkWithReauth]) {
      for (const body of [{ action: 'create', hours: 1, session: 1800 }, { action: 'create', hours: 1 }, { action: 'create', hours: 2, session: 1800, reuse: true },
        { action: 'list' }, { action: 'revoke', id: l.id }, { action: 'revoke', all: true }]) {
        r = await api(env, body, cookie);
        assert.equal(r.s, 403, JSON.stringify(body) + ' ' + JSON.stringify(r.j));
        assert.equal(r.j.error, 'link', JSON.stringify(body));
      }
    }
    assert.equal(db.rows().length, before, '链接会话一条都没建成');
    for (const cookie of [await inCookie('password'), await inCookie('passkey')]) {
      for (const body of [{ action: 'create', hours: 1, session: 1800 }, { action: 'create', hours: 1 }, { action: 'create', hours: 2, session: 1800, reuse: true }]) {
        r = await api(env, body, cookie);
        assert.equal(r.s, 200, JSON.stringify(body) + ' ' + JSON.stringify(r.j));
      }
      for (const body of [{ action: 'list' }, { action: 'revoke', id: l.id }, { action: 'revoke', all: true }]) {
        r = await api(env, body, cookie);
        assert.equal(r.s, 401, JSON.stringify(body));
        assert.equal(r.j.error, 'reauth', JSON.stringify(body));
      }
    }
    assert.ok(db.rows().every((x) => !x.revoked_at), '没复验时一条都没作废');
    assert.equal(tempkeyRows(authDb), 0);
    assert.equal((await api(env, { action: 'list' }, '')).s, 401);
    assert.equal((await api(env, { action: 'create', hours: 1 }, '')).s, 401);
    assert.equal((await api(env, { action: 'list' }, undefined, 'https://evil.com')).s, 403);
    /* 直接调内部门槛 */
    assert.deepEqual(await issuerMod.checkLinkCreate('', gwEnv), { ok: false, error: 'session' });
    assert.deepEqual(await issuerMod.checkLinkCreate(viaLink, gwEnv), { ok: false, error: 'link' });
    assert.deepEqual(await issuerMod.checkLinkCreate(await inCookie('password'), gwEnv), { ok: true });
    assert.deepEqual(await issuerMod.checkLinkReauth(viaLink, gwEnv), { ok: false, error: 'link' });
    assert.deepEqual(await issuerMod.checkLinkReauth(linkWithReauth, gwEnv), { ok: false, error: 'link' });
    assert.deepEqual(await issuerMod.checkLinkReauth(await inCookie('password'), gwEnv), { ok: false, error: 'reauth' });
    assert.deepEqual(await issuerMod.checkLinkReauth('', gwEnv), { ok: false, error: 'session' });
    const owner = await adminCookie();
    assert.deepEqual(await issuerMod.checkLinkReauth(owner, gwEnv), { ok: true });
    assert.equal((await api(env, { action: 'list' }, owner)).s, 200, '复验过能看列表');
    assert.deepEqual(await issuerMod.checkLinkCreate(owner, { D1_SPACE: undefined }), { ok: false, error: 'config' });
    /* 别的钥匙签的复验票不算 */
    const other = await genKeyPair();
    const forged = (await inCookie('password')) + '; sgx-space-reauth=' + (await testTicket(other.priv, 'LockReauthTicket', 'password', 0));
    assert.deepEqual(await issuerMod.checkLinkReauth(forged, gwEnv), { ok: false, error: 'reauth' });
    /* v5 S1 前的 by=tempkey 旧票：格式不认 → 没进门 */
    const p = await (await import(REPO + 'workers/space-core/src/lib/crypto.js')).ed25519Sign(LOCK.priv, 'sgx-space-session|tempkey.0.' + (Date.now() + H) + '.tktesttesttest01');
    const oldTk = 'sgx-space-session=tempkey.0.' + (Date.now() + H) + '.tktesttesttest01.' + p;
    assert.deepEqual(await issuerMod.checkLinkCreate(oldTk, gwEnv), { ok: false, error: 'session' });
    /* GET / 别的接口路径 */
    const g = await worker.fetch(new Request('https://styrigx.com/api/share', { headers: { Cookie: owner } }), env, ctx);
    assert.equal(g.status, 405);
    const o2 = await worker.fetch(new Request('https://styrigx.com/api/shared', { method: 'POST', headers: { Cookie: owner, Origin: 'https://styrigx.com' } }), env, ctx);
    assert.equal(o2.status, 404);
  });

  T('进门 + 锁侧复验、没有账号会话（两边绑了一碰就抛的 ACCOUNT_VERIFIER 也不问）：能建带会话的短链，也能作废', async () => {
    const { env, gwEnv, db } = mk();
    let asked = 0;
    const trap = { accountSession() { asked++; throw new Error('不该问账号会话'); }, authorize() { asked++; throw new Error('不该问账号'); } };
    env.ACCOUNT_VERIFIER = trap;
    gwEnv.ACCOUNT_VERIFIER = trap;
    const lockOnly = await adminCookie();
    const c = await api(env, { action: 'create', hours: 2, session: 1800 }, lockOnly);
    assert.equal(c.s, 200, JSON.stringify(c.j));
    const rv = await api(env, { action: 'revoke', id: c.j.link.id }, lockOnly);
    assert.equal(rv.s, 200);
    assert.ok(db.rows()[0].revoked_at > 0);
    assert.equal(asked, 0);
  });

  T('限速：同一 IP 10 次打不开 → 15 分钟内真码也走失败响应；换 IP 不受影响；锁住后不再写 D1', async () => {
    const { env, db } = mk();
    const l = (await api(env, { action: 'create', hours: 2 })).j.link;
    for (let i = 0; i < 10; i++) assert.deepEqual(await failShape(await open(env, '/s/' + links.newCode(), { ip: '6.6.6.6' })), FAIL);
    assert.deepEqual(await failShape(await open(env, l.path, { ip: '6.6.6.6' })), FAIL, '真码也被拦');
    assert.ok(db.fails().find((f) => f.ip === '6.6.6.6').locked_until > Date.now());
    _resetMem();
    assert.deepEqual(await failShape(await open(env, l.path, { ip: '6.6.6.6' })), FAIL, '换了 isolate 也认 D1 里的锁');
    const before = JSON.stringify(db.fails());
    for (let i = 0; i < 5; i++) await open(env, '/s/' + links.newCode(), { ip: '6.6.6.6' });
    assert.equal(JSON.stringify(db.fails()), before, '锁住期间不写');
    const ok = await open(env, l.path, { ip: '5.5.5.5' });
    assert.equal(ok.headers.get('Location'), 'https://styrigx.com/');
    /* 格式不对的码不写 D1 */
    const n = db.fails().length;
    await open(env, '/s/bad', { ip: '4.4.4.4' });
    assert.equal(db.fails().length, n);
  });

  T('share_fail 不无限增长：写失败计数时按概率清掉窗口和锁定都已过期的行，新鲜的行和还锁着的行不动', async () => {
    const { env, db } = mk();
    const now = Date.now();
    const old = now - 3 * H;
    await links.run(db, links.SQL.failPut, '9.9.9.1', 3, old, 0); /* 窗口早过了 */
    await links.run(db, links.SQL.failPut, '9.9.9.2', 0, old, old + 15 * 60e3); /* 锁早过了 */
    await links.run(db, links.SQL.failPut, '9.9.9.3', 0, old, now + 10 * 60e3); /* 还锁着 */
    await links.run(db, links.SQL.failPut, '9.9.9.4', 2, now - 60e3, 0); /* 窗口内 */
    try {
      _setRandom(() => 0.99); /* 不抽中：不清 */
      await open(env, '/s/' + links.newCode(), { ip: '8.8.8.1' });
      assert.deepEqual(db.fails().map((f) => f.ip).sort(), ['8.8.8.1', '9.9.9.1', '9.9.9.2', '9.9.9.3', '9.9.9.4']);
      _setRandom(() => 0); /* 抽中：清 */
      await open(env, '/s/' + links.newCode(), { ip: '8.8.8.2' });
      assert.deepEqual(db.fails().map((f) => f.ip).sort(), ['8.8.8.1', '8.8.8.2', '9.9.9.3', '9.9.9.4']);
      /* 清理出错不影响这次的失败响应 */
      const prep = db.prepare.bind(db);
      db.prepare = (sql) => { if (sql === links.SQL.failPurge) throw new Error('d1 down'); return prep(sql); };
      assert.deepEqual(await failShape(await open(env, '/s/' + links.newCode(), { ip: '8.8.8.3' })), FAIL);
      db.prepare = prep;
    } finally {
      _setRandom();
    }
  });

  T('门：别的域名 /api/* 403、页面 301；/s/* 谁都能开；X-SGX-Runtime: worker；/api/* no-store', async () => {
    const { env } = mk();
    const r1 = await worker.fetch(new Request('https://www.styrigx.com/api/share', { method: 'POST' }), env, ctx);
    assert.equal(r1.status, 403);
    const r2 = await worker.fetch(new Request('https://www.styrigx.com/s/abc'), env, ctx);
    assert.equal(r2.status, 301);
    const r3 = await open(env, '/s/' + links.newCode());
    assert.equal(r3.headers.get('X-SGX-Runtime'), 'worker');
    const r4 = await api(env, { action: 'nope' });
    assert.equal(r4.s, 400);
    assert.equal(r4.res.headers.get('Cache-Control'), 'private, no-store');
  });

  T('进站 D1 出错：带会话的点开走失败响应（签不出会话）；分享 D1 没绑：点开失败响应', async () => {
    const { env, db } = mk();
    const l = (await api(env, { action: 'create', hours: 2, session: 1800 })).j.link;
    const broken = makeAuthD1();
    failOn(broken, /FROM epoch/);
    const e2 = Object.assign({}, env, { D1_SPACE: spaceD1(broken, db) });
    assert.deepEqual(await failShape(await open(e2, l.path)), FAIL);
    const e4 = Object.assign({}, env, { D1_SPACE: undefined });
    assert.deepEqual(await failShape(await open(e4, l.path)), FAIL);
  });

  T('清理入口 purgeDeadLinks（v5 S1，S2 由 styrigx-status 每日 Cron 经服务绑定调）：只删过期 / 作废满 7 天的行，一条 DELETE；有效的、刚死不到 7 天的都留着', async () => {
    const { env, db } = mk();
    const mkL = async (n) => (await api(env, { action: 'create', hours: 1, name: n })).j.link.id;
    const now = Date.now();
    const D = 86400e3;
    const ids = {};
    for (const n of ['live', 'exp6', 'exp8', 'rev6', 'rev8', 'rev8live']) ids[n] = await mkL(n);
    patchLink(db, ids.exp6, { expires_at: now - 6 * D });
    patchLink(db, ids.exp8, { expires_at: now - 8 * D });
    patchLink(db, ids.rev6, { revoked_at: now - 6 * D });
    patchLink(db, ids.rev8, { revoked_at: now - 8 * D });
    patchLink(db, ids.rev8live, { revoked_at: now - 8 * D, expires_at: now + 30 * D });
    let deletes = 0;
    const prep = db.prepare.bind(db);
    db.prepare = (sql) => { if (/^DELETE/i.test(sql)) deletes++; return prep(sql); };
    const n = await links.purgeDeadLinks(db, now);
    db.prepare = prep;
    assert.equal(deletes, 1, '一条 DELETE');
    assert.equal(n, 3);
    assert.deepEqual(db.rows().map((r) => r.name).sort(), ['exp6', 'live', 'rev6']);
    assert.equal(await links.purgeDeadLinks(db, now), 0, '再跑一次没东西可删');
    await assert.rejects(links.purgeDeadLinks(null, now));
    assert.equal(links.KEEP_DEAD_MS, 7 * D);
  });

  T('列表：新到旧；过期 / 作废的标状态、不给码；超过 7 天的删掉', async () => {
    const { env, db } = mk();
    const a = (await api(env, { action: 'create', hours: 1, name: 'A', to: '/x/' })).j.link;
    const b = (await api(env, { action: 'create', hours: 1, name: 'B', session: 1800 })).j.link;
    const old = Date.now() - 8 * 86400e3;
    if (db.raw) db.raw.prepare('UPDATE share_link SET expires_at = ?, created_at = ? WHERE id = ?').run(old, old - 1, a.id);
    else Object.assign(db._links.get(a.id), { expires_at: old, created_at: old - 1 });
    let list = (await api(env, { action: 'list' })).j.links;
    assert.deepEqual(list.map((x) => x.name), ['B']);
    assert.equal(list[0].openFor, 1800);
    assert.equal(list[0].sessionLeft, 0, '没人点开过');
    const c = (await api(env, { action: 'create', hours: 1, name: 'C' })).j.link;
    if (db.raw) db.raw.prepare('UPDATE share_link SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, c.id);
    else db._links.get(c.id).expires_at = Date.now() - 1000;
    list = (await api(env, { action: 'list' })).j.links;
    assert.deepEqual(list.map((x) => [x.name, x.status, !!x.path]), [['C', 'expired', false], ['B', 'active', true]]);
    assert.ok(!JSON.stringify(list).includes('key_id') && !JSON.stringify(list).includes('"code"'));
  });

  T('完整地址目标：生成（规范化成相对路径）→ 别人点开带会话的短链 302 到主站地址，cookie 是 Domain=styrigx.com；atlas.styrigx.com 目标 400', async () => {
    const { env } = mk();
    const r = await api(env, { action: 'create', hours: 24, to: 'https://styrigx.com/blog/post/x/?lock=1&q=1', session: 43200 });
    assert.equal(r.s, 200, JSON.stringify(r.j));
    assert.equal(r.j.link.to, '/blog/post/x/?q=1');
    const res = await open(env, r.j.link.path);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), 'https://styrigx.com/blog/post/x/?q=1');
    const sc = res.headers.getSetCookie().find((c) => c.startsWith('sgx-space-session=') && !c.startsWith('sgx-space-session=;'));
    assert.match(sc, /Domain=\.?styrigx\.com/i);
    /* 旧图志地址不能再当目标 */
    const bad = await api(env, { action: 'create', hours: 1, to: 'https://atlas.styrigx.com/curio/' });
    assert.equal(bad.s, 400, JSON.stringify(bad.j));
    /* 存坏成别的主机 / 存量的旧图志完整地址：点开只走失败响应 */
    for (const t of ['https://styrigx.com.evil.com/', 'https://atlas.styrigx.com/curio/']) {
      const { db, env: fresh } = mk();
      const e2 = Object.assign({}, env, { D1_SPACE: fresh.D1_SPACE });
      const l2 = (await api(e2, { action: 'create', hours: 1, to: '/curio/' })).j.link;
      if (db.raw) db.raw.prepare('UPDATE share_link SET target = ? WHERE id = ?').run(t, l2.id);
      else db._links.get(l2.id).target = t;
      assert.deepEqual(await failShape(await open(e2, l2.path, { ip: '3.3.3.3' })), FAIL, t);
    }
  });

  T('复用（reuse:true）：同目标 + 同档位 + 剩 ≥ 12 小时 → 返回同一条，不新建；目标 / 档位不同、剩不到 12 小时、作废了 → 新建', async () => {
    const { env, db, authDb } = mk();
    const q = { action: 'create', reuse: true, name: '一篇很长很长很长很长很长很长很长很长很长很长的文章标题 · 博客', hours: 24, session: 43200,
      to: 'https://styrigx.com/blog/post/a/' };
    const a = await api(env, q);
    assert.equal(a.s, 200, JSON.stringify(a.j));
    assert.equal(a.j.reused, false);
    assert.equal([...a.j.link.name].length, 24, '页面标题截到 24 字');
    const b = await api(env, Object.assign({}, q, { to: '/blog/post/a/?share=1' }));
    assert.equal(b.j.reused, true);
    assert.equal(b.j.link.id, a.j.link.id);
    assert.equal(b.j.link.path, a.j.link.path);
    assert.equal(tempkeyRows(authDb), 0);
    assert.equal(db.rows().length, 1);
    /* 没 reuse 标记 = 照旧每次新建 */
    const c = await api(env, { action: 'create', hours: 24, session: 43200, to: '/blog/post/a/' });
    assert.notEqual(c.j.link.id, a.j.link.id);
    assert.equal(c.j.reused, undefined);
    /* 别的目标 / 别的会话档位 / 别的有效期 → 新建 */
    const d = await api(env, Object.assign({}, q, { to: 'https://styrigx.com/blog/post/b/' }));
    assert.equal(d.j.reused, false);
    const e = await api(env, Object.assign({}, q, { session: 3600 }));
    assert.equal(e.j.reused, false);
    const f = await api(env, Object.assign({}, q, { hours: 13 }));
    assert.equal(f.j.reused, false);
    /* 剩不到 12 小时：不复用 */
    const left = Date.now() + 11 * H;
    for (const id of [a.j.link.id, c.j.link.id]) {
      if (db.raw) db.raw.prepare('UPDATE share_link SET expires_at = ?, created_at = ? WHERE id = ?').run(left, left - 24 * H, id);
      else Object.assign(db._links.get(id), { expires_at: left, created_at: left - 24 * H });
    }
    const g = await api(env, q);
    assert.equal(g.j.reused, false);
    assert.notEqual(g.j.link.id, a.j.link.id);
    assert.equal((await api(env, q)).j.link.id, g.j.link.id, '新的那条接着复用');
    /* 作废了：不复用 */
    await api(env, { action: 'revoke', id: g.j.link.id });
    const h = await api(env, q);
    assert.equal(h.j.reused, false);
    assert.notEqual(h.j.link.id, g.j.link.id);
    /* 满 20 条时复用照样能拿到已有的 */
    for (let i = db.rows().filter((r) => !r.revoked_at && r.expires_at > Date.now()).length; i < 20; i++) await api(env, { action: 'create', hours: 1 });
    assert.equal((await api(env, { action: 'create', hours: 1 })).s, 409);
    assert.equal((await api(env, q)).j.link.id, h.j.link.id);
  });

  T('跨源：一律 403 origin（含已下线的 atlas.styrigx.com、不带 Origin），不回任何 CORS 头；没会话 401 也不带 Allow 头；主站同源照旧', async () => {
    const { env } = mk();
    const q = { action: 'create', reuse: true, name: 'x', hours: 24, session: 43200, to: '/daymark/' };
    for (const o of ['https://atlas.styrigx.com', 'https://evil.com', 'https://styrigx.com.evil.com', 'http://atlas.styrigx.com', 'https://styrigx.com:8443', 'https://www.styrigx.com', 'https://blog.styrigx.com', 'https://daymark.styrigx.com', 'https://curio.styrigx.com', 'null']) {
      for (const body of [q, { action: 'list' }, { action: 'revoke', id: links.newId() }, { action: 'create', hours: 1 }]) {
        const r = await api(env, body, undefined, o);
        assert.equal(r.s, 403, o + ' ' + JSON.stringify(body));
        assert.equal(r.j.error, 'origin');
        assert.equal(r.res.headers.get('Access-Control-Allow-Origin'), null, o);
        assert.equal(r.res.headers.get('Access-Control-Allow-Credentials'), null, o);
        assert.equal(r.res.headers.get('Cache-Control'), 'private, no-store');
      }
    }
    /* 不带 Origin（非浏览器）：同样 403 */
    const noOrigin = await worker.fetch(new Request('https://styrigx.com/api/share', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: await adminCookie() }, body: JSON.stringify({ action: 'list' }),
    }), env, ctx);
    assert.equal(noOrigin.status, 403);
    /* 没会话：门 401，不带 Allow 头 */
    const u = await api(env, q, '', 'https://atlas.styrigx.com');
    assert.equal(u.s, 401);
    assert.equal(u.res.headers.get('Access-Control-Allow-Origin'), null);
    /* 主站同源照旧，也不回 CORS 头 */
    const ok = await api(env, q);
    assert.equal(ok.s, 200, JSON.stringify(ok.j));
    assert.equal(ok.res.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal((await api(env, { action: 'list' })).s, 200);
  });
}

test('预检 OPTIONS /api/share：不再接受跨源（lib/cors.js 已删）→ 不论 Origin 一律 403、不给任何 Allow 头、不看会话；别的接口路径照常过门', async () => {
  const { env } = setup({ memory: true });
  const pre = (origin, method, headers, path) => worker.fetch(new Request('https://styrigx.com' + (path || '/api/share'), {
    method: 'OPTIONS',
    headers: Object.assign(origin ? { Origin: origin } : {}, { 'Access-Control-Request-Method': method }, headers === undefined ? { 'Access-Control-Request-Headers': 'content-type' } : headers),
  }), env, ctx);
  for (const [o, m, h] of [
    ['https://atlas.styrigx.com', 'POST'], ['https://atlas.styrigx.com', 'POST', {}], ['https://styrigx.com', 'POST'],
    ['https://evil.com', 'POST'], ['https://styrigx.com.evil.com', 'POST'], ['http://atlas.styrigx.com', 'POST'], ['https://blog.styrigx.com', 'POST'], ['https://curio.styrigx.com', 'POST'],
    ['https://atlas.styrigx.com', 'DELETE'], ['https://atlas.styrigx.com', 'POST', { 'Access-Control-Request-Headers': 'content-type, x-evil' }],
    ['', 'POST'],
  ]) {
    for (const path of ['/api/share', '/api/share/']) {
      const r = await pre(o, m, h, path);
      assert.equal(r.status, 403, [o, m, JSON.stringify(h), path].join(' '));
      for (const k of ['Allow-Origin', 'Allow-Credentials', 'Allow-Methods', 'Allow-Headers', 'Max-Age']) assert.equal(r.headers.get('Access-Control-' + k), null, k);
      assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
      assert.equal(r.headers.get('X-SGX-Runtime'), 'worker');
    }
  }
  /* 别的接口路径不归这里 */
  assert.equal((await pre('https://atlas.styrigx.com', 'POST', undefined, '/api/shared')).status, 401);
});

test('lib/cors.js 已删，分享链接的文件里不再出现 Access-Control-* 和 atlas.styrigx.com', () => {
  assert.equal(existsSync(REPO + 'workers/space-core/src/lib/cors.js'), false);
  for (const f of ['router.js', 'core/share-open.js', 'api/share.js', 'lib/http.js']) {
    const src = readFileSync(REPO + 'workers/space-core/src/' + f, 'utf8');
    assert.doesNotMatch(src, /Access-Control-|cors\.js/, f);
  }
  assert.doesNotMatch(readFileSync(REPO + 'workers/space-core/src/core/share-links.js', 'utf8'), /TARGET_HOSTS = Object\.freeze\(\[[^\]]*atlas/);
});

/* ---------------- 安全响应头（PR D，workers #3）：和网关主站同一套；/s/<码> 的 no-referrer 不被覆盖 ---------------- */
const SECH = await import(REPO + 'workers/space-core/src/lib/security-headers.js');

test('安全头：/s/<码> 失败跳转保留 Referrer-Policy: no-referrer，其余安全头齐全；/api/share 401 和预检带安全头且不带 CORS 头', async () => {
  const { env } = setup({ memory: true });
  const f = await open(env, '/s/' + links.newCode(), { ip: '5.5.5.5' });
  assert.deepEqual(await failShape(f), FAIL);
  for (const [k, v] of SECH.mainSiteHeaderList()) {
    assert.equal(f.headers.get(k), k === 'Referrer-Policy' ? 'no-referrer' : v, '/s/ ' + k);
  }
  const a = await api(env, { action: 'list' }, '');
  assert.equal(a.s, 401);
  assert.equal(a.res.headers.get('Access-Control-Allow-Origin'), null);
  for (const [k, v] of SECH.mainSiteHeaderList()) assert.equal(a.res.headers.get(k), v, 'api ' + k);
  const pre = await worker.fetch(new Request('https://styrigx.com/api/share', {
    method: 'OPTIONS', headers: { Origin: 'https://evil.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  }), env, ctx);
  assert.equal(pre.status, 403);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(pre.headers.get('Strict-Transport-Security'), SECH.HSTS);
});

test('migrations/0001_baseline（L2b）：只建表建索引，没有种子 / 删数据；= 旧库两套迁移（migrations-archive/gateway、share）跑完的表结构（逐列一致：搬来的行原样插得进）；分享链接的代码不兜底建表', { skip: !HAS_SQLITE }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  assert.deepEqual(readdirSync(REPO + 'workers/space-core/migrations').sort(), ['0001_baseline.sql', '0002_drop_tempkey.sql']);
  assert.equal(existsSync(REPO + 'workers/space-core/migrations-share'), false);
  assert.deepEqual(readdirSync(REPO + 'workers/space-core/migrations-archive/share').sort(), ['0001_share_links.sql', '0002_drop_atlas_targets.sql', '0003_baseline_space_gateway.sql']);
  const sql = readFileSync(REPO + 'workers/space-core/migrations/0001_baseline.sql', 'utf8').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(sql, /\b(INSERT|DELETE|DROP|UPDATE|ALTER)\b/i);
  const db = new DatabaseSync(':memory:');
  db.exec(sql);
  db.exec(sql); /* 幂等（预览库里表早就在） */
  const objs = (d) => d.prepare("SELECT type || ':' || name AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.n);
  /* 旧库：网关 0001–0009 + 分享链接 0001–0002（同一个库 styrigx-space-gateway） */
  const old = new DatabaseSync(':memory:');
  const arch = REPO + 'workers/space-core/migrations-archive/';
  for (const f of readdirSync(arch + 'gateway').sort()) old.exec(readFileSync(arch + 'gateway/' + f, 'utf8'));
  for (const f of ['0001_share_links.sql', '0002_drop_atlas_targets.sql']) old.exec(readFileSync(arch + 'share/' + f, 'utf8'));
  assert.deepEqual(objs(db), objs(old));
  assert.ok(objs(db).includes('table:share_link') && objs(db).includes('table:epoch'));
  const cols = (d, t) => d.prepare('PRAGMA table_info(' + t + ')').all().map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk].join('|'));
  const idx = (d, t) => d.prepare('PRAGMA index_list(' + t + ')').all().map((i) => [i.name, i.unique, d.prepare('PRAGMA index_info(' + i.name + ')').all().map((c) => c.name).join(',')].join('|')).sort();
  for (const n of objs(db).filter((x) => x.startsWith('table:')).map((x) => x.slice(6))) {
    assert.deepEqual(cols(db, n), cols(old, n), n);
    assert.deepEqual(idx(db, n), idx(old, n), n + ' indexes');
  }
  /* 表只由迁移建：分享链接的代码不兜底（悄悄建空表会掩盖没搬数据） */
  for (const f of ['api/share.js', 'core/share-open.js', 'core/share-links.js']) assert.doesNotMatch(readFileSync(REPO + 'workers/space-core/src/' + f, 'utf8'), /\b(CREATE|DROP)\s+(TABLE|INDEX)\b/i, f);
});

