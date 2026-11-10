/**
 * 代理订阅（设计稿 v1.7）：管理操作、刷新流水线、下载 /s/<令牌>/<来源名>、命名入口 ProxyAdmin。
 * D1 用 node:sqlite 替身（_helpers.mjs），age 成品用测试自己的解密核对（手机 CMFA 同一格式，P0 真机已过）。
 * 运行：node --test tests/workers/proxy-rules/*.test.mjs
 */
import '../account/_cf-workers.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeProxyD1, ageIdentity, ageDecrypt, DB_KEY } from './_helpers.mjs';

const app = (await import('../../../workers/proxy-rules/src/app.js')).default;
const admin = await import('../../../workers/proxy-rules/src/core/sub/admin.js');
const { runRefresh } = await import('../../../workers/proxy-rules/src/core/sub/pipeline.js');
const { extractProxies } = await import('../../../workers/proxy-rules/src/core/sub/parse.js');
const { acquire } = await import('../../../workers/proxy-rules/src/core/sub/lock.js');
const { ProxyAdmin } = await import('../../../workers/proxy-rules/src/rpc/proxy-admin.js');
const { ProxyRefresher } = await import('../../../workers/proxy-rules/src/rpc/proxy-refresher.js');
const { open } = await import('../../../workers/proxy-rules/src/lib/aes.js');
const { importDbKey } = await import('../../../workers/proxy-rules/src/lib/aes.js');

const BASE = 'https://proxy-rules.styrigx.com';
const AIRPORT = 'https://sub.example.com/api/v1/client/subscribe?token=SECRET123';
const yamlOf = (names) => 'port: 7890\nrules:\n  - MATCH,DIRECT\nproxy-groups: []\nproxies:\n' + names.map((n) => `  - { name: "${n}", type: ss, server: 192.0.2.1, port: 8388, cipher: aes-256-gcm, password: p }`).join('\n') + '\n';

let env, id, fetched, airportBody;
const fetchFn = async (url, init) => {
  fetched.push({ url: String(url), ua: init && init.headers && init.headers['user-agent'] });
  if (String(url).startsWith('https://api.github.com/')) return new Response(JSON.stringify({ tag_name: 'v1.19.40' }), { status: 200 });
  const b = airportBody(String(url));
  if (b instanceof Response) return b;
  return new Response(b, { status: 200 });
};

beforeEach(async () => {
  env = { D1_PROXY: makeProxyD1(), SGX_PROXY_DB_KEY: DB_KEY };
  id = await ageIdentity();
  fetched = [];
  airportBody = () => yamlOf(['HK 01', 'JP 01', 'HK 01']);
  globalThis.fetch = fetchFn;
});

const get = (path, headers) => app.fetch(new Request(BASE + path, { headers }), env, { waitUntil() {} });
async function setup() {
  assert.equal((await admin.setKey(env, id.recipient)).ok, true);
  const link = await admin.newLink(env);
  assert.equal(link.ok, true);
  return link.token;
}

test('抽 proxies：只留 proxies，丢规则 / 分组；源内重名加 #2；不是 YAML / 没 proxies / 空 → 错误类别', () => {
  const r = extractProxies(yamlOf(['A', 'B', 'A']));
  assert.equal(r.ok, true);
  assert.deepEqual(r.proxies.map((p) => p.name), ['A', 'B', 'A #2']);
  assert.deepEqual(extractProxies('::: not yaml'), { ok: false, error: 'format' });
  assert.deepEqual(extractProxies('rules: []\n'), { ok: false, error: 'format' });
  assert.deepEqual(extractProxies('proxies: []\n'), { ok: false, error: 'empty' });
  assert.deepEqual(extractProxies('proxies:\n' + Array.from({ length: 1001 }, (_, i) => `  - {name: n${i}, type: ss}`).join('\n')), { ok: false, error: 'too-many' });
});

test('公钥：只收 age1 X25519；PQ 明确拒绝；状态只显示头尾', async () => {
  assert.deepEqual(await admin.setKey(env, 'age1pq1abc'), { ok: false, error: 'pq-unsupported' });
  assert.deepEqual(await admin.setKey(env, 'AGE-SECRET-KEY-1XYZ'), { ok: false, error: 'pubkey' });
  assert.deepEqual(await admin.setKey(env, id.recipient.slice(0, -1) + (id.recipient.endsWith('q') ? 'p' : 'q')), { ok: false, error: 'pubkey' });
  const r = await admin.setKey(env, id.recipient);
  assert.equal(r.ok, true);
  const s = await admin.status(env);
  assert.equal(s.hasKey, true);
  assert.ok(!s.pubkey.includes(id.recipient.slice(12, -8)));
});

test('机场：存链接只存密文和域名；状态不回链接；同名 = 改链接（回新旧域名，旧成品作废）', async () => {
  const r = await admin.addAirport(env, 'Linkcube', AIRPORT);
  assert.deepEqual(r, { ok: true, updated: false, host: 'sub.example.com' });
  const row = env.D1_PROXY.rows('sources')[0];
  assert.ok(!JSON.stringify(row).includes('SECRET123'));
  assert.equal(await open(await importDbKey(DB_KEY), row.id + ':url', row.url_enc), AIRPORT);
  assert.ok(!JSON.stringify(await admin.status(env)).includes('SECRET123'));
  const up = await admin.addAirport(env, 'Linkcube', 'https://other.example.net/s');
  assert.deepEqual({ ...up, id: undefined }, { ok: true, updated: true, oldHost: 'sub.example.com', host: 'other.example.net', nodes: 3, id: undefined });
  assert.equal(up.id, row.id);
  assert.equal(env.D1_PROXY.rows('sources').length, 1);
  for (const bad of ['http://x.example.com/s', 'ftp://x', 'https://u:p@x.example.com/', 'not a url']) assert.deepEqual(await admin.addAirport(env, 'A', bad), { ok: false, error: 'url' });
  for (const bad of ['has space', 'a/b', '', 'x'.repeat(33), '中文']) assert.deepEqual(await admin.addAirport(env, bad, AIRPORT), { ok: false, error: 'name' });
  assert.deepEqual(await admin.upload(env, 'Linkcube', yamlOf(['X'])), { ok: false, error: 'type' });
});

test('P2 改机场链接先试拉：失败什么都不换（旧链接、旧节点、旧成品、last_error 原样），回 kept；成功一条语句换链接和节点，只为这个源重出成品、不再拉第二次', async () => {
  const token = await setup();
  const rpc = new ProxyAdmin({ waitUntil() {} }, env);
  assert.equal((await rpc.addAirport('A', AIRPORT)).ok, true);
  const before = { ...env.D1_PROXY.rows('sources')[0] };
  const armor0 = await (await get(`/s/${token}/A`)).text();
  airportBody = (u) => (u.includes('bad.example.org') ? new Response('nope', { status: 500 }) : yamlOf(['HK 01']));
  const bad = await rpc.addAirport('A', 'https://bad.example.org/s');
  assert.equal(bad.ok, false);
  assert.equal(bad.kept, true);
  assert.equal(bad.oldHost, 'sub.example.com');
  assert.deepEqual({ ...env.D1_PROXY.rows('sources')[0] }, before);
  assert.equal(await (await get(`/s/${token}/A`)).text(), armor0);
  airportBody = () => yamlOf(['NEW 1', 'NEW 2']);
  fetched = [];
  const ok = await rpc.addAirport('A', 'https://good.example.org/s');
  assert.equal(ok.ok, true);
  assert.equal(ok.nodes, 2);
  assert.equal(ok.id, undefined, 'id 不回给 account');
  assert.equal(ok.refresh.ok, true);
  assert.equal(fetched.filter((f) => f.url === 'https://good.example.org/s').length, 1, '只拉一次');
  assert.match(await ageDecrypt(await (await get(`/s/${token}/A`)).text(), id), /NEW 2/);
  assert.equal(env.D1_PROXY.rows('sources')[0].host, 'good.example.org');
});

test('P2 改名 sub-mv：只改名、不刷新，id 和成品沿用，旧路径 404、新路径同内容；新名已存在 exists、旧名不存在 not-found、相同不动作', async () => {
  const token = await setup();
  const rpc = new ProxyAdmin({ waitUntil() {} }, env);
  await rpc.upload('F', yamlOf(['X']));
  await rpc.upload('G', yamlOf(['Y']));
  const idF = env.D1_PROXY.rows('sources').find((r) => r.name === 'F').id;
  const armor = await (await get(`/s/${token}/F`)).text();
  fetched = [];
  assert.deepEqual(await rpc.rename('F', 'H'), { ok: true });
  assert.equal(fetched.length, 0);
  assert.equal(env.D1_PROXY.rows('sources').find((r) => r.name === 'H').id, idF);
  assert.equal((await get(`/s/${token}/F`)).status, 404);
  assert.equal(await (await get(`/s/${token}/H`)).text(), armor);
  assert.deepEqual(await rpc.rename('H', 'G'), { ok: false, error: 'exists' });
  assert.deepEqual(await rpc.rename('nope', 'Z'), { ok: false, error: 'not-found' });
  assert.deepEqual(await rpc.rename('H', 'H'), { ok: true, same: true });
  assert.deepEqual(await rpc.rename('H', 'a/b'), { ok: false, error: 'name' });
});

test('没有 DB_KEY 或钥匙长度不对 → config（fail closed，不存明文）', async () => {
  env.SGX_PROXY_DB_KEY = '';
  assert.deepEqual(await admin.addAirport(env, 'A', AIRPORT), { ok: false, error: 'config' });
  env.SGX_PROXY_DB_KEY = Buffer.alloc(16).toString('base64');
  assert.deepEqual(await admin.upload(env, 'F', yamlOf(['X'])), { ok: false, error: 'config' });
  assert.equal(env.D1_PROXY.rows('sources').length, 0);
});

test('刷新：每源单独加密；用 mihomo UA；手机能解；下载 /s/<令牌>/<来源名> 回各自的节点', async () => {
  const token = await setup();
  await admin.addAirport(env, 'Linkcube', AIRPORT);
  await admin.upload(env, 'Cloady', yamlOf(['Cloady']));
  const r = await runRefresh(env, { fetchFn });
  assert.equal(r.ok, true);
  assert.deepEqual(r.sources.map((s) => [s.name, s.ok, s.nodes]).sort(), [['Cloady', true, 1], ['Linkcube', true, 3]]);
  assert.equal(fetched.find((f) => f.url === AIRPORT).ua, 'mihomo/1.19.40');

  const res = await get(`/s/${token}/Linkcube`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const armor = await res.text();
  assert.match(armor, /^-----BEGIN AGE ENCRYPTED FILE-----\n/);
  const plain = await ageDecrypt(armor, id);
  assert.match(plain, /^# styrigx proxy-rules /);
  assert.deepEqual(JSON.parse(plain.split('\n')[1]).proxies.map((p) => p.name), ['HK 01', 'JP 01', 'HK 01 #2']);
  const c = JSON.parse((await ageDecrypt(await (await get(`/s/${token}/Cloady`)).text(), id)).split('\n')[1]);
  assert.deepEqual(c.proxies.map((p) => p.name), ['Cloady']);
  assert.ok(!plain.includes('MATCH,DIRECT') && !plain.includes('proxy-groups'), '机场自带的规则、分组不进成品');
});

test('下载：错令牌 / 坏令牌 / 没生成链接 / 来源不存在 / 关掉 / 没成品 → 一律 404，不跳转', async () => {
  const token = await setup();
  await admin.addAirport(env, 'A', AIRPORT);
  assert.equal((await get(`/s/${token}/A`)).status, 404, '还没刷新：没成品');
  await runRefresh(env, { fetchFn });
  assert.equal((await get(`/s/${token}/A`)).status, 200);
  const wrong = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
  for (const p of [`/s/${wrong}/A`, '/s/short/A', `/s/${token}/B`, `/s/${token}/A/x`, `/s/${token}`, `/s/${token}/a%2Fb`]) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.equal(r.headers.get('location'), null);
  }
  await admin.setEnabled(env, 'A', false);
  assert.equal((await get(`/s/${token}/A`)).status, 404, '关掉');
  await admin.setEnabled(env, 'A', true);
  const token2 = (await admin.newLink(env)).token;
  assert.equal((await get(`/s/${token}/A`)).status, 404, '重置后旧链接立即失效');
  assert.equal((await get(`/s/${token2}/A`)).status, 200, '重置不动成品');
  assert.equal((await app.fetch(new Request(BASE + `/s/${token2}/A`, { method: 'POST' }), env, {})).status, 405);
});

test('下载限流：RL_SUB 说超了 → 429（错令牌也先过限流）', async () => {
  const keys = [];
  env.RL_SUB = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
  const r = await get('/s/whatever/A', { 'cf-connecting-ip': '198.51.100.7' });
  assert.equal(r.status, 429);
  assert.deepEqual(keys, ['198.51.100.7']);
});

test('刷新：机场失败记类别并沿用上次好的节点；文件源不拉网；关掉的源不碰', async () => {
  const token = await setup();
  await admin.addAirport(env, 'A', AIRPORT);
  await runRefresh(env, { fetchFn });
  airportBody = () => new Response('nope', { status: 503 });
  const r = await runRefresh(env, { fetchFn, now: Date.now() + 1000 });
  const a = r.sources.find((s) => s.name === 'A');
  assert.equal(a.ok, false);
  assert.equal(a.error, 'status');
  assert.equal(a.nodes, 3, '沿用上次');
  assert.equal(env.D1_PROXY.rows('sources')[0].last_error, 'status');
  assert.equal((await get(`/s/${token}/A`)).status, 200);
  airportBody = () => 'proxies: []\n';
  assert.equal((await runRefresh(env, { fetchFn, now: Date.now() + 2000 })).sources[0].error, 'empty');
  await admin.setEnabled(env, 'A', false);
  fetched = [];
  assert.deepEqual((await runRefresh(env, { fetchFn })).sources, []);
  assert.deepEqual(fetched, []);
});

test('刷新：没公钥 → no-pubkey，不写成品；锁被占 → busy；只写更新的版本', async () => {
  await admin.addAirport(env, 'A', AIRPORT);
  assert.deepEqual(await runRefresh(env, { fetchFn }), { ok: false, error: 'no-pubkey' });
  assert.equal(env.D1_PROXY.rows('sources')[0].armor, '');
  await admin.setKey(env, id.recipient);
  const now = Date.now();
  assert.equal(await acquire(env, 'other', now), true);
  assert.deepEqual(await runRefresh(env, { fetchFn, now }), { ok: false, error: 'busy' });
  env.D1_PROXY.raw.exec('UPDATE lock SET expires = 0');
  await runRefresh(env, { fetchFn, now: now + 5000 });
  const gen = env.D1_PROXY.rows('sources')[0].gen;
  await runRefresh(env, { fetchFn, now: now + 1000 });
  assert.equal(env.D1_PROXY.rows('sources')[0].gen, gen, '旧时间的刷新不覆盖新成品');
  assert.equal(env.D1_PROXY.rows('lock')[0].expires, 0, '用完放锁');
});

test('换公钥：旧成品立即作废，自动刷新后用新公钥重加密', async () => {
  const token = await setup();
  await admin.upload(env, 'F', yamlOf(['X']));
  await runRefresh(env, { fetchFn });
  const id2 = await ageIdentity();
  const rpc = new ProxyAdmin({ waitUntil() {} }, env);
  const r = await rpc.setKey(id2.recipient);
  assert.equal(r.ok, true);
  assert.equal(r.refresh.ok, true);
  const armor = await (await get(`/s/${token}/F`)).text();
  await assert.rejects(ageDecrypt(armor, id));
  assert.match(await ageDecrypt(armor, id2), /"X"/);
});

test('ProxyAdmin：改动后自动刷新一次；删源删整行；没绑 D1 → config', async () => {
  const token = await setup();
  const rpc = new ProxyAdmin({ waitUntil() {} }, env);
  const add = await rpc.addAirport('A', AIRPORT);
  assert.equal(add.ok, true);
  assert.equal(add.refresh.ok, true);
  assert.equal((await get(`/s/${token}/A`)).status, 200);
  assert.equal((await rpc.upload('F', 'nonsense: 1')).error, 'format');
  assert.deepEqual(await rpc.remove('A').then((r) => r.ok), true);
  assert.equal(env.D1_PROXY.rows('sources').length, 0);
  assert.equal((await get(`/s/${token}/A`)).status, 404);
  assert.deepEqual(await rpc.remove('A'), { ok: false, error: 'not-found' });
  const bare = new ProxyAdmin({}, {});
  assert.deepEqual(await bare.status(), { ok: false, error: 'config' });
});

test('公网没有管理 / 刷新入口：/internal/*、/api/* 一律 404', async () => {
  for (const p of ['/internal/refresh', '/api/refresh', '/api/proxy', '/s/', '/s']) assert.equal((await get(p)).status, 404, p);
});

test('scheduled：没绑 D1 不动；绑了就刷新', async () => {
  await app.scheduled({}, {}, { waitUntil() {} });
  await setup();
  await admin.upload(env, 'F', yamlOf(['X']));
  const waits = [];
  await app.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.notEqual(env.D1_PROXY.rows('sources')[0].armor, '');
});

test('绑了 SELF：每个源各走一次 ProxyRefresher 调用（各算各的 CPU）；锁不在 owner 手里就不做', async () => {
  const token = await setup();
  await admin.addAirport(env, 'A', AIRPORT);
  await admin.upload(env, 'F', yamlOf(['X']));
  const calls = [];
  const refresher = new ProxyRefresher({}, env);
  env.SELF = { refreshSource: (...a) => { calls.push(a[0]); return refresher.refreshSource(...a); } };
  const r = await runRefresh(env);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.equal((await get(`/s/${token}/A`)).status, 200);
  assert.equal((await get(`/s/${token}/F`)).status, 200);
  const id0 = env.D1_PROXY.rows('sources')[0].id;
  assert.deepEqual(await refresher.refreshSource(id0, 'someone-else', Date.now(), 'mihomo/1'), { ok: false, error: 'busy' });
});
