/**
 * atlas-core 公用 visibility（workers/atlas-core/src/common/visibility.js，组权限重设计 v1.1 §八）：
 * - visibility(context)：产品取 context.data.route（命中的本 Worker 路由行）的 product，分别问 action private / manage，回 { showPrivate, canManage }；
 *   没有命中行 / 行上没有 product / 没有 ask → 两样都 false（fail closed）；ask 抛错 → 两样都 false
 * - 两份 _auth.js 里的 readAccess 已删；奇趣 / 日刻 / 音乐的公开读接口都只经 visibility 判
 * - filterPrivate：约定列 private；没有这一列 = 整表公开；isPrivate 给日刻句子（visibility 列）用
 * - privateNotFound：附件看不到 = 404（同不存在），公开条目不问 v6
 * - 两张 atlas-core 路由表每一行都有 product，且与账号 Worker 路由表同一条路由的 product 一致
 * 运行：node --test tests/workers/atlas-core/visibility.test.mjs
 */
import '../account/_cf-workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = REPO + '/workers/atlas-core/src/';
const V = await import(SRC + 'common/visibility.js');
const CR = await import(SRC + 'curio/routes.js');
const DR = await import(SRC + 'daymark/routes.js');
const MR = await import(SRC + 'music/routes.js');
const GR = await import(SRC + 'games/routes.js');
const RA = await import(REPO + '/workers/account/src/core/route-access.js');

const ctxOf = (route, answers, log = []) => ({
  data: { route, ask: async (_c, action) => { log.push(action); if (answers === 'throw') throw new Error('down'); return { allowed: !!answers[action] }; } },
});

test('visibility：private、manage 两档分开问；结果原样分开（use 不给 canManage）', async () => {
  const log = [];
  assert.deepEqual(await V.visibility(ctxOf({ product: 'curio' }, { private: true, manage: false }, log)), { showPrivate: true, canManage: false });
  assert.deepEqual(log.sort(), ['manage', 'private']);
  assert.deepEqual(await V.visibility(ctxOf({ product: 'music' }, { private: true, manage: true })), { showPrivate: true, canManage: true });
  assert.deepEqual(await V.visibility(ctxOf({ product: 'daymark' }, {})), { showPrivate: false, canManage: false });
});

test('visibility：fail closed——没有命中行、行上没有 product、没有 ask、ask 抛错，都两样 false，且不问', async () => {
  const log = [];
  assert.deepEqual(await V.visibility(ctxOf(null, { private: true, manage: true }, log)), V.NO_VISIBILITY);
  assert.deepEqual(await V.visibility(ctxOf({ product: '' }, { private: true, manage: true }, log)), V.NO_VISIBILITY);
  assert.deepEqual(log, [], '没有产品不问');
  assert.deepEqual(await V.visibility({ data: { route: { product: 'curio' } } }), V.NO_VISIBILITY);
  assert.deepEqual(await V.visibility({}), V.NO_VISIBILITY);
  assert.deepEqual(await V.visibility(null), V.NO_VISIBILITY);
  assert.deepEqual(await V.visibility(ctxOf({ product: 'curio' }, 'throw')), V.NO_VISIBILITY);
  assert.equal(await V.canSeePrivate(ctxOf({ product: 'curio' }, 'throw')), false);
});

test('filterPrivate：约定列 private；showPrivate 原样（拷贝）；isPrivate 自定', () => {
  const rows = [{ id: 1, private: 0 }, { id: 2, private: 1 }, { id: 3 }, { id: 4, private: true }];
  assert.deepEqual(V.filterPrivate(rows, false).map((r) => r.id), [1, 3]);
  const all = V.filterPrivate(rows, true);
  assert.deepEqual(all.map((r) => r.id), [1, 2, 3, 4]);
  assert.notEqual(all, rows, '拷贝，不改原数组');
  assert.deepEqual(V.filterPrivate([{ v: 'public' }, { v: 'private' }], false, (r) => r.v !== 'public'), [{ v: 'public' }]);
  assert.deepEqual(V.filterPrivate(null, false), []);
});

test('privateNotFound：公开条目不问；私密且看不到 → 404 not-found；看得到 → null', async () => {
  const log = [];
  assert.equal(await V.privateNotFound(ctxOf({ product: 'curio' }, {}, log), false), null);
  assert.deepEqual(log, [], '公开的不问');
  const r = await V.privateNotFound(ctxOf({ product: 'curio' }, { private: false }, log), true);
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { ok: false, error: 'not-found' });
  assert.deepEqual(log, ['private'], '附件只问 private 一档');
  assert.equal(await V.privateNotFound(ctxOf({ product: 'curio' }, { private: true }), true), null);
  assert.equal((await V.privateNotFound({}, true)).status, 404, '没有产品 = 看不到');
});

test('两份 _auth.js 的 readAccess 已删，公开读接口都只调 common/visibility.js；atlas-core 不写组名', () => {
  for (const p of ['curio/api/_auth.js', 'daymark/api/_auth.js']) assert.doesNotMatch(readFileSync(SRC + p, 'utf8'), /readAccess/, p);
  for (const p of ['curio/api/items.js', 'curio/api/links.js', 'curio/api/movies.js', 'music/api/music.js', 'daymark/api/quotes.js', 'daymark/api/collections.js', 'games/api/games.js']) {
    assert.match(readFileSync(SRC + p, 'utf8'), /import \{[^}]*\bvisibility\b[^}]*\} from '\.\.\/\.\.\/common\/visibility\.js'/, p);
  }
  for (const p of ['curio/api/_photo.js', 'curio/api/icon.js']) assert.match(readFileSync(SRC + p, 'utf8'), /privateNotFound/, p);
  /* 组名只在账号 Worker（permits 唯一判断）；atlas-core 代码（去掉注释）不出现任何组名 */
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const G = /'(?:[a-z]+-(?:use|manage)|wheel|sudoers|listen|curio-write|daymark-write)'/;
  for (const p of ['common/visibility.js', 'curio/api/_auth.js', 'daymark/api/_auth.js', 'curio/app.js', 'daymark/index.js', 'curio/routes.js', 'daymark/routes.js', 'music/routes.js', 'games/routes.js', 'games/api/games.js', 'games/api/cover.js', 'curio/api/_photo.js', 'curio/api/_items-post.js']) {
    assert.doesNotMatch(strip(readFileSync(SRC + p, 'utf8')), G, p);
  }
});

test('atlas-core 路由表每一行都有 product，与账号 Worker 路由表同一条路由的 product 一致（音乐搬家第 4 步：音乐只在 /music/api/*，product 是 music；奇趣表只有 curio）', () => {
  for (const [base, R] of [['/curio', CR], ['/daymark', DR], ['/music', MR], ['/games', GR]]) {
    for (const r of R.ROUTE_ACCESS) {
      assert.ok(typeof r.product === 'string' && r.product, base + r.path);
      const acc = RA.ruleOf(r.method, base + r.path);
      assert.ok(acc, '账号路由表有 ' + r.method + ' ' + base + r.path);
      assert.equal(acc.product, r.product, r.method + ' ' + base + r.path);
      assert.equal(R.routeOf(r.method, r.path + '/'), R.routeOf(r.method, r.path), '结尾 / 同一条');
    }
    assert.equal(R.routeOf('GET', '/api/nope'), null);
  }
  assert.ok(MR.ROUTE_ACCESS.length === 7 && MR.ROUTE_ACCESS.every((r) => r.product === 'music'));
  assert.ok(CR.ROUTE_ACCESS.every((r) => r.product === 'curio'), '奇趣表里没有音乐的行了');
  assert.ok(GR.ROUTE_ACCESS.length === 5 && GR.ROUTE_ACCESS.every((r) => r.product === 'games'), '奇趣重组 PR 1：游戏表只有 games');
});
