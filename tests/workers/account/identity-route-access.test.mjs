/**
 * v6 路由全量盘点（workers/account/src/core/route-access.js ROUTE_ACCESS）：
 * - 全量：网关 API_ROUTES / 转发表、账号 API_ROUTES / 头像、奇趣、日刻、代理订阅的每个「方法 + 路径」都在表里，表里每一行都有处理函数
 *   （新加接口不进表 → 这里红；删接口不删表 → 这里也红）
 * - 只经服务绑定的入口（ai、status）不进表，列在 SERVICE_ONLY
 * - 多 action 接口：源码里出现的 action / op 都在表的 actions 里
 * - 档都合法；删除两级：del:'item' 只在写组或更低的档上，del:'bulk' 只属 root；原来要 reauth 的操作是 root
 * - 默认拒绝：不在表里 → null；主站 /s/ 一段（分享短链，v6 P4 删）不在表里，代理主机两段 = 订阅；多一段 / 换方法 / 编码都对不上
 * - 摘要快照：各档条数（改表时这里跟着改，评审一眼看见）
 *
 * 运行：node --test tests/workers/account/identity-route-access.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routeAccess as RA, groups as G } from './_identity.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const W = REPO + 'workers/';
const gw = await import(W + 'space-core/src/router.js');
const acc = await import(W + 'account/src/router.js');
const curio = await import(W + 'atlas-core/src/curio/routes.js');
const music = await import(W + 'atlas-core/src/music/routes.js');
const games = await import(W + 'atlas-core/src/games/routes.js');
const daymark = await import(W + 'atlas-core/src/daymark/routes.js');
const proxy = await import(W + 'proxy/src/router.js');
const ai = await import(W + 'ai/src/router.js');

const METHODS = ['Get', 'Post', 'Put', 'Delete', 'Head', 'Patch', 'Options'];
/** 模块显式导出的方法（onRequest<Method>） @param {Record<string, any>} mod */
const methodsOf = (mod) => METHODS.filter((m) => typeof mod['onRequest' + m] === 'function').map((m) => m.toUpperCase());

/** 所有「有处理函数」的 主机 + 方法 + 路径（主站路径都是公开地址） */
function handled() {
  /** @type {Array<{host:string, path:string, methods:string[], generic:boolean, file:string}>} */
  const out = [];
  const add = (path, mod, file, host = RA.MAIN_HOST) => out.push({ host, path, methods: methodsOf(mod), generic: typeof mod.onRequest === 'function', file });
  for (const [p, mod] of gw.API_ROUTES) add(p, mod, 'space-core/src/api' + p.slice(4) + '.js');
  for (const [p, mod] of acc.API_ROUTES) add(p, mod, 'account/src/api/' + (p.startsWith('/api/account/') ? 'account/' + p.slice(13) : p.slice(5)) + '.js');
  out.push({ host: RA.MAIN_HOST, path: '/avatar/:file', methods: ['GET'], generic: false, file: 'account/src/api/avatar-file.js' });
  for (const [p, mod] of curio.API_ROUTES) add('/curio' + p, mod, 'atlas-core/src/curio/api' + p.slice(4) + '.js');
  /* 音乐：/music/api/*（atlas-core/src/music/routes.js；handler 仍是 curio/api/music*.js）；music 搬家第 4 步起旧 /curio/api/music* 不再挂 */
  for (const [p, mod] of music.API_ROUTES) add('/music' + p, mod, 'atlas-core/src/curio/api' + p.slice(4) + '.js');
  for (const [p, mod] of daymark.API_ROUTES) add('/daymark' + p, mod, 'atlas-core/src/daymark/api' + p.slice(4) + '.js');
  /* 游戏：/games/api/*（奇趣重组 PR 1；atlas-core/src/games/routes.js，handler 在 games/api/，复用奇趣的数据层与照片规则） */
  for (const [p, mod] of games.API_ROUTES) add('/games' + p, mod, 'atlas-core/src/games/api' + p.slice(4) + '.js');
  return out;
}

test('全量：每个处理函数的方法都在表里；表里主站的每一行都有处理函数', () => {
  const h = handled();
  const rules = RA.ROUTE_ACCESS.filter((r) => r.host === RA.MAIN_HOST);
  for (const x of h) {
    const listed = rules.filter((r) => r.path === x.path).map((r) => r.method);
    for (const m of x.methods) assert.ok(listed.includes(m), '漏了 ' + m + ' ' + x.path);
    if (!x.methods.length) assert.ok(listed.length > 0, '漏了 ' + x.path + '（只有 onRequest）');
    if (x.path === '/daymark/api/today') assert.deepEqual(listed.sort(), ['GET', 'HEAD', 'OPTIONS', 'PUT']);
  }
  for (const r of rules) {
    const x = h.find((y) => y.path === r.path);
    assert.ok(x, '表里有、代码里没有：' + r.method + ' ' + r.path);
    assert.ok(x.methods.includes(r.method) || x.generic, '没有处理函数：' + r.method + ' ' + r.path);
  }
  /* 网关转发表里的前缀都落在账号路由上 */
  for (const f of gw.FORWARDING) assert.ok(rules.some((r) => r.path === f.path || r.path.startsWith(f.path)), '转发前缀 ' + f.path);
});

test('奇趣、日刻：旧访问表（v5）里的每一条在 v6 表里都有', () => {
  for (const r of curio.ROUTE_ACCESS) assert.ok(RA.ruleOf(r.method, '/curio' + r.path), 'curio ' + r.method + ' ' + r.path);
  for (const r of daymark.ROUTE_ACCESS) assert.ok(RA.ruleOf(r.method, '/daymark' + r.path), 'daymark ' + r.method + ' ' + r.path);
  for (const r of music.ROUTE_ACCESS) assert.ok(RA.ruleOf(r.method, '/music' + r.path), 'music ' + r.method + ' ' + r.path);
  for (const r of games.ROUTE_ACCESS) assert.ok(RA.ruleOf(r.method, '/games' + r.path), 'games ' + r.method + ' ' + r.path);
  assert.equal(RA.levelOf('POST', '/curio/api/import'), 'root', '原来要账号复验的导入 → sudo = root（旧结论的 REAUTH_ROUTES 随 conclusion() 删除）');
});

test('代理主机：订阅两段、规则集、健康检查；ai / status 只经服务绑定，在 SERVICE_ONLY', () => {
  assert.equal(RA.levelOf('GET', '/s/tok123/clash', { host: RA.PROXY_HOST }), 'public');
  assert.equal(RA.levelOf('HEAD', '/s/tok123/clash', { host: RA.PROXY_HOST }), 'public');
  assert.equal(RA.levelOf('GET', '/s/tok123', { host: RA.PROXY_HOST }), null, '代理主机上一段 /s/ 不是订阅');
  assert.equal(RA.levelOf('POST', '/s/tok/clash', { host: RA.PROXY_HOST }), null);
  assert.equal(RA.levelOf('GET', '/meta/geo/geosite/cn.mrs', { host: RA.PROXY_HOST }), 'public');
  for (const p of proxy.ROUTES.keys()) assert.ok(RA.ruleOf('GET', p, { host: PROXY() }), p);
  for (const p of ai.ROUTES.keys()) assert.ok(RA.SERVICE_ONLY.some((s) => s.worker === 'ai' && s.entry.endsWith(' ' + p)), 'ai ' + p);
  assert.ok(RA.SERVICE_ONLY.some((s) => s.worker === 'status' && s.entry === 'GET /summary'));
  assert.equal(RA.levelOf('GET', '/ask'), null, 'ai 的内部路径在主站上对不上表');
});
function PROXY() { return RA.PROXY_HOST; }

test('主站 /s/ 一段（分享短链）v6 P4 删除、不在表里；主站两段不在表里；代理订阅两段保留', () => {
  assert.equal(RA.ruleOf('GET', '/s/AbCdEf0123456789abcdEF'), null);
  assert.equal(RA.ruleOf('HEAD', '/s/AbCdEf0123456789abcdEF'), null);
  assert.equal(RA.ruleOf('GET', '/s/a/b'), null);
  assert.equal(RA.ruleOf('GET', '/s/'), null);
  const sub = RA.ROUTE_ACCESS.filter((r) => r.path === '/s/:token/:source');
  assert.ok(sub.length === 2 && sub.every((r) => r.host === RA.PROXY_HOST && !r.retire), '代理订阅保留');
});

test('默认拒绝与精确匹配', () => {
  assert.equal(RA.levelOf('GET', '/api/nope'), null);
  assert.equal(RA.levelOf('DELETE', '/api/status'), null, '换方法');
  assert.equal(RA.levelOf('GET', '/api/status/x'), null, '多一段');
  assert.equal(RA.levelOf('GET', '/api/%73tatus'), null, '编码');
  assert.equal(RA.levelOf('GET', '/API/status'), null, '大小写');
  assert.equal(RA.levelOf('GET', '/api/status/'), 'status-use', '结尾一个 / 算同一条');
  assert.equal(RA.levelOf('GET', '/avatar/96.webp'), 'public');
  assert.equal(RA.levelOf('GET', '/avatar/a/b'), null);
});

test('action：源码里出现的 action / op 都在表里；没写 action 用路由档；不认识的 action → null', () => {
  const pick = (file) => {
    const src = readFileSync(W + file, 'utf8');
    return new Set([...src.matchAll(/action (?:===|!==) '([a-z0-9-]+)'/g)].map((m) => m[1]));
  };
  const files = {
    '/api/account/devices': 'account/src/api/account/devices.js',
    '/api/account/proxy': 'account/src/api/account/proxy.js',
  };
  for (const [p, f] of Object.entries(files)) {
    const r = RA.ruleOf('POST', p);
    assert.ok(r && r.actions, p + ' 要列 actions');
    for (const a of pick(f)) assert.ok(Object.prototype.hasOwnProperty.call(r.actions, a), p + ' 漏了 action ' + a);
  }
  const musicSrc = readFileSync(W + 'atlas-core/src/curio/api/_music.js', 'utf8');
  for (const m of musicSrc.matchAll(/case '([a-z]+\.[a-z]+)'/g)) assert.ok(RA.levelOf('POST', '/music/api/music', { action: m[1] }), 'music ' + m[1]);
  assert.equal(RA.levelOf('POST', '/music/api/music', { action: 'album.del' }), 'root');
  assert.equal(RA.levelOf('POST', '/music/api/music', { action: 'track.del' }), 'music-manage');
  /* M4（音乐 v1.19 十二 M4 第 1 条）：改歌手信息 music-manage（组权限 v1.1 §六，原 curio-write）；合并、删歌手 root（一次性票） */
  assert.equal(RA.levelOf('POST', '/music/api/music', { action: 'artist.edit' }), 'music-manage');
  assert.equal(RA.levelOf('POST', '/music/api/music', { action: 'artist.merge' }), 'root');
  assert.equal(RA.levelOf('POST', '/music/api/music', { action: 'artist.del' }), 'root');
  /* 定稿 v5.5 §五 / §七：设备列表站长直读（webmaster），踢出属后台控制（root，站长 sudo） */
  assert.equal(RA.levelOf('POST', '/api/account/devices'), 'webmaster');
  assert.equal(RA.levelOf('POST', '/api/account/devices', { action: 'list' }), 'webmaster');
  assert.equal(RA.levelOf('POST', '/api/account/devices', { action: 'revoke' }), 'root');
  assert.equal(RA.levelOf('POST', '/api/account/devices', { action: 'revoke-all' }), 'root');
  assert.equal(RA.levelOf('POST', '/api/account/devices', { action: 'hack' }), null);
});

test('档合法；删除两级；sudo 继任；root 不能从访客直接登录', () => {
  const rank = (lv) => (lv === 'root' ? 2 : 1);
  for (const r of RA.ROUTE_ACCESS) {
    assert.ok(G.ACCESS_LEVELS.includes(r.level), r.path);
    assert.ok(Object.isFrozen(r));
    if (r.del === 'bulk') assert.equal(r.level, 'root', '结构删除只属 root：' + r.method + ' ' + r.path);
    if (r.del === 'item' && r.method === 'DELETE') assert.ok(rank(r.level) === 1, '单条删除归 manage 组：' + r.path);
    assert.ok(typeof r.why === 'string' && r.why.length > 0);
  }
  assert.equal(RA.levelOf('POST', '/curio/api/import'), 'root');
  for (const p of ['/api/account/session', '/api/account/reauth', '/api/account/reset', '/api/account/keys', '/api/account/grants']) assert.equal(RA.ruleOf('POST', p), null, p + '（v6 P4 删）');
  assert.equal(RA.levelOf('POST', '/api/identity', { action: 'su' }), 'public', 'su root 的 wheel 要求在接口内（身份命令），不在路由档');
  assert.equal(RA.levelOf('DELETE', '/daymark/api/quotes'), 'daymark-manage');
  assert.equal(RA.levelOf('DELETE', '/curio/api/photo'), 'curio-manage');
});

test('摘要快照：各档路由数（改表必须改这里）', () => {
  const count = {};
  for (const r of RA.ROUTE_ACCESS) count[r.level] = (count[r.level] || 0) + 1;
  assert.deepEqual(count, { public: 26, 'ai-use': 2, 'status-use': 1, root: 5, webmaster: 5, user: 1, 'curio-manage': 6, 'music-manage': 2, 'music-use': 3, 'daymark-manage': 6, 'games-manage': 3 },
    'P4-3（定稿 v5.5 §五）：avatar PUT / DELETE、prefs POST、devices 由 user 改 webmaster；组权限 v1.1 §六：音乐的 POST music / music-upload 从 curio-write 拆到 music-manage；music 搬家第 2 步加 /music/api/* 7 行、第 4 步删旧 /curio/api/music* 7 行（音乐：public 2、music-manage 2、music-use 3）；奇趣重组 PR 1 加 /games/api/* 5 行（public 2、games-manage 3）');
  assert.equal(RA.ROUTE_ACCESS.length, 60, 'v6 P4 删旧入口 20 条（78 → 58），应用授权 /api/account/grants 删除（58 → 57），数字健康 POST / GET /api/wellbeing 删除（57 → 55），music 搬家第 2 步加 /music/api/* 7 行（55 → 62），第 4 步删旧 /curio/api/music* 7 行（62 → 55），奇趣重组 PR 1 加 /games/api/* 5 行（55 → 60）');
  assert.equal(RA.ROUTE_ACCESS.filter((r) => r.decided).length, 14, 'Gray 2026-11-11 定稿的 17 条，P4 删 lock-all-devices 后 16 条，数字健康两条删除后 14 条');
  assert.equal(RA.ROUTE_ACCESS.filter((r) => 'doubt' in r).length, 0, '不再有存疑');
  assert.equal(RA.levelOf('GET', '/curio/api/export'), 'root', '导出含私密 → root（Gray 2026-11-11）');
  assert.equal(RA.levelOf('PUT', '/api/profile'), 'webmaster', '站长名片只有一份：站长 + root（P2 定稿 v4）');
  assert.equal(RA.levelOf('GET', '/api/profile'), 'public', '主页名片公开');
  /* P4-3（定稿 v5.5 §五「avatar、prefs 写入 webmaster」、§七「全站只有一份配置……普通用户只能看」） */
  assert.equal(RA.levelOf('PUT', '/api/avatar'), 'webmaster');
  assert.equal(RA.levelOf('DELETE', '/api/avatar'), 'webmaster');
  assert.equal(RA.levelOf('POST', '/api/prefs'), 'webmaster');
  assert.equal(RA.levelOf('GET', '/api/prefs'), 'user', '普通用户只能看');
});

test('/api/identity（P2）：每个 action 一档；救援白名单 = RESCUE_COMMANDS 对应的 action；rescueOf 只放列出的', () => {
  const lv = (a) => RA.levelOf('POST', '/api/identity', { action: a });
  for (const a of ['whoami', 'su-challenge', 'su', 'exit', 'idle', 'lock']) assert.equal(lv(a), 'public', a);
  for (const a of ['passwd', 'groups', 'who', 'self-challenge']) assert.equal(lv(a), 'user', a);
  /* 定稿 v5.5 §五：通行密钥增删 webmaster，passkey 列表同样 webmaster；普通用户只能 passwd（§八） */
  for (const a of ['passkey-list', 'passkey-add-challenge', 'passkey-add', 'passkey-delete']) assert.equal(lv(a), 'webmaster', a);
  for (const a of ['sudo', 'sudo-challenge']) assert.equal(lv(a), 'sudoers', a);
  for (const a of ['useradd', 'userdel', 'usermod', 'passwd-user']) assert.equal(lv(a), 'root', a);
  assert.equal(lv('recovery-key'), null, '不认识的 action 拒绝');
  const rescue = RA.ROUTE_ACCESS.find((r) => r.path === '/api/identity').rescueActions;
  const cmdOf = (a) => a.split('-')[0];
  assert.deepEqual([...new Set(rescue.map(cmdOf))].sort(), [...G.RESCUE_COMMANDS].sort(), '救援白名单 = passwd、passkey、whoami、groups、exit、lock');
  for (const a of rescue) assert.equal(RA.rescueOf('POST', '/api/identity', { action: a }), true, a);
  for (const a of ['su', 'sudo', 'useradd', 'userdel', 'usermod', 'who', 'idle', 'self-challenge']) assert.equal(RA.rescueOf('POST', '/api/identity', { action: a }), false, a);
  assert.equal(RA.rescueOf('POST', '/api/identity', { action: 'passwd-user' }), true, 'R-34：救援放 passwd styrigx（目标服务端限定）');
  assert.equal(RA.rescueOf('POST', '/api/identity'), false, '没给 action 不放');
  assert.equal(RA.rescueOf('POST', '/api/account/keys'), false, '/api/account/keys v6 P4 删除');
  assert.equal(RA.rescueOf('GET', '/api/status'), false);
});

test('盘点文档 docs/architecture/v6-route-inventory.md 与表一致（每一行的方法、路径、档）', () => {
  const doc = readFileSync(REPO + 'docs/architecture/v6-route-inventory.md', 'utf8');
  const lines = doc.split('\n').filter((l) => /^\| [A-Z]+ \| `/.test(l));
  assert.equal(lines.length, RA.ROUTE_ACCESS.length, '行数');
  for (const r of RA.ROUTE_ACCESS) {
    const head = '| ' + r.method + ' | `' + r.path + '` | **' + r.level + '**';
    assert.ok(lines.some((l) => l.startsWith(head)), '文档缺 ' + head);
  }
});

test('组权限 v1.1 §八：带 product 的行组名由 product / kind 推出，推出来的组都在 GROUPS 里；kind 与档一致；覆盖处有 overrideWhy', () => {
  const products = RA.ROUTE_ACCESS.filter((r) => r.product !== undefined);
  assert.ok(products.length >= 30, '产品行');
  for (const r of products) {
    const where = r.method + ' ' + r.path;
    assert.ok(G.PRODUCTS.includes(r.product), where + ' product ' + r.product);
    const d = RA.derivedOf(r);
    for (const l of [d.level].concat(d.actions ? Object.values(d.actions) : []).filter(Boolean)) {
      if (l === 'public') continue;
      assert.ok(G.GROUPS.includes(l), where + ' 推出的组 ' + l + ' 不在 GROUPS 里');
    }
    if (r.kind === 'read') {
      assert.equal(r.level, 'public', where);
      assert.equal(r.actions.private, r.product + '-use', where + ' private = <产品>-use（v1.1 §七 A）');
      assert.equal(r.actions.manage, r.product + '-manage', where + ' manage = <产品>-manage');
    }
    if (r.kind === 'use') assert.equal(r.level, r.product + '-use', where);
    if (r.kind === 'manage') {
      assert.equal(r.level, r.product + '-manage', where);
      for (const [a, l] of Object.entries(r.actions || {})) assert.ok(l === 'root' || l === r.product + '-manage', where + ' ' + a + ' = ' + l + '（manage 行的 action 只能是本产品 manage 或 root）');
    }
    /* 带 product 的行，档里的组名只能是本产品的组 */
    for (const l of [r.level].concat(r.actions ? Object.values(r.actions) : [])) {
      if (['public', 'user', 'webmaster', 'root'].includes(l)) continue;
      assert.ok(l === r.product + '-use' || l === r.product + '-manage', where + ' ' + l);
    }
  }
  /* 表里出现的组名档（不论有没有 product）全在 GROUPS 里（旧名 listen / curio-write … 一条都不剩） */
  for (const r of RA.ROUTE_ACCESS) {
    for (const l of [r.level].concat(r.actions ? Object.values(r.actions) : [])) {
      if (['public', 'user', 'webmaster', 'root'].includes(l)) continue;
      assert.ok(G.GROUPS.includes(l), r.method + ' ' + r.path + ' ' + l);
    }
  }
  /* 唯一的覆盖：POST /api/ai 的 private = webmaster（AI 私密召回跨产品，v1.1 §六） */
  const over = RA.ROUTE_ACCESS.filter((r) => r.overrideWhy);
  assert.deepEqual(over.map((r) => r.method + ' ' + r.path), ['POST /api/ai']);
  assert.equal(RA.levelOf('POST', '/api/ai', { action: 'private' }), 'webmaster');
  assert.equal(RA.levelOf('GET', '/api/ai'), 'ai-use');
  assert.equal(RA.levelOf('GET', '/api/status'), 'status-use');
  /* 音乐（搬家第 1 步换档；第 4 步起只在 /music/api/*） */
  assert.equal(RA.levelOf('GET', '/music/api/music'), 'public');
  assert.equal(RA.levelOf('GET', '/music/api/music', { action: 'private' }), 'music-use');
  assert.equal(RA.levelOf('GET', '/music/api/music', { action: 'manage' }), 'music-manage');
  assert.equal(RA.levelOf('POST', '/music/api/music'), 'music-manage');
  assert.equal(RA.levelOf('POST', '/music/api/music-upload'), 'music-manage');
  for (const m of ['POST /music/api/music-play', 'GET /music/api/music-stream', 'HEAD /music/api/music-stream']) assert.equal(RA.levelOf(...m.split(' ')), 'music-use', m);
  assert.equal(RA.levelOf('GET', '/music/api/music-cover'), 'public');
  for (const a of ['album.del', 'artist.merge', 'artist.del']) assert.equal(RA.levelOf('POST', '/music/api/music', { action: a }), 'root', a + ' 仍是 root');
  assert.equal(RA.ruleOf('POST', '/music/api/music').sudoTicket, true, 'sudoTicket 不变');
});

test('music 搬家第 4 步：旧 /curio/api/music* 7 行删掉（不留别名），音乐只剩 /music/api/* 7 行；/music/api/ 下只有音乐', () => {
  assert.deepEqual(RA.ROUTE_ACCESS.filter((r) => r.path.startsWith('/curio/api/music')), [], '旧 7 行已删');
  for (const m of ['GET /curio/api/music', 'POST /curio/api/music', 'GET /curio/api/music-cover', 'POST /curio/api/music-play', 'GET /curio/api/music-stream', 'HEAD /curio/api/music-stream', 'POST /curio/api/music-upload']) {
    const [method, path] = m.split(' ');
    assert.equal(RA.ruleOf(method, path), null, m);
    assert.equal(RA.levelOf(method, path), null, m + '（不在表里 = admit 回 not-listed，atlas-core 一律 401）');
  }
  const NEW = '/music/api/music';
  const news = RA.ROUTE_ACCESS.filter((r) => r.path.startsWith(NEW));
  assert.deepEqual(news.map((r) => r.method + ' ' + r.path + ' ' + r.level), [
    'GET /music/api/music public', 'POST /music/api/music music-manage', 'GET /music/api/music-cover public', 'POST /music/api/music-play music-use',
    'GET /music/api/music-stream music-use', 'HEAD /music/api/music-stream music-use', 'POST /music/api/music-upload music-manage',
  ]);
  for (const r of news) assert.equal(r.product, 'music', r.path);
  assert.equal(RA.ruleOf('POST', NEW).sudoTicket, true);
  /* /music/api/ 下只有音乐：别的产品没有这个前缀的路径 */
  assert.deepEqual(RA.ROUTE_ACCESS.filter((r) => r.path.startsWith('/music/')).map((r) => r.path.split('/api/')[1].split('-')[0]).filter((x, i, a) => a.indexOf(x) === i), ['music']);
  assert.equal(RA.levelOf('GET', '/music/api/items'), null, '奇趣接口不能从 /music 前缀走');
  for (const a of ['album.del', 'artist.merge', 'artist.del']) assert.equal(RA.levelOf('POST', NEW, { action: a }), 'root', a);
  assert.equal(RA.levelOf('GET', NEW, { action: 'private' }), 'music-use');
  assert.equal(RA.levelOf('GET', NEW, { action: 'manage' }), 'music-manage');
  assert.equal(RA.levelOf('DELETE', '/daymark/api/quotes'), 'daymark-manage');
  assert.equal(RA.levelOf('DELETE', '/curio/api/photo'), 'curio-manage');
});

test('奇趣重组 PR 1：/games/api/* 5 行，product games 推出 games-use / games-manage；/games/api/ 下只有游戏；旧 /curio/api/items、photo 照常', () => {
  const rows = RA.ROUTE_ACCESS.filter((r) => r.path.startsWith('/games/'));
  assert.deepEqual(rows.map((r) => r.method + ' ' + r.path + ' ' + r.level), [
    'GET /games/api/games public', 'POST /games/api/games games-manage', 'GET /games/api/cover public', 'POST /games/api/cover games-manage', 'DELETE /games/api/cover games-manage',
  ]);
  for (const r of rows) {
    assert.equal(r.product, 'games', r.path);
    assert.equal(r.worker, 'atlas-core', r.path);
    assert.equal(r.sudoTicket, undefined, '没有 root 档，不发票');
  }
  for (const p of ['/games/api/games', '/games/api/cover']) {
    assert.equal(RA.levelOf('GET', p, { action: 'private' }), 'games-use', p);
    assert.equal(RA.levelOf('GET', p, { action: 'manage' }), 'games-manage', p);
  }
  assert.equal(RA.ruleOf('POST', '/games/api/games').del, 'item');
  assert.equal(RA.ruleOf('DELETE', '/games/api/cover').del, 'item');
  for (const p of ['/games/api/items', '/games/api/photo', '/games/api/links', '/games/api/music', '/games/api/export']) assert.equal(RA.levelOf('GET', p), null, p + '：别的产品不能从 /games 前缀走');
  assert.equal(RA.levelOf('GET', '/curio/api/items'), 'public', '旧路径照常（PR 3 再删）');
  assert.equal(RA.levelOf('POST', '/curio/api/items'), 'curio-manage');
  assert.equal(RA.levelOf('POST', '/curio/api/photo'), 'curio-manage');
});

test('product / kind 推导：写错就抛（表写错 Worker 起不来）', () => {
  assert.throws(() => RA.derivedOf({ product: 'nope', kind: 'read', method: 'GET', path: '/x' }), /bad product/);
  assert.throws(() => RA.derivedOf({ product: 'curio', kind: 'write', method: 'GET', path: '/x' }), /bad kind/);
  assert.throws(() => RA.derivedOf({ product: 'ai', kind: 'manage', method: 'POST', path: '/x' }), /no manage group/);
  assert.deepEqual(RA.derivedOf({ product: 'ai', kind: 'read' }), { level: 'public', actions: { private: 'ai-use' } }, '没有 manage 组的产品不推 manage');
  assert.deepEqual(RA.derivedOf({ product: 'curio' }), {}, '只写 product 不写 kind：不推导');
  assert.deepEqual(RA.derivedOf({}), {});
});
