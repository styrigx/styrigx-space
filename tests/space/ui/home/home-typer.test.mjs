/**
 * 主页 hero（Gray 2026-11-09 17:45–17:49）：
 * - $ 行标语打字轮播（apps/home-typer.js typerStep 纯函数）：逐字打 → 停顿 → 逐字删 → 空白 → 再打
 * - 模板：标语取 hugo.yaml params.tagline、中英同一句英文（translate="no"）、动的那份 aria-hidden + sr-only 全文、光标 .home-cur；
 *   # 行 = 个人资料签名 motto（data-sgx-profile="motto"，首帧 profile.yaml 默认值，不写死、不走字符串表）
 * - 字符串表不再有 home.role / home.intro；JS 不内联（CSP 哈希门），走资产模块
 * 运行：node --test tests/space/ui/home/home-typer.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const { typerStep, TYPER_MS } = await import('../../../../space/web/assets/shell/js/apps/home-typer.js');
const rd = (/** @type {string} */ f) => readFileSync(path.join(REPO, f), 'utf8');

test('typerStep：从整句停顿开始，删到空 → 空白 → 打满 → 停顿，一整圈回到起点', () => {
  const len = 5;
  /** @type {any} */
  let s = { i: len, phase: 'hold' };
  const seen = [];
  for (let k = 0; k < 2 * len + 2; k++) {
    const r = typerStep(s, len);
    seen.push([r.state.i, r.state.phase, r.wait]);
    s = r.state;
  }
  assert.deepEqual(seen[0], [len, 'del', TYPER_MS.del], 'hold → del，整句不动');
  assert.deepEqual(seen.slice(1, 1 + len).map((x) => x[0]), [4, 3, 2, 1, 0], '逐字删');
  assert.deepEqual(seen[len], [0, 'gap', TYPER_MS.gap], '删空后空白');
  assert.deepEqual(seen[len + 1], [0, 'type', TYPER_MS.type]);
  assert.deepEqual(seen.slice(len + 2, 2 * len + 2).map((x) => x[0]), [1, 2, 3, 4, 5], '逐字打');
  assert.deepEqual(seen[2 * len + 1], [len, 'hold', TYPER_MS.hold], '打满停顿');
  assert.deepEqual(s, { i: len, phase: 'hold' }, '回到起点');
});

test('typerStep：越界 / 空串 / 自定义节奏', () => {
  assert.deepEqual(typerStep({ i: 99, phase: 'type' }, 3).state, { i: 3, phase: 'hold' });
  assert.deepEqual(typerStep({ i: -2, phase: 'del' }, 3).state, { i: 0, phase: 'gap' });
  assert.deepEqual(typerStep({ i: 0, phase: 'type' }, 0), { state: { i: 0, phase: 'hold' }, wait: TYPER_MS.hold });
  const ms = { type: 1, del: 2, hold: 3, gap: 4 };
  assert.equal(typerStep({ i: 0, phase: 'type' }, 3, ms).wait, 1);
  assert.equal(typerStep({ i: 3, phase: 'hold' }, 3, ms).wait, 2);
  assert.equal(typerStep({ i: 1, phase: 'del' }, 3, ms).wait, 4);
});

test('模板：$ 行标语轮播 + # 行个人资料签名（不写死），JS 走资产模块', () => {
  const t = rd('space/web/layouts/index.html');
  assert.match(t, /\$tagline := site\.Params\.tagline/);
  assert.match(t, /<p class="home-role" translate="no">[\s\S]*?<span class="sr-only">\{\{ \$tagline \}\}<\/span><span class="home-typer" aria-hidden="true" data-home-typer="\{\{ \$tagline \}\}">\{\{ \$tagline \}\}<\/span><span class="home-cur" aria-hidden="true"><\/span><\/p>/);
  assert.match(t, /<span class="home-motto" translate="no" data-sgx-personal data-sgx-profile="motto">\{\{ \$profile\.motto \}\}<\/span>/);
  assert.match(t, /data-home-motto-line\{\{ if not \$profile\.motto \}\} hidden\{\{ end \}\}/, '空签名首帧就藏行');
  assert.doesNotMatch(t, /\$h\.(role|intro)\b/);
  assert.equal(rd('space/web/hugo.yaml').match(/^\s+tagline: '(.*)'$/m)?.[1], 'A Personal Digital Space');
  const idx = rd('space/web/assets/shell/js/apps/index.js');
  assert.match(idx, /import \{ mountTyper \} from '\.\/home-typer\.js'/);
  assert.match(idx, /addEventListener\(PROFILE_EVENT, syncMotto\)/);
});

test('字符串表：home.role / home.intro 已删（中英都没有）', () => {
  for (const l of ['zh', 'en']) {
    const y = rd(`space/web/data/shell/i18n/${l}.yaml`);
    const home = y.slice(y.indexOf('\nhome:'), y.indexOf('\n', y.indexOf('\nhome:') + 1) + 400);
    assert.doesNotMatch(home, /^\s{2}(role|intro):/m, l);
  }
});

const built = existsSync(path.join(REPO, 'space/web/public/index.html'));
test('构建产物：/ 与 /zh/ 的 hero 标语和签名一字不差；签名 = profile.yaml 默认值', { skip: !built && '没构建' }, () => {
  const hero = (/** @type {string} */ f) => {
    const h = rd(f);
    return [h.match(/<p class="home-role"[\s\S]*?<\/p>/)?.[0], h.match(/<p class="home-intro"[\s\S]*?<\/p>/)?.[0]];
  };
  const en = hero('space/web/public/index.html');
  const zh = hero('space/web/public/zh/index.html');
  assert.ok(en[0] && en[1]);
  assert.deepEqual(zh, en);
  assert.match(en[0], />A Personal Digital Space<\/span><span class="home-cur"/);
  const motto = (rd('space/web/data/shell/profile.yaml').match(/^motto: (.*)$/m) || [])[1] || '';
  assert.ok(motto && en[1].includes(motto.replace(/'/g, '&#39;')), '签名首帧 = profile.yaml');
});
