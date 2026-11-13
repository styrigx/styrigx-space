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
  const link = await admin.rotateToken(env);
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

test('节点链接列表（机场源）：base64 / 明文都认，六种协议转 mihomo 节点，认不出的行跳过；上传文件不认', () => {
  const vm = Buffer.from(JSON.stringify({ v: '2', ps: '美国 VM', add: 'v.example.com', port: '443', id: 'u-1', aid: '0', scy: 'auto', net: 'ws', type: 'none', host: 'h.example.com', path: '/ws?ed=2048', tls: 'tls', sni: 's.example.com' })).toString('base64');
  const ssUser = Buffer.from('aes-128-gcm:pw').toString('base64');
  const lines = [
    'hysteria2://pass@hy.example.com:443?sni=sni.example.com&insecure=1&obfs=salamander&obfs-password=op#%E9%A6%99%E6%B8%AF%20HY',
    'hy2://p2@hop.example.com:20000,21000-22000/?sni=a#hop',
    'vless://uuid-1@vl.example.com:443?security=reality&pbk=PK&sid=ab&fp=chrome&type=grpc&serviceName=svc&flow=xtls-rprx-vision&sni=www.example.com#VL',
    'vmess://' + vm,
    'trojan://tpw@tj.example.com:443?sni=t.example.com&type=ws&path=%2Fp#TJ',
    'ss://' + ssUser + '@ss.example.com:8388#SS',
    'tuic://uu:pp@tu.example.com:443?congestion_control=bbr&alpn=h3#TU',
    'ssr://abc',
    'not a link',
    'hysteria2://pass@hy.example.com:443#%E9%A6%99%E6%B8%AF%20HY',
  ].join('\n');
  for (const text of [lines, Buffer.from(lines).toString('base64')]) {
    const r = extractProxies(text, { links: true });
    assert.equal(r.ok, true);
    assert.deepEqual(r.proxies.map((p) => [p.name, p.type]), [['香港 HY', 'hysteria2'], ['hop', 'hysteria2'], ['VL', 'vless'], ['美国 VM', 'vmess'], ['TJ', 'trojan'], ['SS', 'ss'], ['TU', 'tuic'], ['香港 HY #2', 'hysteria2']]);
    const [hy, hop, vl, vmx, tj, ss, tu] = r.proxies;
    assert.equal(hy.server, 'hy.example.com'); assert.equal(hy.port, '443'); assert.equal(hy.password, 'pass');
    assert.equal(hy.sni, 'sni.example.com'); assert.equal(hy['skip-cert-verify'], true); assert.equal(hy.obfs, 'salamander'); assert.equal(hy['obfs-password'], 'op');
    assert.equal(hop.port, '20000'); assert.equal(hop.ports, '20000,21000-22000');
    assert.equal(vl.uuid, 'uuid-1'); assert.equal(vl.tls, true); assert.equal(vl.flow, 'xtls-rprx-vision'); assert.equal(vl.servername, 'www.example.com');
    assert.deepEqual(vl['reality-opts'], { 'public-key': 'PK', 'short-id': 'ab' }); assert.equal(vl.network, 'grpc'); assert.deepEqual(vl['grpc-opts'], { 'grpc-service-name': 'svc' });
    assert.equal(vmx.server, 'v.example.com'); assert.equal(vmx.uuid, 'u-1'); assert.equal(vmx.tls, true); assert.equal(vmx.servername, 's.example.com'); assert.equal(vmx.network, 'ws');
    assert.deepEqual(vmx['ws-opts'], { path: '/ws', headers: { Host: 'h.example.com' }, 'max-early-data': 2048, 'early-data-header-name': 'Sec-WebSocket-Protocol' });
    assert.equal(tj.password, 'tpw'); assert.equal(tj.sni, 't.example.com'); assert.deepEqual(tj['ws-opts'], { path: '/p', headers: {} });
    assert.equal(ss.cipher, 'aes-128-gcm'); assert.equal(ss.password, 'pw'); assert.equal(ss.port, '8388');
    assert.equal(tu.uuid, 'uu'); assert.equal(tu.password, 'pp'); assert.equal(tu['congestion-controller'], 'bbr'); assert.deepEqual(tu.alpn, ['h3']);
  }
  assert.deepEqual(extractProxies('ssr://x\nsocks://y\nhello', { links: true }), { ok: false, error: 'format' }, '一个都认不出 → 原 format');
  assert.deepEqual(extractProxies(Buffer.from('hysteria2://p@h.example.com:443#A').toString('base64')), { ok: false, error: 'format' }, '上传文件不走链接列表');
  const many = Array.from({ length: 1001 }, (_, i) => `trojan://p@h${i}.example.com:443#n${i}`).join('\n');
  assert.deepEqual(extractProxies(many, { links: true }), { ok: false, error: 'too-many' });
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

test('改名 sub mv：只改名、不刷新，id 和成品沿用，旧路径 404、新路径同内容；新名已存在 exists、旧名不存在 not-found、相同不动作', async () => {
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

test('令牌（sub v3.1）：哈希 + 封存原文同一次写；sub show 随时重印同一个；sub token 换新、旧链接失效；库里没有明文', async () => {
  assert.deepEqual(await admin.showToken(env), { ok: false, error: 'no-token' });
  assert.equal((await admin.status(env)).token, 'none');
  const t1 = await setup();
  assert.equal((await admin.status(env)).token, 'sealed');
  assert.deepEqual(await admin.showToken(env), { ok: true, token: t1 });
  assert.deepEqual(await admin.showToken(env), { ok: true, token: t1 }, '可以反复重印');
  const meta = Object.fromEntries(env.D1_PROXY.rows('meta').map((r) => [r.k, r.v]));
  assert.ok(!JSON.stringify(meta).includes(t1), '库里没有令牌明文');
  assert.match(meta.token_hash, /^[0-9a-f]{64}$/);
  assert.match(meta.token_sealed, /^v1\./);
  assert.equal(await open(await importDbKey(DB_KEY), 'meta:token', meta.token_sealed), t1);
  await assert.rejects(open(await importDbKey(DB_KEY), 'x:url', meta.token_sealed), undefined, '附加数据绑死 meta:token');
  await admin.upload(env, 'F', yamlOf(['X']));
  await runRefresh(env, { fetchFn });
  assert.equal((await get(`/s/${t1}/F`)).status, 200);
  const t2 = (await admin.rotateToken(env)).token;
  assert.notEqual(t2, t1);
  assert.deepEqual(await admin.showToken(env), { ok: true, token: t2 });
  assert.equal((await get(`/s/${t1}/F`)).status, 404, '换令牌后旧链接立即失效');
  assert.equal((await get(`/s/${t2}/F`)).status, 200);
  /* 下载只比哈希，不读 DB_KEY */
  env.SGX_PROXY_DB_KEY = '';
  assert.equal((await get(`/s/${t2}/F`)).status, 200, '下载不需要 DB_KEY');
  assert.deepEqual(await admin.showToken(env), { ok: false, error: 'config' });
  assert.deepEqual(await admin.rotateToken(env), { ok: false, error: 'config' });
  assert.deepEqual(await admin.showToken({ ...env, SGX_PROXY_DB_KEY: Buffer.alloc(32, 9).toString('base64') }), { ok: false, error: 'config' }, '钥匙不对解不开 → config');
});

test('令牌只有哈希（封存上线前生成的）：下载照常；状态 hash-only；sub show 回 token-unsealed，换新后可重印', async () => {
  await admin.setKey(env, id.recipient);
  const old = 'o'.repeat(43);
  const { hashToken } = await import('../../../workers/proxy-rules/src/lib/token.js');
  env.D1_PROXY.raw.prepare("INSERT INTO meta (k, v) VALUES ('token_hash', ?)").run(await hashToken(old));
  await admin.upload(env, 'F', yamlOf(['X']));
  await runRefresh(env, { fetchFn });
  assert.equal((await get(`/s/${old}/F`)).status, 200);
  assert.equal((await admin.status(env)).token, 'hash-only');
  assert.deepEqual(await admin.showToken(env), { ok: false, error: 'token-unsealed' });
  const t = (await admin.rotateToken(env)).token;
  assert.deepEqual(await admin.showToken(env), { ok: true, token: t });
  assert.equal((await get(`/s/${old}/F`)).status, 404);
});

test('ProxyAdmin：没有 refresh / newLink（sub-refresh、sub-link 取消）；showToken / rotateToken 在', () => {
  const p = ProxyAdmin.prototype;
  assert.equal(typeof p.refresh, 'undefined');
  assert.equal(typeof p.newLink, 'undefined');
  assert.equal(typeof p.showToken, 'function');
  assert.equal(typeof p.rotateToken, 'function');
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
  const ap = JSON.parse(plain.split('\n')[1]).proxies;
  assert.deepEqual(ap.map((p) => p.name), ['🇭🇰 HK 01', '🇯🇵 JP 01', '🇭🇰 HK 01 #2'], '机场源：按初始映射词加国旗');
  assert.ok(ap.every((p) => p['client-fingerprint'] === 'chrome'), '指纹默认 chrome');
  const c = JSON.parse((await ageDecrypt(await (await get(`/s/${token}/Cloady`)).text(), id)).split('\n')[1]);
  assert.deepEqual(c.proxies.map((p) => p.name), ['Cloady']);
  assert.equal(c.proxies[0]['client-fingerprint'], undefined, '文件源一律不处理');
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
  const token2 = (await admin.rotateToken(env)).token;
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

/* ---- v1.13 节点处理：sub map / sub fp / sub update ---- */
const N = await import('../../../workers/proxy-rules/src/core/sub/nodes.js');

test('nodes：丢弃 → 去旧图标（任何位置）→ 加国旗 → 指纹 → 重名 #n；短词整词匹配；文件源不走这里', () => {
  const rules = { drop: ['剩余'], flags: [{ word: 'us', flag: '🇺🇸' }, { word: '香港', flag: '🇭🇰' }], fp: 'safari' };
  const r = N.processNodes([
    { name: '剩余流量 10G', type: 'ss' }, { name: '🇭🇰 香港 01 🚀', type: 'ss' }, { name: 'Russia 1', type: 'ss' }, { name: 'US-2', type: 'ss' }, { name: '香港 01', type: 'ss' },
  ], rules);
  assert.equal(r.dropped, 1);
  assert.deepEqual(r.proxies.map((p) => p.name), ['🇭🇰 香港 01', 'Russia 1', '🇺🇸 US-2', '🇭🇰 香港 01 #2']);
  assert.deepEqual(r.unmatched, ['Russia 1'], 'us 不命中 russia');
  assert.ok(r.proxies.every((p) => p['client-fingerprint'] === 'safari'));
  assert.equal(N.processNodes([{ name: 'a', type: 'ss', 'client-fingerprint': 'qq' }], { drop: [], flags: [], fp: 'none' }).proxies[0]['client-fingerprint'], 'qq', 'none = 不加');
  assert.deepEqual(['⚡HK 01', '🎮 US-游戏 ✈️', '新加坡 1️⃣ x', '香港🇭🇰01', '🏴‍☠️ 01'].map(N.stripIcons), ['HK 01', 'US-游戏', '新加坡 1 x', '香港 01', '01'], '任何 emoji 都去掉（Gray 2026-11-14）');
  assert.equal(N.countDropped([{ name: '剩余 到期' }, { name: '到期' }], '到期', ['剩余']), 1, '已被别的丢弃词丢掉的不算');
});

test('sub map：单词 = 丢弃（回多丢几个）；双词 = 国家码（两位三位同一目标）；源词两表唯一；rm 只带源词；坏码 / 冷词拒绝', async () => {
  await setup();
  await admin.addAirport(env, 'Linkcube', AIRPORT);
  airportBody = () => yamlOf(['狮城 01', '剩余流量', 'HK 01', 'Zz 9']);
  await runRefresh(env, { fetchFn });
  let r = await admin.mapSet(env, '狮城', 'SGP');
  assert.deepEqual([r.ok, r.code, r.flag, r.changed], [true, 'SG', '🇸🇬', true], '初始词里已有狮城 → 改目标');
  r = await admin.mapSet(env, ' 新词 ', 'jp');
  assert.deepEqual([r.ok, r.word, r.code, r.changed], [true, '新词', 'JP', false]);
  assert.deepEqual(await admin.mapSet(env, 'zz'), { ok: true, word: 'zz', drop: true, dropped: 1 });
  assert.deepEqual(await admin.mapSet(env, 'zz', 'US'), { ok: false, error: 'exists', as: 'drop' });
  const hk = await admin.mapSet(env, '港');
  assert.deepEqual([hk.ok, hk.error, hk.as, hk.flag], [false, 'exists', 'HK', '🇭🇰'], '已是映射词又敲单词 → 拒绝');
  assert.equal((await admin.mapSet(env, 'x', 'XX')).error, 'bad-code');
  assert.equal((await admin.mapSet(env, 'x', 'S1')).error, 'bad-code');
  for (const bad of ['', 'rm', 'LS', 'x'.repeat(33)]) assert.equal((await admin.mapSet(env, bad)).error, 'word', bad);
  assert.deepEqual(await admin.mapRm(env, 'zz'), { ok: true, word: 'zz' });
  assert.equal((await admin.mapRm(env, 'zz')).error, 'not-found');
  const list = await admin.mapList(env);
  assert.ok(list.flags.some((f) => f.word === '新词' && f.flag === '🇯🇵'));
  assert.ok(list.drop.includes('剩余'));
  assert.deepEqual((await admin.mapLs(env, 'Linkcube')).names, ['Zz 9']);
  await admin.upload(env, 'Cloady', yamlOf(['Cloady']));
  assert.equal((await admin.mapLs(env, 'Cloady')).error, 'type');
});

test('sub fp：默认 chrome；只收可选值；改后机场源用原始节点重处理不拉机场', async () => {
  await setup();
  await admin.addAirport(env, 'Linkcube', AIRPORT);
  await runRefresh(env, { fetchFn });
  assert.deepEqual(await admin.fp(env), { ok: true, fp: 'chrome' });
  assert.equal((await admin.fp(env, 'opera')).error, 'fp');
  assert.deepEqual(await admin.fp(env, 'Firefox'), { ok: true, fp: 'firefox', changed: true });
  const before = fetched.length;
  const r = await runRefresh(env, { fetchFn, noFetch: true, airports: true });
  assert.equal(r.ok, true);
  assert.equal(fetched.length, before, '不拉机场');
});

test('sub update：只机场源；off 报 off；文件报 type；回 id 只拉这一个', async () => {
  await setup();
  await admin.addAirport(env, 'Linkcube', AIRPORT);
  await admin.upload(env, 'Cloady', yamlOf(['Cloady']));
  assert.equal((await admin.update(env, 'Cloady')).error, 'type');
  assert.equal((await admin.update(env, 'Nope')).error, 'not-found');
  const ok = await admin.update(env, 'Linkcube');
  assert.equal(ok.ok, true);
  assert.ok(ok.id);
  await admin.setEnabled(env, 'Linkcube', false);
  assert.equal((await admin.update(env, 'Linkcube')).error, 'off');
});
